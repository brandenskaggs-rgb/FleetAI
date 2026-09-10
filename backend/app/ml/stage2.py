"""
Stage 2 confirmatory classifier for Fleet AI two-stage prediction pipeline.

Stage 1 (existing ensemble) is a wide-net screener at threshold=0.35 —
high recall, accepts false positives. Stage 2 receives any Stage 1 alert
and decides whether the pattern is a genuine mechanical failure or noise.

Three false-positive archetypes Stage 2 learns to suppress:
  1. Sensor spike      — one signal loud, four others quiet
  2. Load stress       — all moderately elevated, vehicle not failing
  3. Prior artifact    — pretrained elevated but per-vehicle signals healthy
"""
from __future__ import annotations

import asyncio
import logging
import os
import threading
import time
from pathlib import Path
from typing import Optional

import numpy as np

logger = logging.getLogger(__name__)

# ── Paths ─────────────────────────────────────────────────────────────────────
def _find_model_file(filename: str) -> Path:
    _here = Path(__file__).resolve()
    candidates = [
        Path(os.getenv("FLEETAI_MODEL_DIR", "")) / filename if os.getenv("FLEETAI_MODEL_DIR") else None,
        # Repo root first — training writes there; the backend-local copy used
        # to shadow it with stale artifacts (see pretrained._find_model_file).
        _here.parents[4] / "fleet_ai" / "models" / filename if len(_here.parents) > 4 else None,
        _here.parents[3] / "fleet_ai" / "models" / filename,
        Path("/app/fleet_ai/models") / filename,
        Path("/app/backend/fleet_ai/models") / filename,
    ]
    for p in candidates:
        if p and p.exists():
            return p
    return _here.parents[3] / "fleet_ai" / "models" / filename

_MODEL_DIR = _find_model_file("stage2_model.pkl").parent
_STAGE2_MODEL_PATH = _MODEL_DIR / "stage2_model.pkl"

# ── Stage 1 screening threshold (default 0.35) ────────────────────────────────
STAGE1_THRESHOLD = float(os.getenv("STAGE1_THRESHOLD", "0.35"))

# ── Feature schema (29 features) ──────────────────────────────────────────────
from .feature_contract import STAGE2_FEATURES as CANONICAL_STAGE2_FEATURES, manifest, supervised_label, validate_features
STAGE2_FEATURES = list(CANONICAL_STAGE2_FEATURES)

# ── Vehicle class → int mapping ───────────────────────────────────────────────
from .feature_contract import STAGE2_CLASS_CODES as _CLASS_MAP

# ── DTC system keyword detection ──────────────────────────────────────────────
_DTC_SYSTEM_KEYWORDS = {
    "has_cooling_dtc":    ["P0115", "P0116", "P0117", "P0118", "P0119", "P0125", "cooling", "coolant", "thermostat"],
    "has_fuel_dtc":       ["P0171", "P0172", "P0174", "P0175", "fuel", "injector", "trim"],
    "has_electrical_dtc": ["P0620", "P0621", "P0622", "U0", "B0", "electrical", "battery", "voltage"],
    "has_emissions_dtc":  ["P0400", "P0401", "P0402", "P0420", "P0430", "DPF", "EGR", "emissions"],
    "has_engine_dtc":     ["P0300", "P0301", "P0302", "P0303", "P0304", "misfire", "knock", "engine"],
}


