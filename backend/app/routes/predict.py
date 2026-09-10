"""
Prediction endpoints for Fleet AI ML service.

POST /predict            — full ensemble prediction for a vehicle
GET  /model/status       — per-vehicle model readiness
GET  /baselines/{key}    — fetch a stored MlBaselineProfile
"""
from __future__ import annotations
import json
import asyncio
import logging
import time
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..db import pg as pg_db
from ..ml.features import coalesce_samples, extract_features, metric_value, METRIC_KEYS
from ..ml.engine_state import classify_engine_event, select_engine_running_samples
from ..ml.dtc import analyze_dtcs
from ..ml.diagnosis import run_diagnosis
from ..ml.fleet import compute_fleet_normalization, fleet_risk_boost
from ..ml.isolation_forest import VehicleIsolationForest
from ..ml.ensemble import compute_ensemble, get_class_threshold
from ..ml.pretrained import is_pretrained_loaded, score_pretrained, pretrained_evidence
from ..ml.feature_contract import manifest, PHYSICS_VERSION, json_safe
from ..ml.stage2 import STAGE1_THRESHOLD, get_stage2_meta, score_stage2
from ..ml.stage3 import STAGE3_HIGH, STAGE3_LOW, evaluate_stage3, get_stage3_buffer_stats
from ..ml.stack import (
    build_stack_features, get_stack_meta, stack_maybe_retrain, stack_score,
)
from ..ml.conformal import conformal_predict, get_conformal_meta, is_conformal_fitted
from ..ml.active_learning import al_maybe_enqueue, al_peek, get_al_meta

logger = logging.getLogger(__name__)
router = APIRouter()

# ── Request / Response models ─────────────────────────────────────────────────

class PredictRequest(BaseModel):
    vehicleId: str = Field(..., min_length=1)
    orgId: Optional[str] = None
    samples: list[dict] = Field(default_factory=list)
    dtcCodes: list[str] = Field(default_factory=list)
    vehicleMeta: Optional[dict] = None


class ModelStatusRequest(BaseModel):
    vehicleId: str


# ── Welford in-memory state ───────────────────────────────────────────────────
# Keyed by vehicleId → {metric_key: {count, mean, M2}}
_welford_state: dict[str, dict[str, dict]] = {}
_welford_last_event_ts: dict[str, str] = {}

# In-memory IF cache keyed by vehicleId
_if_cache: dict[str, VehicleIsolationForest] = {}
_prediction_locks = {}
_pending_review_writes = set()


def _dedupe_samples(samples: list[dict]) -> list[dict]:
    """Coalesce burst uploads into one five-second physical observation."""
    return coalesce_samples(samples, bucket_seconds=5)


def _welford_update(state: dict, value: float) -> dict:
    """Single Welford step for a running mean/variance."""
    count = state.get("count", 0) + 1
    mean = state.get("mean", 0.0)
    M2 = state.get("M2", 0.0)
    delta = value - mean
    mean += delta / count
    delta2 = value - mean
    M2 += delta * delta2
    return {"count": count, "mean": mean, "M2": M2}


def _welford_zscore(state: dict, value: float) -> Optional[float]:
    count = state.get("count", 0)
    if count < 5:
        return None
    std = (state["M2"] / max(count - 1, 1)) ** 0.5
    if std < 1e-9:
        return 0.0
    return (value - state["mean"]) / std


def _get_welford_state(vehicle_id: str, org_id: str) -> dict[str, dict]:
    return _welford_state.setdefault((org_id, vehicle_id), {})


async def _load_welford_from_db(vehicle_id: str, org_id: str) -> None:
    """Restore Welford state from persisted ModelState if not in memory."""
    if (org_id, vehicle_id) in _welford_state:
        return
    state = await pg_db.get_model_state(vehicle_id, org_id)
    if state and "welford" in state:
        _welford_state[(org_id, vehicle_id)] = state["welford"]
        last_event_ts = state.get("last_running_sample_ts")
        if last_event_ts:
            _welford_last_event_ts[(org_id, vehicle_id)] = str(last_event_ts)


