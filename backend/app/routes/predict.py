"""
Prediction endpoints for Fleet AI ML service.

POST /predict            — full ensemble prediction for a vehicle
GET  /model/status       — per-vehicle model readiness
GET  /baselines/{key}    — fetch a stored MlBaselineProfile
"""
from __future__ import annotations
import json
import logging
import time
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..db import pg as pg_db
from ..ml.features import coalesce_samples, extract_features, metric_value, METRIC_KEYS
from ..ml.dtc import analyze_dtcs
from ..ml.diagnosis import run_diagnosis
from ..ml.fleet import compute_fleet_normalization, fleet_risk_boost
from ..ml.isolation_forest import VehicleIsolationForest
from ..ml.ensemble import compute_ensemble, get_class_threshold
from ..ml.pretrained import is_pretrained_loaded, score_pretrained
from ..ml.stage2 import STAGE1_THRESHOLD, get_stage2_meta, score_stage2
from ..ml.stage3 import STAGE3_HIGH, STAGE3_LOW, evaluate_stage3, get_stage3_buffer_stats
from ..ml.stack import (
    build_stack_features, get_stack_meta, stack_maybe_retrain, stack_score,
)
from ..ml.conformal import conformal_predict, get_conformal_meta, is_conformal_fitted
from ..ml.active_learning import al_maybe_enqueue, get_al_meta

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

# In-memory IF cache keyed by vehicleId
_if_cache: dict[str, VehicleIsolationForest] = {}


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


def _get_welford_state(vehicle_id: str) -> dict[str, dict]:
    return _welford_state.setdefault(vehicle_id, {})


async def _load_welford_from_db(vehicle_id: str) -> None:
    """Restore Welford state from persisted ModelState if not in memory."""
    if vehicle_id in _welford_state:
        return
    state = await pg_db.get_model_state(vehicle_id)
    if state and "welford" in state:
        _welford_state[vehicle_id] = state["welford"]


async def _persist_state(vehicle_id: str, org_id: Optional[str], vif: VehicleIsolationForest) -> None:
    """Save IF model + Welford state to PostgreSQL."""
    welford = _welford_state.get(vehicle_id, {})
    await pg_db.upsert_model_state(vehicle_id, org_id, {
        "welford": welford,
        "isolation_forest": vif.to_state_dict(),
        "updated_at": time.time(),
    })


async def _get_or_load_vif(vehicle_id: str, org_id: Optional[str]) -> VehicleIsolationForest:
    """Return in-memory IF, loading from DB if missing."""
    if vehicle_id not in _if_cache:
        state = await pg_db.get_model_state(vehicle_id)
        if state and "isolation_forest" in state:
            vif = VehicleIsolationForest.from_state_dict(state["isolation_forest"])
        else:
            vif = VehicleIsolationForest()
        _if_cache[vehicle_id] = vif
    return _if_cache[vehicle_id]


# ── Baseline persistence helpers ──────────────────────────────────────────────

async def _persist_baselines(
    vehicle_id: str,
    org_id: Optional[str],
    window_stats: dict,
    samples: list[dict],
) -> None:
    """Write per-metric Welford stats to the Baseline table."""
    welford = _welford_state.get(vehicle_id, {})
    for metric_key in METRIC_KEYS:
        ws = welford.get(metric_key)
        if not ws or ws.get("count", 0) < 2:
            continue
        count = ws["count"]
        mean = ws["mean"]
        M2 = ws["M2"]
        # Persist percentiles from validated telemetry, not adapter sentinel values.
        all_stats = window_stats.get(metric_key, {}).get("all", {})
        sample_values = [metric_value(sample, metric_key) for sample in samples]
        sample_values = [value for value in sample_values if value is not None]
        await pg_db.upsert_baseline(
            vehicle_id=vehicle_id,
            org_id=org_id,
            metric_key=metric_key,
            window_days=14,
            count=count,
            mean=mean,
            m2=M2,
            min_val=all_stats.get("min"),
            max_val=all_stats.get("max"),
            samples_list=sample_values,
        )


# ── POST /predict ─────────────────────────────────────────────────────────────

