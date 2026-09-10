"""
Per-vehicle Isolation Forest anomaly detector for Fleet AI.
Trains on historical telemetry feature rows and scores new observations.
Serializes/deserializes the fitted model as base64-encoded joblib bytes
so it can be stored in the ModelState PostgreSQL table.
"""
from __future__ import annotations
import base64
import io
import logging
import time
from typing import Optional

import numpy as np
from sklearn.ensemble import IsolationForest
from sklearn.impute import SimpleImputer
import joblib

from .features import METRIC_KEYS, build_numpy_feature_row
from .feature_contract import manifest

logger = logging.getLogger(__name__)

# Minimum samples before we bother training a model
MIN_TRAIN_SAMPLES = 50

# Retrain if model was last trained more than this many seconds ago
RETRAIN_INTERVAL_SECS = 86_400  # 24 h

# Feature keys used as IF input columns (subset of flat feature vector)
IF_FEATURE_KEYS: list[str] = []
for _k in METRIC_KEYS:
    IF_FEATURE_KEYS.append(f"{_k}_mean_all")
    IF_FEATURE_KEYS.append(f"{_k}_std_all")
    IF_FEATURE_KEYS.append(f"{_k}_slope_all")
    IF_FEATURE_KEYS.append(f"{_k}_mean_h24")
    IF_FEATURE_KEYS.append(f"{_k}_slope_h24")
    IF_FEATURE_KEYS.append(f"{_k}_current")

IF_FEATURE_KEYS += [
    "duty_cycle",
    "sample_density",
    "cooling_stress",
    "charging_stress",
    "fuel_stress",
]


class VehicleIsolationForest:
    """
    Wraps sklearn IsolationForest with:
      - fit() from a list of feature dicts
      - score() returning anomaly_score in [0, 1] (1 = most anomalous)
      - serialize() / deserialize() for PostgreSQL persistence
    """

    def __init__(self) -> None:
        self._model: Optional[IsolationForest] = None
        self._imputer = None
        self._trained_at: Optional[float] = None  # unix timestamp
        self._train_sample_count: int = 0

    # ── Training ──────────────────────────────────────────────────────────────

    def fit(self, flat_dicts: list[dict]) -> bool:
        """
        Train on a list of flat feature dicts (from features.extract_features()).
        Returns True on success.
        """
        if len(flat_dicts) < MIN_TRAIN_SAMPLES:
            logger.debug(f"[IF] not enough samples to train ({len(flat_dicts)} < {MIN_TRAIN_SAMPLES})")
            return False

        X = self._build_matrix(flat_dicts)
        if X is None or X.shape[0] < MIN_TRAIN_SAMPLES:
            return False

        try:
            model = IsolationForest(
                n_estimators=200,
                max_samples="auto",
                contamination=0.05,  # expect ~5% anomalous readings
                random_state=42,
                n_jobs=-1,
            )
            imputer = SimpleImputer(strategy="median", add_indicator=True, keep_empty_features=True)
            model.fit(imputer.fit_transform(X))
            self._model = model
            self._imputer = imputer
            self._trained_at = time.time()
            self._train_sample_count = X.shape[0]
            logger.info(f"[IF] trained on {X.shape[0]} samples")
            return True
        except Exception as exc:
            logger.warning(f"[IF] training failed: {exc}")
            return False

    # ── Scoring ───────────────────────────────────────────────────────────────

    def score(self, flat: dict) -> Optional[float]:
        """
        Return anomaly score in [0, 1].
        sklearn decision_function returns negative scores for anomalies;
        we invert and normalize to [0, 1].
        """
        if self._model is None:
            return None
        try:
            row = build_numpy_feature_row(flat, IF_FEATURE_KEYS).reshape(1, -1)
            if self._imputer is not None:
                row = self._imputer.transform(row)
            elif not np.isfinite(row).all():
                return None
            raw = self._model.decision_function(row)[0]
            # decision_function: more negative = more anomalous
            # Typical range is roughly [-0.5, 0.5]; we map to [0, 1]
            score = 1.0 - (raw + 0.5)
            return round(float(np.clip(score, 0.0, 1.0)), 4)
        except Exception as exc:
            logger.debug(f"[IF] scoring failed: {exc}")
            return None

    def predict_label(self, flat: dict) -> str:
        """Returns 'anomaly' or 'normal' from the IF classifier."""
        if self._model is None:
            return "unknown"
        try:
            row = build_numpy_feature_row(flat, IF_FEATURE_KEYS).reshape(1, -1)
            if self._imputer is not None:
                row = self._imputer.transform(row)
            elif not np.isfinite(row).all():
                return "unknown"
            label = self._model.predict(row)[0]  # +1 = normal, -1 = anomaly
            return "anomaly" if label == -1 else "normal"
        except Exception:
            return "unknown"

    # ── Serialization ─────────────────────────────────────────────────────────

    def serialize(self) -> Optional[str]:
        """Return base64-encoded joblib bytes, or None if untrained."""
        if self._model is None:
            return None
        try:
            buf = io.BytesIO()
            joblib.dump({"model": self._model, "imputer": self._imputer, "features": IF_FEATURE_KEYS}, buf)
            return base64.b64encode(buf.getvalue()).decode("ascii")
        except Exception as exc:
            logger.warning(f"[IF] serialize failed: {exc}")
            return None

    def to_state_dict(self) -> dict:
        return {
            "model_b64": self.serialize(),
            "trained_at": self._trained_at,
            "train_sample_count": self._train_sample_count,
            "feature_keys": IF_FEATURE_KEYS,
            "feature_schema": manifest(IF_FEATURE_KEYS),
        }

    @classmethod
    def from_state_dict(cls, state: dict) -> "VehicleIsolationForest":
        obj = cls()
        model_b64 = state.get("model_b64")
        if state.get("feature_schema") is not None and state["feature_schema"] != manifest(IF_FEATURE_KEYS):
            return obj
        if model_b64:
            try:
                buf = io.BytesIO(base64.b64decode(model_b64))
                loaded = joblib.load(buf)
                if state.get("feature_keys") != IF_FEATURE_KEYS:
                    return obj
                if isinstance(loaded, dict):
                    if loaded.get("features") != IF_FEATURE_KEYS:
                        return obj
                    obj._model = loaded["model"]
                    obj._imputer = loaded.get("imputer")
                else:
                    obj._model = loaded
                obj._trained_at = state.get("trained_at")
                obj._train_sample_count = state.get("train_sample_count", 0)
            except Exception as exc:
                logger.warning(f"[IF] deserialize failed: {exc}")
        return obj

    # ── Lifecycle helpers ─────────────────────────────────────────────────────

    def is_trained(self) -> bool:
        return self._model is not None

    def needs_retraining(self) -> bool:
        if not self.is_trained():
            return True
        if self._trained_at is None:
            return True
        return (time.time() - self._trained_at) > RETRAIN_INTERVAL_SECS

    def age_hours(self) -> Optional[float]:
        if self._trained_at is None:
            return None
        return round((time.time() - self._trained_at) / 3600, 1)

    # ── Internal ──────────────────────────────────────────────────────────────

    def _build_matrix(self, flat_dicts: list[dict]) -> Optional[np.ndarray]:
        rows = []
        for fd in flat_dicts:
            row = build_numpy_feature_row(fd, IF_FEATURE_KEYS)
            rows.append(row)
        if not rows:
            return None
        return np.vstack(rows)
