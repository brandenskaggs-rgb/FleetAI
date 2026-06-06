"""
Phase 4A: Stacking meta-learner for Fleet AI.

A LogisticRegression trained on the outputs of all Stage 1 signals
(rf_prob, hgb_prob, if_score, welford_score, threshold_score, dtc_score)
plus Stage 3 features (convergingSignals, weightedConvergence).

The meta-learner learns which combination of base-model outputs best
predicts real breakdowns from the labeled feedback loop.  It only activates
once at least MIN_FEEDBACK_ROWS labeled outcomes have been collected.

Until then, it falls back to a transparent linear blend (same as the raw
ensemble output) with no overhead.
"""
from __future__ import annotations

import logging
import threading
import time
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

_MODEL_DIR = Path(__file__).resolve().parents[3] / "fleet_ai" / "models"
_STACK_MODEL_PATH = _MODEL_DIR / "stack_meta_model.pkl"

MIN_FEEDBACK_ROWS = 100   # rows needed before training is worthwhile
MAX_BUFFER_ROWS   = 5000  # cap in-memory buffer before oldest rows are evicted

# Feature names fed into the meta-learner (order must be stable)
STACK_FEATURES = [
    "pretrained_score",
    "if_score",
    "welford_score",
    "threshold_score",
    "dtc_score",
    "stage2_probability",   # None → 0 if Stage 2 did not run
    "signal_agreement",
    "active_signals",       # Phase 3A gate count
    "converging_signals",   # Stage 3 count (0 if Stage 3 did not run)
    "weighted_convergence", # Stage 3 weighted count
    "fleet_percentile",
    "vehicle_class_code",
]


class StackMetaLearner:
    """
    Lightweight stacking layer that re-ranks ensemble output using feedback.

    Training is incremental — call `add_feedback(row, outcome)` as labeled
    data arrives, then `maybe_retrain()` periodically (e.g., on each /predict
    call after a cooldown).

    `score()` returns the meta-learner probability if the model is trained,
    otherwise returns None (caller falls back to raw ensemble score).
    """

    def __init__(self) -> None:
        self._lock    = threading.Lock()
        self._model   = None
        self._trained = False
        self._buffer: list[tuple[list[float], int]] = []
        self._last_train: float = 0.0
        self._train_count = 0
        self._retrain_cooldown = 3600.0  # at most once per hour

    # ── Load persisted model ──────────────────────────────────────────────────

    def load(self) -> bool:
        if not _STACK_MODEL_PATH.exists():
            return False
        try:
            import joblib
            bundle = joblib.load(_STACK_MODEL_PATH)
            with self._lock:
                self._model = bundle["model"]
                self._trained = True
                self._train_count = bundle.get("train_count", 0)
            logger.info("[stack] Loaded meta-learner (%d training rows)", self._train_count)
            return True
        except Exception as exc:
            logger.warning("[stack] Load failed: %s", exc)
            return False

    # ── Collect labeled feedback ──────────────────────────────────────────────

    def add_feedback(self, feature_row: dict, outcome: str) -> None:
        """
        Store one labeled prediction in the training buffer.

        outcome: "confirmed_breakdown" → label=1; anything else → label=0.
        """
        try:
            vec = self._dict_to_vec(feature_row)
            label = 1 if outcome == "confirmed_breakdown" else 0
            with self._lock:
                self._buffer.append((vec, label))
                if len(self._buffer) > MAX_BUFFER_ROWS:
                    self._buffer = self._buffer[-MAX_BUFFER_ROWS:]
        except Exception as exc:
            logger.debug("[stack] add_feedback error: %s", exc)

    # ── Retrain if ready ──────────────────────────────────────────────────────

    def maybe_retrain(self) -> bool:
        now = time.time()
        with self._lock:
            n = len(self._buffer)
            since = now - self._last_train
        if n < MIN_FEEDBACK_ROWS or since < self._retrain_cooldown:
            return False
        return self._retrain()

    def _retrain(self) -> bool:
        try:
            import numpy as np
            from sklearn.linear_model import LogisticRegression
            from sklearn.preprocessing import StandardScaler
            import joblib

            with self._lock:
                snapshot = list(self._buffer)

            X = np.array([row for row, _ in snapshot], dtype=np.float32)
            y = np.array([lbl for _, lbl in snapshot], dtype=np.int32)

            pos_rate = y.mean()
            if pos_rate < 0.01 or pos_rate > 0.99:
                logger.info("[stack] Skipping retrain — degenerate label distribution (pos=%.3f)", pos_rate)
                return False

            scaler = StandardScaler()
            X_scaled = scaler.fit_transform(X)

            model = LogisticRegression(
                C=1.0,
                class_weight="balanced",
                max_iter=500,
                random_state=42,
                solver="lbfgs",
            )
            model.fit(X_scaled, y)

            bundle = {
                "model": model,
                "scaler": scaler,
                "features": STACK_FEATURES,
                "train_count": len(snapshot),
            }
            _STACK_MODEL_PATH.parent.mkdir(parents=True, exist_ok=True)
            joblib.dump(bundle, _STACK_MODEL_PATH)

            with self._lock:
                self._model = (scaler, model)
                self._trained = True
                self._train_count = len(snapshot)
                self._last_train = time.time()

            logger.info("[stack] Retrained on %d rows (pos_rate=%.3f)", len(snapshot), pos_rate)
            return True
        except Exception as exc:
            logger.warning("[stack] Retrain failed: %s", exc)
            return False

    # ── Score ─────────────────────────────────────────────────────────────────

    def score(self, feature_row: dict) -> Optional[float]:
        """
        Return meta-learner probability (0–1) or None if model not yet trained.
        """
        with self._lock:
            if not self._trained or self._model is None:
                return None
            scaler, model = self._model

        try:
            import numpy as np
            vec = np.array(self._dict_to_vec(feature_row), dtype=np.float32).reshape(1, -1)
            vec_scaled = scaler.transform(vec)
            prob = float(model.predict_proba(vec_scaled)[0, 1])
            return round(prob, 4)
        except Exception as exc:
            logger.debug("[stack] score error: %s", exc)
            return None

    # ── Feature vector builder ────────────────────────────────────────────────

    @staticmethod
    def _dict_to_vec(row: dict) -> list[float]:
        return [float(row.get(f, 0.0) or 0.0) for f in STACK_FEATURES]

    def is_trained(self) -> bool:
        return self._trained

    def meta(self) -> dict:
        with self._lock:
            return {
                "trained": self._trained,
                "trainCount": self._train_count,
                "bufferSize": len(self._buffer),
                "minFeedbackRequired": MIN_FEEDBACK_ROWS,
            }