@router.post("/predict")
async def predict(req: PredictRequest) -> dict:
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

    # ── 1. Gather samples ─────────────────────────────────────────────────────
    db_samples = await pg_db.get_recent_samples(vehicle_id, limit=5000)
    # Merge: request samples take precedence (they may be fresher)
    all_samples = _dedupe_samples(db_samples + req.samples if req.samples else db_samples)
    if not all_samples:
        return {
            "vehicleId": vehicle_id,
            "available": False,
            "reason": "no_telemetry",
            "riskProbability": 0.0,
            "prediction": "insufficient_data",
            "confidence": 0.0,
        }

    # ── 2. Feature extraction ─────────────────────────────────────────────────
    features = extract_features(all_samples, vehicle_meta=req.vehicleMeta)
    if not features.get("available"):
        return {
            "vehicleId": vehicle_id,
            "available": False,
            "reason": "feature_extraction_failed",
            "riskProbability": 0.0,
            "prediction": "insufficient_data",
            "confidence": 0.0,
        }

    flat = features["flat"]
    window_stats = features["window_stats"]
    current_metrics = features["current_metrics"]
    mv_stress = features.get("multivariate_stress", {})

    # ── 3. Welford update ─────────────────────────────────────────────────────
    await _load_welford_from_db(vehicle_id)
    w_state = _get_welford_state(vehicle_id)
    welford_zscores: dict[str, float] = {}

    for metric_key in METRIC_KEYS:
        val = current_metrics.get(metric_key)
        if val is None:
            continue
        ms = w_state.setdefault(metric_key, {"count": 0, "mean": 0.0, "M2": 0.0})
        z = _welford_zscore(ms, val)
        w_state[metric_key] = _welford_update(ms, val)
        if z is not None:
            welford_zscores[metric_key] = round(z, 3)

    welford_count = min(ws.get("count", 0) for ws in w_state.values()) if w_state else 0

    # ── 4. Isolation Forest ───────────────────────────────────────────────────
    vif = await _get_or_load_vif(vehicle_id, org_id)

    if vif.needs_retraining() and features["sample_count"] >= 50:
        # Build flat dicts for all samples to use as training rows
        # We train on a sliding window of the most recent 2000 samples
        train_samples = all_samples[-2000:]
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
            _if_cache[vehicle_id] = vif

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
    fleet_norm = await compute_fleet_normalization(vehicle_id, window_stats)
    f_boost = fleet_risk_boost(fleet_norm)

    # ── 7. Pretrained prior score (5th ensemble signal) ───────────────────────
    pretrained_score = score_pretrained(
        current_metrics={k: v for k, v in current_metrics.items() if v is not None},
        window_stats=window_stats,
        vehicle_meta=req.vehicleMeta,
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
    # Use per-class threshold so lighter vehicles aren't silenced by the
    # Phase 1B multiplier compressing their scores below the heavy-duty cutoff.
    effective_threshold = get_class_threshold(vehicle_class) if vehicle_class else STAGE1_THRESHOLD
    if stage1_score >= effective_threshold:
        pretrained_decayed = float(
            max(0.0, min(1.0, (features["sample_count"] - 50) / 450))
            if features["sample_count"] > 50 else 0.0
        )
        vehicle_context = {
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
            stage_system = {
                "stage1Score": round(stage1_score, 4),
                "stage2Score": round(stage2_score, 4),
                "signalAgreement": round(s2["signal_agreement"], 4),
                "confirmed": s2["confirmed"],
                "confirmationReason": s2["confirmation_reason"],
                "stage1Threshold": effective_threshold,
            }

    # ── 8.6. Stage 3 Arbitrator (borderline zone only) ───────────────────────
    if stage2_score is not None and STAGE3_LOW <= stage2_score <= STAGE3_HIGH:
        clean_metrics = {k: v for k, v in current_metrics.items() if v is not None}
        s3 = evaluate_stage3(
            vehicle_id=vehicle_id,
            stage2_score=stage2_score,
            current_metrics=clean_metrics,
            window_stats=window_stats,
        )
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
    stack_maybe_retrain()

    # ── 8.8. Phase 5 — conformal prediction (coverage guarantee) ─────────────
    conformal_result: Optional[dict] = None
    if stage2_score is not None:
        conformal_result = conformal_predict(
            prob_positive=stage2_score,
            vehicle_class=vehicle_class,
        )

    # ── 8.9. Phase 6 — active learning queue (uncertainty sampling) ───────────
    s3_verdict_str = ""
    if stage_system and "stage3" in stage_system:
        s3_verdict_str = stage_system["stage3"].get("verdict", "")
    al_maybe_enqueue(
        vehicle_id=vehicle_id,
        org_id=org_id or "",
        risk_probability=result.get("riskProbability", 0.0),
        stage2_score=stage2_score,
        stage3_verdict=s3_verdict_str,
        prediction=result.get("prediction", ""),
        stack_features=stack_features,
    )

    # ── 9. Persist ────────────────────────────────────────────────────────────
    try:
        await _persist_baselines(vehicle_id, org_id, window_stats, all_samples)
        await _persist_state(vehicle_id, org_id, vif)
    except Exception as exc:
        logger.debug(f"[predict] persist error for {vehicle_id}: {exc}")

    elapsed_ms = round((time.monotonic() - t0) * 1000, 1)

    return {
        "vehicleId": vehicle_id,
        "available": True,
        **result,
        "dtcAnalysis": dtc_analysis,
        "diagnosis": diagnosis,
        "fleetNormalization": fleet_norm,
        "currentMetrics": current_metrics,
        "features": {
            "sampleCount": features["sample_count"],
            "dutyCycle": features["duty_cycle"],
            "sampleDensity": features["sample_density"],
            "multivariateStress": mv_stress,
        },
        "stageSystem": stage_system,
        "metaScore": meta_score,
        "conformal": conformal_result,
        "modelStatus": {
            "ifTrained": vif.is_trained(),
            "ifAgeHours": vif.age_hours(),
            "welfordCount": welford_count,
            "pretrainedLoaded": pretrained_score is not None,
            **get_stage2_meta(),
            "stage3": get_stage3_buffer_stats(),
            "stackMeta": get_stack_meta(),
            "conformal": get_conformal_meta(),
            "activeLearning": get_al_meta(),
        },
        "latencyMs": elapsed_ms,
    }


# ── GET /model/status ─────────────────────────────────────────────────────────

@router.get("/model/status")
async def model_status(vehicleId: Optional[str] = None) -> dict:
    """Return global service status or readiness for one vehicle."""
    if not vehicleId:
        return {
            "service": "theorem",
            "ready": True,
            "pretrainedLoaded": is_pretrained_loaded(),
            "database": {"available": pg_db.is_available()},
            "cachedVehicleModels": len(_if_cache),
        }
    vif = await _get_or_load_vif(vehicleId, None)
    w_state = _welford_state.get(vehicleId, {})
    min_count = min((ws.get("count", 0) for ws in w_state.values()), default=0)

    db_ok = pg_db.is_available()
    sample_count = 0
    if db_ok:
        samples = await pg_db.get_recent_samples(vehicleId, limit=1)
        sample_count = len(samples)

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
            "ready": min_count >= 10,
        },
        "database": {
            "available": db_ok,
        },
        "telemetry": {
            "dbSampleCount": sample_count,
        },
    }


