"""
Phase 5: Conformal prediction for Fleet AI.

Standard calibrated probabilities (IsotonicRegression, Platt scaling) tell you
"this truck has an 82% chance of failure," but they carry no formal guarantee
about how often that claim is correct across the fleet.

Inductive Conformal Prediction (ICP) provides an exact, distribution-free
guarantee:

  At significance level ε (e.g. ε=0.05), the conformal predictor produces a
  prediction set such that the TRUE label is included at least (1-ε) of the
  time — regardless of the underlying data distribution.

For binary classification this means:
  • If conformal_pvalue < ε → alert is "statistically confirmed" at (1-ε) coverage
  • If conformal_pvalue >= ε → insufficient evidence to confirm at that level

The nonconformity score used here is:
  α = 1 - predicted_probability_of_true_class

So α is small for well-calibrated correct predictions and large for
confident-but-wrong predictions.  We fit on a held-out calibration set and
store the sorted nonconformity scores.  At inference, the p-value is:
  p(y=1) = |{α_i ≥ α_new}| / n_calibration

Per-class conformal is also supported: a separate calibration set per vehicle
class allows class-conditional coverage guarantees.

References:
  Vovk, Gammerman, Shafer (2005) — "Algorithmic Learning in a Random World"
  Angelopoulos & Bates (2021)   — "A Gentle Introduction to Conformal Prediction"
"""
from __future__ import annotations

import logging
import threading
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

_MODEL_DIR = Path(__file__).resolve().parents[3] / "fleet_ai" / "models"
_CONFORMAL_PATH = _MODEL_DIR / "conformal_calibration.pkl"

# Default significance level — 5% false alarm rate guarantee
DEFAULT_EPSILON = 0.05

# Minimum calibration samples per class before per-class ICP activates
MIN_CLASS_SAMPLES = 30


