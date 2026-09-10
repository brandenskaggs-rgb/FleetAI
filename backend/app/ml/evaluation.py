"""Leakage-resistant partitions and explicitly labeled evaluation evidence."""
from __future__ import annotations
import hashlib
import numpy as np
import pandas as pd
from sklearn.metrics import (precision_score, recall_score, f1_score, roc_auc_score,
                             average_precision_score, confusion_matrix, brier_score_loss, log_loss)
from .feature_contract import json_safe


def partition(frame, group="vehicle_id", time="timestamp", seed=42, chronological=True):
    """Disjoint vehicles; chronological holdouts also have strict time bounds.

    Rows outside their assigned group's time block are purged, not recycled.
    Use a separate within-vehicle forward study if that deployment question is
    desired; it must not be presented as unseen-vehicle generalization.
    """
    if frame[group].isna().any():
        raise ValueError("Every example requires a known vehicle group")
    groups = np.array(sorted(frame[group].unique()))
    if len(groups) < 5:
        raise ValueError("At least five independent vehicle groups are required")
    np.random.default_rng(seed).shuffle(groups)
    a, b = max(1, int(len(groups)*.6)), max(2, int(len(groups)*.8))
    sets = [set(groups[:a]), set(groups[a:b]), set(groups[b:])]
    masks = [frame[group].isin(s) for s in sets]
    if chronological:
        ts = pd.to_datetime(frame[time], utc=True, errors="raise")
        if ts.isna().any():
            raise ValueError("Every example requires an observed timestamp")
        c1, c2 = ts.quantile(.6), ts.quantile(.8)
        masks = [masks[0] & (ts <= c1), masks[1] & (ts > c1) & (ts <= c2), masks[2] & (ts > c2)]
    parts = tuple(frame.loc[m].copy() for m in masks)
    if any(p.empty for p in parts):
        raise ValueError("Insufficient history for independent train/validation/test partitions")
    return parts


def binary_labels(values):
    y = np.asarray(values)
    if not np.isin(y, [0, 1]).all():
        raise ValueError("Only confirmed binary outcome labels are accepted")
    return y.astype(int)


def metrics(labels, probabilities, threshold=.5, source="unknown", lead_times=None):
    y = binary_labels(labels)
    prob = np.asarray(probabilities, dtype=float)
    if len(y) == 0 or len(y) != len(prob) or not np.isfinite(prob).all() or ((prob < 0) | (prob > 1)).any():
        raise ValueError("Invalid evaluation probabilities")
    pred = prob >= threshold
    tn, fp, fn, tp = confusion_matrix(y, pred, labels=[0, 1]).ravel()
    both = len(np.unique(y)) == 2
    bins = np.minimum((prob * 10).astype(int), 9)
    ece = sum((bins == b).mean() * abs(prob[bins == b].mean() - y[bins == b].mean())
              for b in range(10) if (bins == b).any())
    lead = np.asarray(lead_times, dtype=float) if lead_times is not None else None
    if lead is not None and len(lead) != len(y):
        raise ValueError("Lead times must align with evaluation examples")
    useful = lead[(y == 1) & pred & np.isfinite(lead) & (lead > 0)] if lead is not None else []
    return json_safe({"evidenceSource": source, "rows": len(y), "threshold": threshold,
        "precision": float(precision_score(y, pred, zero_division=0)),
        "recall": float(recall_score(y, pred, zero_division=0)), "f1": float(f1_score(y, pred, zero_division=0)),
        "roc_auc": float(roc_auc_score(y, prob)) if both else None,
        "pr_auc": float(average_precision_score(y, prob)) if both else None,
        "false_positive_rate": float(fp/(fp+tn)) if fp+tn else None,
        "confusion_matrix": dict(tn=int(tn), fp=int(fp), fn=int(fn), tp=int(tp)),
        "brier_score": float(brier_score_loss(y, prob)), "ece_10_bins": float(ece),
        "log_loss": float(log_loss(y, prob, labels=[0,1])),
        "useful_lead_time_hours_median": float(np.median(useful)) if len(useful) else None,
        "lead_time_status": "confirmed_events_only" if len(useful) else "not_assessed_no_confirmed_event_times"})


def fit_calibration(labels, probabilities, source, model_version):
    """An independent calibration subset only; test examples must never enter.

    Small datasets stay explicitly uncalibrated. Synthetic calibration is not
    field validation. Returns serializable model-bound calibration evidence.
    """
    from sklearn.isotonic import IsotonicRegression
    y = binary_labels(labels)
    p = np.asarray(probabilities, dtype=float)
    if len(p) != len(y) or not np.isfinite(p).all() or ((p < 0) | (p > 1)).any():
        raise ValueError("Invalid calibration probabilities")
    meta = {"status": "uncalibrated", "source": source, "modelVersion": model_version,
            "rows": len(y), "fieldValidated": False}
    if len(y) < 200 or min((y == 0).sum(), (y == 1).sum()) < 30:
        meta["reason"] = "insufficient_independent_labeled_calibration_data"
        return None, meta
    if not np.isfinite(p).all():
        raise ValueError("Nonfinite calibration inputs")
    calibration = IsotonicRegression(out_of_bounds="clip").fit(p, y)
    meta.update(status="calibrated", method="isotonic", scope="synthetic_only" if source.startswith("synthetic") else "heldout_labeled_data")
    meta["dataFingerprint"] = hashlib.sha256(np.column_stack([y,p]).tobytes()).hexdigest()
    return calibration, meta