class Stage2Classifier:
    """Thread-safe wrapper around a LightGBM binary classifier."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._model = None
        self._loaded = False
        self._train_sample_count = 0
        self._feedback_samples = 0
        self._load_time: Optional[float] = None
        self._calibrator = None
        from .conformal import ConformalPredictor
        self._conformal = ConformalPredictor()
        self._metadata = {"calibration": {"status": "uncalibrated", "reason": "legacy_no_artifact"}}

    # ── Load ──────────────────────────────────────────────────────────────────

    def load(self, bundle_override=None) -> bool:
        try:
            import joblib
            from .artifact_registry import configured_registry
            registry = configured_registry()
            bundle = bundle_override if bundle_override is not None else registry.load_active("stage2") if registry else None
            if bundle is None:
                if not _STAGE2_MODEL_PATH.exists():
                    return False
                bundle = joblib.load(_STAGE2_MODEL_PATH)
            from .feature_contract import validate_bundle_schema
            validate_bundle_schema(bundle, STAGE2_FEATURES)
            with self._lock:
                self._model = bundle["model"]
                self._metadata = bundle.get("metadata") or {"modelVersion": "stage2-legacy", "trainingSource": "synthetic_proxy_stacking"}
                cal_meta = bundle.get("calibration") or self._metadata.get("calibration") or {}
                valid_cal = (bool(bundle.get("artifactId")) and bundle.get("calibrator") is not None and cal_meta.get("status") == "calibrated"
                             and cal_meta.get("artifactId") == bundle.get("artifactId")
                             and cal_meta.get("modelVersion") == self._metadata.get("modelVersion"))
                self._calibrator = bundle.get("calibrator") if valid_cal else None
                self._metadata["calibration"] = cal_meta if valid_cal else {"status": "uncalibrated", "reason": "no_valid_bound_calibrator"}
                from .conformal import ConformalPredictor
                self._conformal = ConformalPredictor()
                conformal_bundle = bundle.get("conformal") or {}
                if bundle.get("artifactId") and conformal_bundle.get("metadata", {}).get("artifactId") == bundle.get("artifactId"):
                    self._conformal.restore_bound(conformal_bundle, self._metadata.get("modelVersion"))
                self._train_sample_count = bundle.get("train_sample_count", 0)
                self._feedback_samples = bundle.get("feedback_samples", 0)
                self._loaded = True
                self._load_time = time.time()
            logger.info(
                "[stage2] Loaded — %d training samples, %d feedback samples",
                self._train_sample_count, self._feedback_samples,
            )
            return True
        except Exception as exc:
            logger.warning("[stage2] Load failed: %s", exc)
            return False

    def is_loaded(self) -> bool:
        return self._loaded

    # ── Feature builder ───────────────────────────────────────────────────────

    @staticmethod
    def build_features(stage1_output: dict, vehicle_context: dict) -> Optional[np.ndarray]:
        """
        Convert Stage 1 ensemble output + vehicle context to a Stage 2 feature vector.

        stage1_output  — the full dict returned by compute_ensemble() + riskProbability
        vehicle_context — supplementary dict:
          {
            "currentMetrics": {...},
            "fleetNormalization": {...},
            "multivariateStress": {...},
            "vehicleMeta": {...},
            "sampleCount": int,
            "welfordCount": int,
            "pretrainedDecayed": float,  # 0=prior fully trusted, 1=fully decayed
            "dtcAnalysis": {...} | None,
            "diagnosis": {...} | None,
          }
        """
        try:
            comps = stage1_output.get("components", {})
            ew = comps.get("effectiveWeights", {})
            cm = vehicle_context.get("currentMetrics", {})
            fleet = vehicle_context.get("fleetNormalization", {})
            mv = vehicle_context.get("multivariateStress", {})
            meta = vehicle_context.get("vehicleMeta", {}) or {}
            dtc = vehicle_context.get("dtcAnalysis") or {}
            diag = vehicle_context.get("diagnosis") or {}

            def observed(mapping, *keys):
                for key in keys:
                    if mapping.get(key) is not None:
                        return float(mapping[key])
                return float("nan")

            # Stage 1 signal scores
            stage1_score = float(stage1_output.get("riskProbability", 0.0))
            pretrained_s = observed(comps, "pretrained")
            if_s = observed(comps, "isolationForest")
            welford_s = observed(comps, "welford")
            threshold_s = observed(comps, "threshold")
            dtc_s = float(comps.get("dtc") or 0.0)

            # Effective weights
            w_pt = float(ew.get("pretrained", 0.0))
            w_if = float(ew.get("isolationForest", 0.0))
            w_w = float(ew.get("welford", 0.0))
            w_t = float(ew.get("threshold", 0.0))
            w_d = float(ew.get("dtc", 0.0))

            signal_agreement = float(stage1_output.get("signalAgreement", 0.5))

            # Fleet percentile (use worst metric z if available)
            fleet_summary = fleet.get("_summary", {}) if fleet else {}
            fleet_pct = float(fleet_summary.get("fleet_percentile", 0.5))

            # Multivariate stress max
            mv_max = float(max(mv.values())) if mv else 0.0

            # Per-vehicle maturity
            sample_count = float(min(vehicle_context.get("sampleCount", 0), 2000))
            welford_conf = float(min(1.0, vehicle_context.get("welfordCount", 0) / 100))
            pt_decayed = float(vehicle_context.get("pretrainedDecayed", 0.0))

            # DTC category flags
            dtc_codes: list[str] = dtc.get("codes", []) if dtc else []
            systems: list[str] = [str(s).lower() for s in dtc.get("systems_affected", [])]

            def _has_dtc(key: str) -> float:
                keywords = [kw.lower() for kw in _DTC_SYSTEM_KEYWORDS[key]]
                for code in dtc_codes:
                    if any(kw in code.upper() for kw in [k.upper() for k in keywords]):
                        return 1.0
                for s in systems:
                    if any(kw in s for kw in keywords):
                        return 1.0
                return 0.0

            has_cooling = _has_dtc("has_cooling_dtc")
            has_fuel = _has_dtc("has_fuel_dtc")
            has_elec = _has_dtc("has_electrical_dtc")
            has_emis = _has_dtc("has_emissions_dtc")
            has_eng = _has_dtc("has_engine_dtc")

            # Diagnosis urgency (0=healthy, 1=critical)
            urgency_map = {"critical": 1.0, "high": 0.75, "moderate": 0.50, "low": 0.25}
            diag_urgency = urgency_map.get(str(diag.get("urgency", "")).lower(), 0.0)

            # Vehicle class code
            vehicle_class = str(meta.get("vehicleClass", "") or meta.get("vehicle_class", "")).lower()
            class_code = float(_CLASS_MAP.get(vehicle_class, 0))

            # Top temperature features
            ambient_temp = observed(cm, "ambientTemp", "ambient_temp_c")
            idle_heat = observed(cm, "idleHeatSoak", "idle_heat_soak")
            coolant_osc = observed(cm, "coolantTempOscillation", "coolant_temp_oscillation")
            batt_v = observed(cm, "batteryVoltage", "battery_voltage")
            eng_temp_delta = observed(cm, "engineTempDelta30d", "engine_temp_delta_30d")

            row = np.array([
                stage1_score, pretrained_s, if_s, welford_s, threshold_s, dtc_s,
                w_pt, w_if, w_w, w_t, w_d,
                signal_agreement,
                fleet_pct, mv_max,
                sample_count, welford_conf, pt_decayed,
                has_cooling, has_fuel, has_elec, has_emis, has_eng,
                diag_urgency, class_code,
                ambient_temp, idle_heat, coolant_osc, batt_v, eng_temp_delta,
            ], dtype=np.float32)
            return row.reshape(1, -1)
        except Exception as exc:
            logger.debug("[stage2] build_features error: %s", exc)
            return None

    # ── Score ─────────────────────────────────────────────────────────────────

    def score(self, stage1_output: dict, vehicle_context: dict) -> Optional[dict]:
        """
        Run Stage 2 classification.

        Returns dict with keys: confirmed, stage2_probability, signal_agreement,
        confirmation_reason.  Returns None if model not loaded or feature error.
        """
        if not self._loaded:
            return None

        row = self.build_features(stage1_output, vehicle_context)
        if row is None:
            return None

        try:
            with self._lock:
                prob = float(self._model.predict_proba(row)[0, 1])
                if self._calibrator is not None:
                    prob = float(self._calibrator.predict([prob])[0])
            if not np.isfinite(prob) or not 0 <= prob <= 1:
                raise ValueError("Invalid Stage 2 probability")
        except Exception:
            logger.warning("[stage2] Inference unavailable; retaining Stage 1 evidence")
            return None

        confirmed = prob >= 0.50
        agreement = float(stage1_output.get("signalAgreement", 0.5))

        reason = _build_reason(stage1_output, vehicle_context, prob, confirmed, agreement)

        return {
            "confirmed": confirmed,
            "stage2_probability": round(prob, 4),
            "signal_agreement": round(agreement, 4),
            "confirmation_reason": reason,
            "calibration": self._metadata.get("calibration"),
            "missingFeatures": [f for f, v in zip(STAGE2_FEATURES, row[0]) if not np.isfinite(v)],
            "conformal": self._conformal.predict(prob, str((vehicle_context.get("vehicleMeta") or {}).get("vehicleClass", ""))),
        }

    # ── Retrain from feedback ─────────────────────────────────────────────────

    async def retrain_from_feedback(self, db, org_id=None) -> bool:
        """
        Pull labeled FeedbackLog rows from PostgreSQL and retrain Stage 2.
        Runs in a thread to avoid blocking the event loop.
        """
        try:
            if not org_id:
                return False
            rows = await db.get_feedback_for_training(org_id=org_id)
            if len(rows) < 50:
                logger.info("[stage2] Only %d feedback rows — skipping retrain (need 50+)", len(rows))
                return False
            result = await asyncio.get_event_loop().run_in_executor(
                None, self._retrain_sync, rows
            )
            return result
        except Exception as exc:
            logger.warning("[stage2] Candidate training failed; durable scheduler must retry")
            raise

    def _retrain_sync(self, rows: list[dict]) -> bool:
        import lightgbm as lgb
        import joblib

        from .stacking_evidence import require_oof
        from .artifact_registry import configured_registry
        registry = configured_registry()
        organizations = {r.get("orgId") for r in rows}
        if registry is None or len(organizations) != 1 or None in organizations:
            return False
        X_list, y_list = [], []
        for row in rows:
            feats = row.get("features", {})
            if not feats:
                continue
            try:
                require_oof({"provenance": feats.get("provenance")})
                from .feature_contract import vector
                if not all(f in feats for f in STAGE2_FEATURES):
                    continue
                vec = vector(feats, STAGE2_FEATURES)
                label = supervised_label(row.get("outcome"))
                if label is None:
                    continue
                X_list.append(vec)
                y_list.append(label)
            except Exception:
                continue

        if len(X_list) < 50 or len(set(y_list)) != 2:
            return False

        X = np.array(X_list, dtype=np.float32)
        y = np.array(y_list, dtype=np.int32)

        model = lgb.LGBMClassifier(
            n_estimators=200,
            learning_rate=0.05,
            num_leaves=31,
            class_weight="balanced",
            random_state=42,
        )
        model.fit(X, y)

        bundle = {
            "model": model,
            "features": STAGE2_FEATURES,
            "train_sample_count": len(X_list),
            "feedback_samples": len(X_list),
        }
        registry.candidate("stage2", bundle, {
            "modelVersion": "stage2-feedback-candidate", "trainingSource": "real_oof",
            "featureSchema": manifest(STAGE2_FEATURES),
            "calibration": {"status": "uncalibrated"},
            "evaluationRequired": True,
        }, scope="tenant:" + str(next(iter(organizations))))
        logger.info("[stage2] Candidate saved; evaluation and explicit promotion required")
        return True


    def save(self) -> None:
        raise RuntimeError("Use the candidate registry; overwriting the active artifact is disabled")


# ── Reason builder ────────────────────────────────────────────────────────────

def _build_reason(
    stage1_output: dict,
    vehicle_context: dict,
    prob: float,
    confirmed: bool,
    agreement: float,
) -> str:
    comps = stage1_output.get("components", {})
    cm = vehicle_context.get("currentMetrics", {})
    dtc = vehicle_context.get("dtcAnalysis") or {}

    signals_above = sum(
        1 for k in ["pretrained", "isolationForest", "welford", "threshold", "dtc"]
        if (comps.get(k) or 0.0) >= 0.40
    )

    parts = []
    if confirmed:
        parts.append(f"{signals_above} of 5 signals aligned.")
        if cm.get("idle_heat_soak") and float(cm.get("idle_heat_soak") or 0) > 0.5:
            parts.append("Idle heat soak elevated.")
        if cm.get("coolantTempOscillation") and float(cm.get("coolantTempOscillation") or 0) > 5:
            parts.append("Coolant temperature oscillation detected.")
        if cm.get("batteryVoltage") and float(cm.get("batteryVoltage") or 13) < 12.3:
            parts.append("Battery voltage below normal range.")
        if agreement >= 0.75:
            parts.append("High signal agreement confirms mechanical origin, not sensor noise.")
        elif agreement >= 0.50:
            parts.append("Moderate signal agreement — probable mechanical cause.")
        if dtc.get("systems_affected"):
            systems = ", ".join(dtc["systems_affected"][:2])
            parts.append(f"Active fault codes: {systems}.")
    else:
        parts.append("Stage 1 alert not confirmed by Stage 2.")
        if agreement < 0.40:
            parts.append("Low signal agreement suggests sensor noise or transient load spike.")
        elif float(comps.get("pretrained") or 0) > 0.6 and float(comps.get("isolationForest") or 0) < 0.3:
            parts.append("Pretrained prior elevated but per-vehicle model shows normal patterns — possible prior artifact.")
        else:
            parts.append("Pattern consistent with temporary load stress. Continue monitoring.")

    return " ".join(parts) if parts else ("Alert confirmed." if confirmed else "Alert not confirmed.")


# ── Module-level singleton ────────────────────────────────────────────────────

_classifier = Stage2Classifier()
_tenant_classifiers = {}


def _classifier_for(org_id=None):
    if not org_id:
        return _classifier
    if org_id not in _tenant_classifiers:
        from .artifact_registry import configured_registry
        registry = configured_registry()
        try:
            bundle = registry.load_active("stage2", "tenant:" + org_id) if registry else None
        except Exception:
            logger.warning("[stage2] Tenant artifact unavailable; using approved global prior")
            bundle = None
        candidate = Stage2Classifier() if bundle else None
        _tenant_classifiers[org_id] = candidate if candidate and candidate.load(bundle) else None
    return _tenant_classifiers[org_id] or _classifier


def load_stage2() -> bool:
    return _classifier.load()


def score_stage2(stage1_output: dict, vehicle_context: dict) -> Optional[dict]:
    return _classifier_for(vehicle_context.get("orgId")).score(stage1_output, vehicle_context)


def is_stage2_loaded() -> bool:
    return _classifier.is_loaded()


def get_stage2_meta(org_id=None) -> dict:
    classifier = _classifier_for(org_id)
    return {
        **classifier._metadata,
        "loaded": classifier.is_loaded(),
        "trainSampleCount": classifier._train_sample_count,
        "feedbackSamplesIncorporated": classifier._feedback_samples,
    }


async def retrain_stage2_from_feedback(db, org_id=None) -> bool:
    return await _classifier.retrain_from_feedback(db, org_id)