# ── Module-level singleton ────────────────────────────────────────────────────

_learner = StackMetaLearner()


def load_stack() -> bool:
    return _learner.load()


def stack_score(feature_row: dict) -> Optional[float]:
    return _learner.score(feature_row)


def stack_add_feedback(feature_row: dict, outcome: str) -> None:
    _learner.add_feedback(feature_row, outcome)


def stack_maybe_retrain() -> bool:
    return _learner.maybe_retrain()


def get_stack_meta() -> dict:
    return _learner.meta()


def build_stack_features(
    ensemble_result: dict,
    stage2_result: Optional[dict],
    stage3_result: Optional[dict],
    fleet_norm: Optional[dict],
    vehicle_class: str,
) -> dict:
    """
    Build the feature dict that feeds the meta-learner from pipeline outputs.
    Callable after each predict() run to store or score.
    """
    _CLASS_CODE = {
        "passenger_car": 0, "light_duty_truck": 1,
        "cargo_van": 2, "medium_duty": 3, "heavy_duty_j1939": 4,
    }
    comps = ensemble_result.get("components", {})
    fleet_summary = (fleet_norm or {}).get("_summary", {})

    s2_prob = 0.0
    s2_agree = float(ensemble_result.get("signalAgreement", 0.5))
    if stage2_result:
        s2_prob = float(stage2_result.get("stage2_probability", 0.0))
        s2_agree = float(stage2_result.get("signal_agreement", s2_agree))

    s3_converging = 0
    s3_weighted = 0
    if stage3_result:
        s3_converging = int(stage3_result.get("convergingSignals", 0))
        s3_weighted   = int(stage3_result.get("weightedConvergence", 0))

    return {
        "pretrained_score":   float(comps.get("pretrained") or 0.0),
        "if_score":           float(comps.get("isolationForest") or 0.0),
        "welford_score":      float(comps.get("welford") or 0.0),
        "threshold_score":    float(comps.get("threshold") or 0.0),
        "dtc_score":          float(comps.get("dtc") or 0.0),
        "stage2_probability": s2_prob,
        "signal_agreement":   s2_agree,
        "active_signals":     float(comps.get("activeSignals") or 0),
        "converging_signals": float(s3_converging),
        "weighted_convergence": float(s3_weighted),
        "fleet_percentile":   float(fleet_summary.get("fleet_percentile", 0.5)),
        "vehicle_class_code": float(_CLASS_CODE.get(vehicle_class, 0)),
    }