# ── GET /review-queue ─────────────────────────────────────────────────────────

@router.get("/review-queue")
async def review_queue(limit: int = 20) -> dict:
    """
    Phase 6 active learning — return the most uncertain predictions pending
    human review.  Fleet managers label these to train the meta-learner.
    """
    from ..ml.active_learning import al_top_candidates, get_al_meta
    candidates = al_top_candidates(n=min(limit, 100))
    return {
        "candidates": candidates,
        "meta": get_al_meta(),
    }


# ── POST /review-queue/label ──────────────────────────────────────────────────

class LabelRequest(BaseModel):
    vehicleId: str
    outcome: str  # "confirmed_breakdown" | "false_positive" | "normal"


@router.post("/review-queue/label")
async def label_prediction(req: LabelRequest) -> dict:
    """
    Submit a human label for a queued vehicle.
    Feeds the labeled sample into the Phase 4A meta-learner training buffer.
    """
    from ..ml.active_learning import al_label
    valid_outcomes = {"confirmed_breakdown", "false_positive", "normal"}
    if req.outcome not in valid_outcomes:
        raise HTTPException(
            status_code=422,
            detail=f"outcome must be one of {sorted(valid_outcomes)}",
        )
    result = al_label(req.vehicleId, req.outcome)
    if result is None:
        raise HTTPException(
            status_code=404,
            detail=f"Vehicle '{req.vehicleId}' not found in review queue",
        )
    return {"labeled": result, "outcome": req.outcome}


# ── GET /baselines/{profileKey} ───────────────────────────────────────────────

@router.get("/baselines/{profile_key}")
async def get_baseline_profile(profile_key: str) -> dict:
    """Return a pre-trained baseline profile from MlBaselineProfile table."""
    profile = await pg_db.get_baseline_profile(profile_key)
    if not profile:
        raise HTTPException(status_code=404, detail=f"Baseline profile '{profile_key}' not found")
    return profile