async def _persist_state(vehicle_id: str, org_id: Optional[str], vif: VehicleIsolationForest, *, persist_welford: bool = True) -> None:
    """Save IF model + Welford state to PostgreSQL."""
    welford = _welford_state.get((org_id, vehicle_id), {})
    patch = {
        "isolation_forest": vif.to_state_dict(),
        "updated_at": time.time(),
    }
    if persist_welford:
        patch.update(welford=welford, last_running_sample_ts=_welford_last_event_ts.get((org_id, vehicle_id)))
    await pg_db.upsert_model_state(vehicle_id, org_id, patch)


async def _reconcile_learning(vehicle_id: str, org_id: str) -> dict:
    if not pg_db.is_available():
        return {"mode": "transient_request_history", "durable": False}
    try:
        reconciled = await pg_db.reconcile_vehicle_learning(vehicle_id, org_id)
        _welford_state[(org_id, vehicle_id)] = reconciled["welford"]
        return {"mode": "durable_observation_ledger", "durable": True, **reconciled["checkpoint"]}
    except Exception as exc:
        # Do not mutate legacy state after a migration/DB failure. Other ensemble
        # signals remain available and the missing learning evidence is explicit.
        logger.warning("[predict] durable learning unavailable (%s)", type(exc).__name__)
        return {"mode": "learning_paused", "durable": False, "reason": "database_or_learning_migration_unavailable"}


def _sample_event_seconds(sample: dict) -> Optional[float]:
    raw = sample.get("ts") or sample.get("timestamp")
    if not raw:
        return None
    try:
        from datetime import datetime, timezone
        parsed = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.timestamp()
    except (TypeError, ValueError):
        return None


async def _get_or_load_vif(vehicle_id: str, org_id: Optional[str]) -> VehicleIsolationForest:
    """Return in-memory IF, loading from DB if missing."""
    if (org_id, vehicle_id) not in _if_cache:
        state = await pg_db.get_model_state(vehicle_id, org_id)
        if state and "isolation_forest" in state:
            vif = VehicleIsolationForest.from_state_dict(state["isolation_forest"])
        else:
            vif = VehicleIsolationForest()
        _if_cache[(org_id, vehicle_id)] = vif
    return _if_cache[(org_id, vehicle_id)]


# ── Baseline persistence helpers ──────────────────────────────────────────────

async def _persist_baselines(
    vehicle_id: str,
    org_id: Optional[str],
    window_stats: dict,
    samples: list[dict],
) -> None:
    """Persist actual trailing-14-day observations; lifetime state stays separate."""
    latest = max((_sample_event_seconds(s) or 0 for s in samples), default=0)
    recent = [s for s in samples if latest - 14 * 86400 <= (_sample_event_seconds(s) or 0) <= latest]
    for metric_key in METRIC_KEYS:
        sample_values = [metric_value(sample, metric_key) for sample in recent]
        sample_values = [value for value in sample_values if value is not None]
        if len(sample_values) < 2:
            continue
        count = len(sample_values)
        mean = sum(sample_values) / count
        M2 = sum((v - mean) ** 2 for v in sample_values)
        await pg_db.upsert_baseline(
            vehicle_id=vehicle_id,
            org_id=org_id,
            metric_key=metric_key,
            window_days=14,
            count=count,
            mean=mean,
            m2=M2,
            min_val=min(sample_values),
            max_val=max(sample_values),
            samples_list=sample_values,
        )


# ── POST /predict ─────────────────────────────────────────────────────────────

@router.post("/predict")
async def predict(req: PredictRequest) -> dict:
    if not req.orgId:
        raise HTTPException(status_code=422, detail="orgId is required")
    key = (req.orgId, req.vehicleId)
    lock = _prediction_locks.setdefault(key, asyncio.Lock())
    async with lock:
        return await _predict_scoped(req)