class ConformalPredictor:
    """
    Inductive Conformal Predictor (split-conformal variant).

    Calibration is done once on a held-out set (the validation split from
    training).  At inference, only a single pass through the sorted scores
    is needed — O(log n) via bisect.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        # Global scores: sorted list of nonconformity scores (ascending)
        self._scores_global: list[float] = []
        # Per-class scores keyed by vehicle class string
        self._scores_class: dict[str, list[float]] = {}
        self._fitted = False
        self._n_calibration = 0

    # ── Fit from calibration data ─────────────────────────────────────────────

    def fit(
        self,
        cal_probs: list[float],
        cal_labels: list[int],
        cal_classes: list[str] | None = None,
    ) -> None:
        """
        Fit the conformal predictor on a calibration set.

        cal_probs  : predicted probabilities for the POSITIVE class (0-1)
        cal_labels : true binary labels (0 or 1)
        cal_classes: vehicle class string per sample (optional, enables per-class ICP)
        """
        import bisect

        n = len(cal_probs)
        if n < 10:
            logger.warning("[conformal] Too few calibration samples (%d) — skipping fit", n)
            return

        # Nonconformity score for class y: α = 1 - p(y)
        # For the true class: if y=1, α = 1-p_pos; if y=0, α = p_pos
        global_scores = []
        class_scores: dict[str, list[float]] = {}

        for i, (prob, label) in enumerate(zip(cal_probs, cal_labels)):
            alpha = (1.0 - prob) if label == 1 else prob
            global_scores.append(alpha)
            if cal_classes:
                cls = cal_classes[i]
                class_scores.setdefault(cls, []).append(alpha)

        global_scores.sort()
        for cls in class_scores:
            class_scores[cls].sort()

        with self._lock:
            self._scores_global = global_scores
            self._scores_class = {
                cls: scores
                for cls, scores in class_scores.items()
                if len(scores) >= MIN_CLASS_SAMPLES
            }
            self._fitted = True
            self._n_calibration = n

        logger.info(
            "[conformal] Fitted on %d samples, %d class-conditional sets",
            n, len(self._scores_class),
        )

    # ── Inference ─────────────────────────────────────────────────────────────

    def predict(
        self,
        prob_positive: float,
        vehicle_class: str = "",
        epsilon: float = DEFAULT_EPSILON,
    ) -> dict:
        """
        Compute conformal p-values and return a verdict.

        Returns
        -------
        {
          "pvalue":          float (0-1) — conformal p-value for y=1
          "pvalue_null":     float (0-1) — conformal p-value for y=0
          "epsilon":         float — significance level used
          "verdict":         "CONFIRMED" | "REJECTED" | "UNCERTAIN"
          "coverage_guarantee": float — 1 - epsilon
          "calibration_n":   int
          "class_used":      str
        }
        "CONFIRMED" means p(y=1) < ε  → alert is statistically significant
        "REJECTED"  means p(y=0) < ε  → healthy is statistically significant
        "UNCERTAIN" means neither null is rejected (both p-values >= ε)
        """
        with self._lock:
            if not self._fitted:
                return self._not_fitted(epsilon)

            # Prefer class-conditional scores if available
            cls_key = vehicle_class.lower()
            if cls_key and cls_key in self._scores_class:
                scores = self._scores_class[cls_key]
                class_used = cls_key
            else:
                scores = self._scores_global
                class_used = "global"

            n = len(scores)

        # Nonconformity for y=1 prediction: α_new = 1 - prob_positive
        alpha_pos = 1.0 - prob_positive
        # Nonconformity for y=0 prediction: α_new = prob_positive
        alpha_neg = prob_positive

        p_pos = self._pvalue(scores, alpha_pos, n)
        p_neg = self._pvalue(scores, alpha_neg, n)

        if p_pos < epsilon:
            verdict = "CONFIRMED"
        elif p_neg < epsilon:
            verdict = "REJECTED"
        else:
            verdict = "UNCERTAIN"

        return {
            "pvalue":              round(p_pos, 4),
            "pvalue_null":         round(p_neg, 4),
            "epsilon":             epsilon,
            "verdict":             verdict,
            "coverage_guarantee":  round(1.0 - epsilon, 4),
            "calibration_n":       n,
            "class_used":          class_used,
        }

    @staticmethod
    def _pvalue(sorted_scores: list[float], alpha_new: float, n: int) -> float:
        """Fraction of calibration nonconformity scores >= alpha_new."""
        import bisect
        # bisect_left gives index of first score >= alpha_new
        # (since sorted ascending, count from that index to end)
        idx = bisect.bisect_left(sorted_scores, alpha_new)
        return (n - idx + 1) / (n + 1)

    @staticmethod
    def _not_fitted(epsilon: float) -> dict:
        return {
            "pvalue": 0.5,
            "pvalue_null": 0.5,
            "epsilon": epsilon,
            "verdict": "UNCERTAIN",
            "coverage_guarantee": 1.0 - epsilon,
            "calibration_n": 0,
            "class_used": "none",
        }

    # ── Persistence ───────────────────────────────────────────────────────────

    def save(self) -> None:
        import joblib
        with self._lock:
            bundle = {
                "scores_global": self._scores_global,
                "scores_class":  self._scores_class,
                "n_calibration": self._n_calibration,
            }
        _CONFORMAL_PATH.parent.mkdir(parents=True, exist_ok=True)
        joblib.dump(bundle, _CONFORMAL_PATH)
        logger.info("[conformal] Saved to %s", _CONFORMAL_PATH)

    def load(self) -> bool:
        if not _CONFORMAL_PATH.exists():
            return False
        try:
            import joblib
            bundle = joblib.load(_CONFORMAL_PATH)
            with self._lock:
                self._scores_global  = bundle["scores_global"]
                self._scores_class   = bundle.get("scores_class", {})
                self._n_calibration  = bundle.get("n_calibration", len(self._scores_global))
                self._fitted = bool(self._scores_global)
            logger.info("[conformal] Loaded (%d calibration scores)", self._n_calibration)
            return True
        except Exception as exc:
            logger.warning("[conformal] Load failed: %s", exc)
            return False

    def is_fitted(self) -> bool:
        return self._fitted

    def meta(self) -> dict:
        with self._lock:
            return {
                "fitted": self._fitted,
                "calibrationN": self._n_calibration,
                "classConditionalSets": list(self._scores_class.keys()),
                "defaultEpsilon": DEFAULT_EPSILON,
            }


# ── Build calibration data from training bundle ───────────────────────────────

def fit_conformal_from_bundle(model_bundle_path: str | Path) -> bool:
    """
    Fit the module-level conformal predictor using the validation scores
    stored in the training bundle (model_bundle["val_probs"] and ["val_labels"]).

    This is called once after training — not at serve time.
    """
    try:
        import joblib
        bundle = joblib.load(model_bundle_path)
        val_probs  = bundle.get("val_probs")
        val_labels = bundle.get("val_labels")
        val_classes = bundle.get("val_classes")  # optional

        if val_probs is None or val_labels is None:
            logger.warning(
                "[conformal] Bundle at %s has no val_probs/val_labels — "
                "cannot fit conformal predictor. Re-run training with "
                "save_val_scores=True.",
                model_bundle_path,
            )
            return False

        _predictor.fit(
            list(val_probs),
            list(val_labels),
            list(val_classes) if val_classes is not None else None,
        )
        _predictor.save()
        return True
    except Exception as exc:
        logger.warning("[conformal] fit_conformal_from_bundle error: %s", exc)
        return False


# ── Module-level singleton ────────────────────────────────────────────────────

_predictor = ConformalPredictor()


def load_conformal() -> bool:
    return _predictor.load()


def conformal_predict(
    prob_positive: float,
    vehicle_class: str = "",
    epsilon: float = DEFAULT_EPSILON,
) -> dict:
    return _predictor.predict(prob_positive, vehicle_class, epsilon)


def is_conformal_fitted() -> bool:
    return _predictor.is_fitted()


def get_conformal_meta() -> dict:
    return _predictor.meta()