async def _predict_scoped(req: PredictRequest) -> dict:
    """
    Full ML pipeline for a vehicle:
      1. Pull historical samples from DB (supplement request samples)
      2. Feature extraction
      3. Welford z-scores updated with latest metric values
      4. Isolation Forest (train if needed)
      5. DTC fault-tree analysis
      6. Cross-fleet normalization
      7. Ensemble scoring
      8. Persist state + baselines
    """
    t0 = time.monotonic()
    vehicle_id = req.vehicleId
    org_id = req.orgId
    if not org_id:
        raise HTTPException(status_code=422, detail="orgId is required")
    if any(s.get("orgId", org_id) != org_id or s.get("vehicleId", vehicle_id) != vehicle_id for s in req.samples):
        raise HTTPException(status_code=422, detail="Sample ownership does not match prediction scope")

    # ── 1. Gather samples ─────────────────────────────────────────────────────
    db_samples = await pg_db.get_recent_samples(vehicle_id, org_id, limit=5000)
    # Merge: request samples take precedence (they may be fresher)
    request_samples = [{**s, "vehicleId": vehicle_id, "orgId": org_id} for s in req.samples]
    all_samples = _dedupe_samples(db_samples + request_samples)
    engine_event = classify_engine_event(all_samples)
    analysis_samples = select_engine_running_samples(all_samples)
    excluded_engine_off_samples = max(0, len(all_samples) - len(analysis_samples))
    learning_history = await _reconcile_learning(vehicle_id, org_id)
    database_learning = learning_history["mode"] != "transient_request_history"
    if not all_samples:
        return {
            "vehicleId": vehicle_id,
            "available": False,
            "reason": "no_telemetry",
            "riskProbability": 0.0,
            "prediction": "insufficient_data",
            "confidence": 0.0,
            "engineEvent": engine_event,
            "learningHistory": learning_history,
        }
    if not analysis_samples:
        return {
            "vehicleId": vehicle_id,
            "available": False,
            "reason": "no_engine_running_telemetry",
            "riskProbability": 0.0,
            "prediction": "insufficient_data",
            "confidence": 0.0,
            "engineEvent": engine_event,
            "learningHistory": learning_history,
            "dataQuality": {
                "observedSamples": len(all_samples),
                "engineRunningSamples": 0,
                "excludedEngineOffSamples": excluded_engine_off_samples,
            },
        }

    # ── 2. Feature extraction ─────────────────────────────────────────────────
    from datetime import datetime, timezone
    latest_event = max((_sample_event_seconds(s) or 0 for s in analysis_samples), default=0)
    lag_samples = await pg_db.get_lag_samples(vehicle_id, org_id, datetime.fromtimestamp(latest_event, tz=timezone.utc)) if latest_event else []
    lag_samples = select_engine_running_samples(lag_samples)
    features = extract_features(analysis_samples, vehicle_meta=req.vehicleMeta, lag_samples=lag_samples)
    if not features.get("available"):
        return {
            "vehicleId": vehicle_id,
            "available": False,
            "reason": "feature_extraction_failed",
            "riskProbability": 0.0,
            "prediction": "insufficient_data",
            "confidence": 0.0,
            "engineEvent": engine_event,
        }

    flat = features["flat"]
    window_stats = features["window_stats"]
    current_metrics = features["current_metrics"]
    mv_stress = features.get("multivariate_stress", {})

    # ── 3. Welford update ─────────────────────────────────────────────────────
    await _load_welford_from_db(vehicle_id, org_id)
    w_state = _get_welford_state(vehicle_id, org_id)
    welford_zscores: dict[str, float] = {}

    previous_event_seconds = None
    if _welford_last_event_ts.get((org_id, vehicle_id)):
        previous_event_seconds = _sample_event_seconds({"ts": _welford_last_event_ts[(org_id, vehicle_id)]})
    ordered_analysis = sorted(
        analysis_samples,
        key=lambda sample: _sample_event_seconds(sample) or 0.0,
    )
    if database_learning:
        unseen_samples = []  # The transaction owns durable Welford updates.
    elif w_state and previous_event_seconds is None:
        # Older persisted states predate the event-time cursor. Do not replay
        # the entire history into an already-populated baseline during rollout.
        unseen_samples = ordered_analysis[-1:]
    else:
        unseen_samples = [
            sample for sample in ordered_analysis
            if _sample_event_seconds(sample) is not None
            and (previous_event_seconds is None or _sample_event_seconds(sample) > previous_event_seconds)
        ]

    for telemetry_sample in unseen_samples:
        for metric_key in METRIC_KEYS:
            val = metric_value(telemetry_sample, metric_key)
            if val is None:
                continue
            ms = w_state.setdefault(metric_key, {"count": 0, "mean": 0.0, "M2": 0.0})
            z = _welford_zscore(ms, val)
            w_state[metric_key] = _welford_update(ms, val)
            if z is not None:
                welford_zscores[metric_key] = round(z, 3)

    if unseen_samples:
        latest_event_ts = unseen_samples[-1].get("ts") or unseen_samples[-1].get("timestamp")
        if latest_event_ts:
            _welford_last_event_ts[(org_id, vehicle_id)] = str(latest_event_ts)
    else:
        for metric_key in METRIC_KEYS:
            val = current_metrics.get(metric_key)
            ms = w_state.get(metric_key)
            if val is None or not ms:
                continue
            z = _welford_zscore(ms, val)
            if z is not None:
                welford_zscores[metric_key] = round(z, 3)

    welford_count = min(ws.get("count", 0) for ws in w_state.values()) if w_state else 0
    if learning_history["mode"] == "learning_paused" or (
        learning_history.get("backfillPending") and not learning_history.get("lastFullScanCompletedAt")
    ):
        # An initial partial backfill is not a representative vehicle baseline.
        welford_zscores = {}
        welford_count = 0

    # ── 4. Isolation Forest ───────────────────────────────────────────────────
    vif = await _get_or_load_vif(vehicle_id, org_id)

    if vif.needs_retraining() and features["sample_count"] >= 50:
        # Build flat dicts for all samples to use as training rows
        # We train on a sliding window of the most recent 2000 samples
        train_samples = analysis_samples[-2000:]
        from ..ml.features import extract_features as ef
        # Build individual flat dicts per sample for IF training
        # Use rolling windows of 20 samples each to get distributions
        train_flats: list[dict] = []
        step = max(1, len(train_samples) // 200)
        for i in range(0, len(train_samples) - 20, step):
            chunk = train_samples[i: i + 20]
            chunk_feat = ef(chunk, vehicle_meta=req.vehicleMeta)
            if chunk_feat.get("available"):
                train_flats.append(chunk_feat["flat"])

        if len(train_flats) >= 50:
            vif.fit(train_flats)
            _if_cache[(org_id, vehicle_id)] = vif

    if_score = vif.score(flat)

    # ── 5. DTC analysis + component diagnosis ────────────────────────────────
    dtc_analysis = analyze_dtcs(req.dtcCodes) if req.dtcCodes else None
    diagnosis = run_diagnosis(
        current_metrics={k: v for k, v in current_metrics.items() if v is not None},
        dtc_codes=req.dtcCodes,
        window_stats=window_stats,
        multivariate_stress=mv_stress,
    )

    # ── 6. Fleet normalization ────────────────────────────────────────────────
    fleet_norm = await compute_fleet_normalization(vehicle_id, window_stats, org_id, (req.vehicleMeta or {}).get("vehicleClass"))
    f_boost = fleet_risk_boost(fleet_norm)

    # ── 7. Pretrained prior score (5th ensemble signal) ───────────────────────
    pretrained_score = score_pretrained(
        current_metrics={k: v for k, v in current_metrics.items() if v is not None},
        window_stats=window_stats,
        vehicle_meta=req.vehicleMeta,
        flat_features=flat,
    )

    # ── 8. Ensemble ───────────────────────────────────────────────────────────
    vehicle_class = str(
        (req.vehicleMeta or {}).get("vehicleClass") or
        (req.vehicleMeta or {}).get("vehicle_class") or ""
    ).lower()

    result = compute_ensemble(
        if_score=if_score,
        welford_zscores=welford_zscores,
        current_metrics={k: v for k, v in current_metrics.items() if v is not None},
        dtc_analysis=dtc_analysis,
        fleet_norm=fleet_norm,
        fleet_boost=f_boost,
        sample_count=features["sample_count"],
        if_trained=vif.is_trained(),
        welford_count=welford_count,
        multivariate_stress=mv_stress,
        pretrained_score=pretrained_score,
        vehicle_class=vehicle_class,
    )

    # ── 8.5. Stage 2 confirmatory classifier ─────────────────────────────────
    stage1_score = result.get("riskProbability", 0.0)
    stage_system: Optional[dict] = None
    stage2_score: Optional[float] = None
    stage2_conformal = None
    # Use per-class threshold so lighter vehicles aren't silenced by the
    # Phase 1B multiplier compressing their scores below the heavy-duty cutoff.
    effective_threshold = get_class_threshold(vehicle_class) if vehicle_class else STAGE1_THRESHOLD
    if stage1_score >= effective_threshold:
        pretrained_decayed = float(
            max(0.0, min(1.0, (features["sample_count"] - 50) / 450))
            if features["sample_count"] > 50 else 0.0
        )
        vehicle_context = {
            "orgId": org_id,
            "currentMetrics": {k: v for k, v in current_metrics.items() if v is not None},
            "fleetNormalization": fleet_norm,
            "multivariateStress": mv_stress,
            "vehicleMeta": req.vehicleMeta,
            "sampleCount": features["sample_count"],
            "welfordCount": welford_count,
            "pretrainedDecayed": pretrained_decayed,
            "dtcAnalysis": dtc_analysis,
            "diagnosis": diagnosis,
        }
        s2 = score_stage2(result, vehicle_context)
        if s2 is not None:
            stage2_score = s2["stage2_probability"]
            stage2_conformal = s2.get("conformal")
            stage_system = {
                "stage1Score": round(stage1_score, 4),
                "stage2Score": round(stage2_score, 4),
                "signalAgreement": round(s2["signal_agreement"], 4),
                "confirmed": s2["confirmed"],
                "confirmationReason": s2["confirmation_reason"],
                "stage1Threshold": effective_threshold,
                "calibration": s2.get("calibration"),
                "missingFeatures": s2.get("missingFeatures", []),
            }

    # ── 8.6. Stage 3 Arbitrator (borderline zone only) ───────────────────────
    if stage2_score is not None and STAGE3_LOW <= stage2_score <= STAGE3_HIGH:
        clean_metrics = {k: v for k, v in current_metrics.items() if v is not None}
        temporal_input = dict(
            timestamp=latest_event or None,
            stage2_score=stage2_score,
            current_metrics=clean_metrics,
            window_stats=window_stats,
        )
        temporal_persistence = "memory_only"
        if pg_db.is_available():
            try:
                s3 = await pg_db.evaluate_temporal_history(vehicle_id, org_id, **temporal_input)
                temporal_persistence = "database"
            except Exception as exc:
                logger.warning("[predict] temporal persistence unavailable (%s)", type(exc).__name__)
                s3 = None
                temporal_persistence = "unavailable"
        else:
            s3 = evaluate_stage3(vehicle_id=json.dumps([org_id, vehicle_id]), **temporal_input)
        if stage_system is not None:
            stage_system["temporalPersistence"] = temporal_persistence
        if s3 is not None and stage_system is not None:
            stage_system["stage3"] = {
                "verdict": s3["verdict"],
                "reason": s3["reason"],
                "convergingSignals": s3["convergingSignals"],
                "weightedConvergence": s3["weightedConvergence"],
                "projections": s3["projections"],
                "derivatives": s3["derivatives"],
            }
            # Promote riskProbability if Stage 3 CONFIRMs
            if s3["verdict"] == "CONFIRM":
                result["riskProbability"] = max(result.get("riskProbability", 0.0), 0.75)
                result["prediction"] = "BREAKDOWN_IMMINENT"

    # ── 8.7. Phase 4A — stacking meta-learner (advisory) ─────────────────────
    s3_result_for_stack = stage_system.get("stage3") if stage_system else None
    s2_result_for_stack = None
    if stage_system and "stage2Score" in stage_system:
        s2_result_for_stack = {
            "stage2_probability": stage_system["stage2Score"],
            "signal_agreement": stage_system.get("signalAgreement", 0.5),
        }
    stack_features = build_stack_features(
        ensemble_result=result,
        stage2_result=s2_result_for_stack,
        stage3_result=s3_result_for_stack,
        fleet_norm=fleet_norm,
        vehicle_class=vehicle_class,
    )
    meta_score = stack_score(stack_features)
    # Global feedback must not silently retrain or activate a cross-tenant model.

    # ── 8.8. Phase 5 — conformal prediction (coverage guarantee) ─────────────
    conformal_result = stage2_conformal

    # ── 8.9. Phase 6 — active learning queue (uncertainty sampling) ───────────
    s3_verdict_str = ""
    if stage_system and "stage3" in stage_system:
        s3_verdict_str = stage_system["stage3"].get("verdict", "")
    review_enqueued = al_maybe_enqueue(
        vehicle_id=vehicle_id,
        org_id=org_id or "",
        risk_probability=result.get("riskProbability", 0.0),
        stage2_score=stage2_score,
        stage3_verdict=s3_verdict_str,
        prediction=result.get("prediction", ""),
        stack_features=stack_features,
    )
    review_persistence = "memory_only"
    if pg_db.is_available():
        review_persistence = "database"
        if review_enqueued or (org_id, vehicle_id) in _pending_review_writes:
            try:
                await pg_db.persist_review_candidate(vehicle_id, org_id, al_peek(vehicle_id, org_id))
                _pending_review_writes.discard((org_id, vehicle_id))
            except Exception as exc:
                logger.warning("[predict] review persistence unavailable (%s)", type(exc).__name__)
                _pending_review_writes.add((org_id, vehicle_id))
                review_persistence = "unavailable"

    # ── 9. Persist ────────────────────────────────────────────────────────────
    try:
        await _persist_baselines(vehicle_id, org_id, window_stats, analysis_samples)
        await _persist_state(vehicle_id, org_id, vif, persist_welford=not database_learning)
    except Exception as exc:
        logger.debug(f"[predict] persist error for {vehicle_id}: {exc}")

    elapsed_ms = round((time.monotonic() - t0) * 1000, 1)

    return json_safe({
        "vehicleId": vehicle_id,
        "orgId": org_id,
        "available": True,
        **result,
        "dtcAnalysis": dtc_analysis,
        "diagnosis": diagnosis,
        "fleetNormalization": fleet_norm,
        "currentMetrics": current_metrics,
        "engineEvent": engine_event,
        "dataQuality": {
            "observedSamples": len(all_samples),
            "engineRunningSamples": len(analysis_samples),
            "excludedEngineOffSamples": excluded_engine_off_samples,
            "learningHistory": learning_history,
        },
        "features": {
            "sampleCount": features["sample_count"],
            "dutyCycle": features["duty_cycle"],
            "sampleDensity": features["sample_density"],
            "multivariateStress": mv_stress,
        },
        "lineage": json_safe({
            "version": 1, "featureSchema": manifest(), "physicsVersion": PHYSICS_VERSION,
            "pretrained": pretrained_evidence(current_metrics, window_stats, req.vehicleMeta, flat),
            "stage1": {"riskProbability": stage1_score, "components": result.get("components"), "weights": result.get("weights")},
            "stage2": {"result": stage_system, "artifact": get_stage2_meta(org_id)},
            "stage3": (stage_system or {}).get("stage3"),
            "learning": {"welfordCount": welford_count, "history": learning_history,
                         "lastEvent": _welford_last_event_ts.get((org_id, vehicle_id)) if not database_learning else None,
                         "ifTrainedAt": vif._trained_at},
            "dtcEvidence": dtc_analysis, "engineEvent": engine_event,
            "calibration": {"ensemble": "uncalibrated", "conformal": conformal_result},
        }),
        "stageSystem": stage_system,
        "metaScore": meta_score,
        "conformal": conformal_result,
        "modelStatus": {
            "ifTrained": vif.is_trained(),
            "ifAgeHours": vif.age_hours(),
            "welfordCount": welford_count,
            "pretrainedLoaded": pretrained_score is not None,
            **get_stage2_meta(org_id),
            "stage3": get_stage3_buffer_stats(org_id),
            "stackMeta": get_stack_meta(),
            "conformal": get_conformal_meta(),
            "activeLearning": {**get_al_meta(org_id), "persistence": review_persistence},
        },
        "latencyMs": elapsed_ms,
    })


# ── GET /model/status ─────────────────────────────────────────────────────────

@router.get("/model/status")
async def model_status(vehicleId: Optional[str] = None, orgId: Optional[str] = None) -> dict:
    """Return global service status or readiness for one vehicle."""
    if not vehicleId:
        return {
            "service": "theorem",
            "ready": True,
            "pretrainedLoaded": is_pretrained_loaded(),
            "database": {"available": pg_db.is_available()},
            "cachedVehicleModels": len(_if_cache),
        }
    if not orgId:
        raise HTTPException(status_code=422, detail="orgId is required")
    vif = await _get_or_load_vif(vehicleId, orgId)
    await _load_welford_from_db(vehicleId, orgId)
    saved = await pg_db.get_model_state(vehicleId, orgId) if pg_db.is_available() else None
    if saved and "welford" in saved:
        _welford_state[(orgId, vehicleId)] = saved["welford"]
    w_state = _welford_state.get((orgId, vehicleId), {})
    min_count = min((ws.get("count", 0) for ws in w_state.values()), default=0)
    learning_history = (saved or {}).get("learningHistory", {})
    initial_backfill = learning_history.get("backfillPending") and not learning_history.get("lastFullScanCompletedAt")

    db_ok = pg_db.is_available()
    coverage = await pg_db.get_telemetry_coverage(vehicleId, orgId) if db_ok else None

    return {
        "vehicleId": vehicleId,
        "isolationForest": {
            "trained": vif.is_trained(),
            "ageHours": vif.age_hours(),
            "needsRetraining": vif.needs_retraining(),
            "trainSampleCount": vif._train_sample_count,
        },
        "welford": {
            "metricsTracked": len(w_state),
            "minObservations": min_count,
            "ready": min_count >= 10 and not initial_backfill,
            "history": learning_history or None,
        },
        "database": {
            "available": db_ok,
        },
        "telemetry": coverage or {"dbSampleCount": None, "coverageAvailable": False},
    }


# ── GET /review-queue ─────────────────────────────────────────────────────────

@router.get("/review-queue")
async def review_queue(limit: int = 20, orgId: Optional[str] = None) -> dict:
    """
    Phase 6 active learning — return the most uncertain predictions pending
    human review.  Fleet managers label these to train the meta-learner.
    """
    from ..ml.active_learning import al_top_candidates, get_al_meta
    if not orgId:
        raise HTTPException(status_code=422, detail="orgId is required")
    if pg_db.is_available():
        try:
            candidates = await pg_db.get_review_candidates(orgId, limit=max(1, min(limit, 100)))
        except Exception:
            raise HTTPException(status_code=503, detail="Review queue temporarily unavailable")
        return {"candidates": [{k: v for k, v in c.items() if k != "features"} for c in candidates],
                "meta": {"persistence": "database", "returnedCount": len(candidates)}}
    candidates = al_top_candidates(n=max(1, min(limit, 100)), org_id=orgId)
    return {
        "candidates": candidates,
        "meta": get_al_meta(orgId),
    }


# ── POST /review-queue/label ──────────────────────────────────────────────────

class LabelRequest(BaseModel):
    vehicleId: str
    orgId: str = Field(..., min_length=1)
    outcome: str  # "confirmed_breakdown" | "false_positive" | "normal"


@router.post("/review-queue/label")
async def label_prediction(req: LabelRequest) -> dict:
    """
    Submit a human label for a queued vehicle.
    Feeds the labeled sample into the Phase 4A meta-learner training buffer.
    """
    from ..ml.active_learning import al_label, al_peek
    valid_outcomes = {"confirmed_breakdown", "false_positive", "confirmed_normal"}
    if req.outcome not in valid_outcomes:
        raise HTTPException(
            status_code=422,
            detail=f"outcome must be one of {sorted(valid_outcomes)}",
        )
    if pg_db.is_available():
        try:
            candidates = await pg_db.get_review_candidates(req.orgId, req.vehicleId, limit=1)
        except Exception:
            raise HTTPException(status_code=503, detail="Review queue temporarily unavailable")
        result = candidates[0] if candidates else None
    else:
        result = al_peek(req.vehicleId, req.orgId)
    if result is None:
        raise HTTPException(
            status_code=404,
            detail=f"Vehicle '{req.vehicleId}' not found in review queue",
        )
    try:
        saved = await pg_db.save_review_feedback(req.vehicleId, req.orgId, req.outcome, result)
    except Exception:
        saved = False
    if not saved:
        raise HTTPException(status_code=503, detail="Outcome could not be saved; review remains pending")
    al_label(req.vehicleId, req.outcome, req.orgId, result["queuedAt"])
    return {"labeled": result, "outcome": req.outcome, "persisted": True,
            "trainingEligible": False, "evidenceSource": "production_review_not_oof"}


# ── GET /baselines/{profileKey} ───────────────────────────────────────────────

@router.get("/baselines/{profile_key}")
async def get_baseline_profile(profile_key: str) -> dict:
    """Return a pre-trained baseline profile from MlBaselineProfile table."""
    profile = await pg_db.get_baseline_profile(profile_key)
    if not profile:
        raise HTTPException(status_code=404, detail=f"Baseline profile '{profile_key}' not found")
    return profile
