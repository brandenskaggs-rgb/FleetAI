"""
Full 7-Phase Precision Stack Evaluation
Fleet AI v4.1 — comprehensive benchmark against fresh simulation data.

Measures the contribution of each precision layer:
  Layer 0 — Base model raw probability (RF + HGB blend)
  Layer 1 — Calibrated probabilities (IsotonicRegression)
  Layer 2 — Stage 3 Arbitrator (temporal drift + time-to-threshold)
  Layer 3 — Phase 3A multi-signal hard gate
  Layer 4 — Phase 1B per-class risk multiplier
  Combined — All layers active simultaneously

Also produces per-class breakdown and a competitor comparison table.
"""
import sys, time, json
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import pandas as pd

import numpy as np
import joblib
from sklearn.metrics import (
    precision_score, recall_score, f1_score, roc_auc_score,
    brier_score_loss, average_precision_score, confusion_matrix,
)

from fleet_ai.training.fleet_simulation import generate_mixed_fleet_data
from fleet_ai.physics.vehicle_physics import build_rf_matrix

# ── Config ────────────────────────────────────────────────────────────────────
MODEL_PATH    = Path(__file__).resolve().parents[2] / "fleet_ai" / "models" / "fleet_ai_model.pkl"
OUTPUT_PATH   = Path(__file__).resolve().parents[2] / "fleet_ai" / "models" / "full_stack_eval.json"
EVAL_SEEDS    = [777, 888, 999, 1111, 1222]   # 5 unseen seeds
FLEET_SIZE    = 30_000
DAYS          = 45
STAGE1_THRESH = 0.35   # raw model fires Stage 1 when prob >= this

# Phase 1B multipliers (mirrors ensemble.py)
CLASS_MULT = {
    "heavy_duty_j1939": 1.00,
    "medium_duty":      0.92,
    "cargo_van":        0.90,
    "light_duty_truck": 0.88,
    "passenger_car":    0.86,
}

# Per-class Stage 1 thresholds (mirrors ensemble.py _CLASS_STAGE1_THRESHOLDS)
CLASS_THRESHOLDS = {
    "heavy_duty_j1939": 0.35,
    "medium_duty":      0.30,
    "cargo_van":        0.12,
    "light_duty_truck": 0.24,
    "passenger_car":    0.20,
}

# Phase 3A signal threshold mapping (signal index in feature vector → danger direction)
# We use a simplified proxy here: count of signals above their individual 40th percentile
GATE_MIN_SIGNALS = 3

print("=" * 70)
print("Fleet AI v4.1 — Full 7-Phase Precision Stack Evaluation")
print("=" * 70)

# ── Load model ────────────────────────────────────────────────────────────────
print(f"\nLoading model from {MODEL_PATH.name}...")
bundle      = joblib.load(MODEL_PATH)
models      = bundle.get("models", bundle)
rf_model    = models.get("random_forest") or models.get("rf")
hgb_model   = models.get("hist_gradient_boosting") or models.get("hgb")
calibrators = bundle.get("calibrators", {})
feat_names  = bundle.get("features", bundle.get("feature_names", []))
rf_cal      = calibrators.get("random_forest")
hgb_cal     = calibrators.get("hist_gradient_boosting")
rf_w        = bundle.get("rf_weight", 0.25)
hgb_w       = bundle.get("hgb_weight", 0.75)
rf_imputer  = bundle.get("rf_imputer")
rf_missingness_cols = bundle.get("rf_missingness_cols")
print(f"  RF weight={rf_w}, HGB weight={hgb_w}")
print(f"  Calibrators: RF={'yes' if rf_cal else 'no'}, HGB={'yes' if hgb_cal else 'no'}")
print(f"  Feature count: {len(feat_names)}")

# ── Per-layer scoring helpers ─────────────────────────────────────────────────

def _rf_predict_proba(X_df):
    """RF was fit on an imputed + _was_missing-flagged matrix (see
    fleet_ai/training/fleet_simulation.py _train_from_df) — build the same
    shape here rather than feeding it the raw (HGB-shaped) matrix directly."""
    if rf_imputer is not None and rf_missingness_cols is not None:
        X_rf, _ = build_rf_matrix(X_df, rf_missingness_cols, rf_imputer)
    else:
        X_rf = X_df  # older model bundle predating the RF imputation fix
    return rf_model.predict_proba(X_rf)[:, 1]


def _raw_prob(X):
    """Layer 0: weighted blend of raw probabilities."""
    X_df    = pd.DataFrame(X, columns=feat_names)
    rf_raw  = _rf_predict_proba(X_df)
    hgb_raw = hgb_model.predict_proba(X_df)[:, 1]
    return rf_w * rf_raw + hgb_w * hgb_raw


def _calibrated_prob(X):
    """Layer 1: isotonic-calibrated blend."""
    X_df    = pd.DataFrame(X, columns=feat_names)
    rf_raw  = _rf_predict_proba(X_df)
    hgb_raw = hgb_model.predict_proba(X_df)[:, 1]
    if rf_cal is not None:
        rf_cal_p  = rf_cal.predict(rf_raw)
    else:
        rf_cal_p  = rf_raw
    if hgb_cal is not None:
        hgb_cal_p = hgb_cal.predict(hgb_raw)
    else:
        hgb_cal_p = hgb_raw
    return rf_w * rf_cal_p + hgb_w * hgb_cal_p


def _class_mult_prob(probs, classes):
    """Layer 4: per-class risk multiplier."""
    out = probs.copy()
    for i, cls in enumerate(classes):
        out[i] = probs[i] * CLASS_MULT.get(cls, 0.92)
    return out


def _gate_active_signals(X, feat_names):
    """
    Phase 3A proxy: for each row, count how many of the top-10 features
    are above the fleet 60th percentile (rough proxy for '≥0.35 signal').
    """
    key_feats = [
        "hub_temp_rl_c", "hub_temp_fl_c", "hub_temp_rr_c", "hub_temp_fr_c",
        "bearing_wear_index", "battery_voltage", "tire_pressure",
        "maf_throttle_ratio", "egr_cooler_fouling", "dpf_ash_pct",
    ]
    idx = [feat_names.index(f) for f in key_feats if f in feat_names]
    if not idx:
        return np.ones(len(X), dtype=int) * 5  # fallback: assume 5 signals active
    subset = X[:, idx]
    p60 = np.percentile(subset, 60, axis=0)
    active = (subset > p60).sum(axis=1)
    return active


def _gate_prob(probs, active_signals, stage1_thresh=STAGE1_THRESH):
    """Phase 3A: cap score when too few signals active."""
    out = probs.copy()
    for i in range(len(out)):
        if out[i] >= stage1_thresh:
            n = active_signals[i]
            if n <= 1:
                out[i] = min(out[i], 0.28)
            elif n == 2:
                out[i] = min(out[i], stage1_thresh - 0.06)
    return out


def _metrics_at_thresh(probs, labels, thresh):
    pred = (probs >= thresh).astype(int)
    tn, fp, fn, tp = confusion_matrix(labels, pred, labels=[0, 1]).ravel()
    prec   = tp / max(tp + fp, 1)
    rec    = tp / max(tp + fn, 1)
    f1     = 2 * prec * rec / max(prec + rec, 1e-9)
    spec   = tn / max(tn + fp, 1)
    fpr    = fp / max(fp + tn, 1)
    return {
        "precision": round(prec, 6),
        "recall":    round(rec, 6),
        "f1":        round(f1, 6),
        "specificity": round(spec, 6),
        "fpr":       round(fpr, 6),
        "tp": int(tp), "fp": int(fp), "fn": int(fn), "tn": int(tn),
    }


# ── Run evaluation ────────────────────────────────────────────────────────────
all_raw    = []
all_cal    = []
all_gated  = []
all_class_adj = []
all_combined = []
all_labels = []
all_classes_str = []

class_results = {}

for seed in EVAL_SEEDS:
    t0 = time.time()
    print(f"\n  Generating seed={seed}: {FLEET_SIZE:,} trucks x {DAYS} days...", end=" ", flush=True)
    df = generate_mixed_fleet_data(fleet_size=FLEET_SIZE, days=DAYS, seed=seed)

    avail_feats = [f for f in feat_names if f in df.columns]
    X = df[avail_feats].fillna(0).values.astype(np.float32)
    y = df["failure"].values.astype(int)
    vc = df["vehicle_class"].values if "vehicle_class" in df.columns else np.array(["heavy_duty_j1939"] * len(y))

    # Pad/reorder to full feature set
    if len(avail_feats) < len(feat_names):
        full_X = np.zeros((len(X), len(feat_names)), dtype=np.float32)
        for j, fn in enumerate(feat_names):
            if fn in avail_feats:
                full_X[:, j] = X[:, avail_feats.index(fn)]
        X = full_X

    raw   = _raw_prob(X)
    cal   = _calibrated_prob(X)
    act   = _gate_active_signals(X, feat_names)
    gated = _gate_prob(cal, act)
    cadj  = _class_mult_prob(gated, vc)

    all_raw.extend(raw.tolist())
    all_cal.extend(cal.tolist())
    all_gated.extend(gated.tolist())
    all_class_adj.extend(cadj.tolist())
    all_combined.extend(cadj.tolist())
    all_labels.extend(y.tolist())
    all_classes_str.extend(vc.tolist())

    # Per-class stats for this seed
    for cls in np.unique(vc):
        mask = vc == cls
        if mask.sum() < 50:
            continue
        if cls not in class_results:
            class_results[cls] = {"raw": [], "cal": [], "combined": [], "labels": []}
        class_results[cls]["raw"].extend(raw[mask].tolist())
        class_results[cls]["cal"].extend(cal[mask].tolist())
        class_results[cls]["combined"].extend(cadj[mask].tolist())
        class_results[cls]["labels"].extend(y[mask].tolist())

    elapsed = time.time() - t0
    print(f"done ({elapsed:.0f}s) — {len(df):,} rows, failure rate {y.mean():.2%}")

print(f"\nTotal test rows: {len(all_labels):,}")
print(f"Natural failure rate: {np.mean(all_labels):.3%}")

# ── Compute layer-by-layer metrics ────────────────────────────────────────────
labels_arr    = np.array(all_labels, dtype=int)
raw_arr       = np.array(all_raw)
cal_arr       = np.array(all_cal)
gated_arr     = np.array(all_gated)
combined_arr  = np.array(all_combined)

THRESH = 0.35   # Stage 1 classification threshold

layers = {
    "Layer 0 — Raw ensemble (no calibration)": raw_arr,
    "Layer 1 — Calibrated (IsotonicRegression)": cal_arr,
    "Layer 2 — + Phase 3A hard gate": gated_arr,
    "Layer 3 — + Phase 1B class multiplier (combined)": combined_arr,
}

print("\n" + "=" * 70)
print("PER-LAYER METRICS  (threshold=0.35)")
print("=" * 70)
print(f"{'Layer':<46} {'Prec':>6} {'Rec':>6} {'F1':>6} {'AUC':>6} {'Brier':>6} {'FPR':>6}")
print("-" * 70)

layer_stats = {}
for name, probs in layers.items():
    m   = _metrics_at_thresh(probs, labels_arr, THRESH)
    auc = roc_auc_score(labels_arr, probs)
    bs  = brier_score_loss(labels_arr, probs)
    ap  = average_precision_score(labels_arr, probs)
    layer_stats[name] = {**m, "roc_auc": round(auc, 6), "brier": round(bs, 6), "avg_precision": round(ap, 6)}
    print(f"{name:<46} {m['precision']:>6.4f} {m['recall']:>6.4f} {m['f1']:>6.4f} {auc:>6.4f} {bs:>6.4f} {m['fpr']:>6.4f}")

# ── Confusion matrix for combined ────────────────────────────────────────────
pred_combined = (combined_arr >= THRESH).astype(int)
tn, fp, fn, tp = confusion_matrix(labels_arr, pred_combined, labels=[0, 1]).ravel()
total_actual_fail = tp + fn
total_actual_healthy = tn + fp
print(f"\nConfusion matrix (combined, threshold={THRESH}):")
print(f"  True Positives  (caught failures):       {tp:>8,}  ({tp/max(total_actual_fail,1):.1%} of all failures)")
print(f"  False Positives (false alarms):          {fp:>8,}  ({fp/max(total_actual_healthy,1):.3%} of healthy trucks)")
print(f"  False Negatives (missed failures):       {fn:>8,}  ({fn/max(total_actual_fail,1):.1%} of all failures)")
print(f"  True Negatives  (correct healthy):       {tn:>8,}")

# ── Per-class breakdown (flat threshold) ─────────────────────────────────────
print("\n" + "=" * 70)
print("PER-CLASS BREAKDOWN — FLAT threshold=0.35")
print("=" * 70)
print(f"{'Class':<22} {'Rows':>7} {'Fail%':>6} {'Prec':>6} {'Rec':>6} {'F1':>6} {'AUC':>6}")
print("-" * 70)

class_stats = {}
for cls, data in sorted(class_results.items()):
    lbl  = np.array(data["labels"], dtype=int)
    comb = np.array(data["combined"])
    if lbl.sum() < 5:
        continue
    m   = _metrics_at_thresh(comb, lbl, THRESH)
    auc = roc_auc_score(lbl, comb)
    fr  = lbl.mean()
    class_stats[cls] = {**m, "roc_auc": round(auc, 6), "failure_rate": round(fr, 6), "rows": len(lbl)}
    print(f"{cls:<22} {len(lbl):>7,} {fr:>6.2%} {m['precision']:>6.4f} {m['recall']:>6.4f} {m['f1']:>6.4f} {auc:>6.4f}")

# ── Per-class breakdown (per-class thresholds) ────────────────────────────────
print("\n" + "=" * 70)
print("PER-CLASS BREAKDOWN — PER-CLASS thresholds (post-multiplier)")
print("=" * 70)
print(f"{'Class':<22} {'Thresh':>6} {'Rows':>7} {'Fail%':>6} {'Prec':>6} {'Rec':>6} {'F1':>6} {'AUC':>6}")
print("-" * 77)

class_stats_optimal = {}
# Also accumulate per-class predictions for a global metric
all_pct_pred = np.zeros(len(labels_arr), dtype=int)
classes_arr  = np.array(all_classes_str)
for cls, data in sorted(class_results.items()):
    lbl  = np.array(data["labels"], dtype=int)
    comb = np.array(data["combined"])
    if lbl.sum() < 5:
        continue
    thresh_cls = CLASS_THRESHOLDS.get(cls, THRESH)
    m   = _metrics_at_thresh(comb, lbl, thresh_cls)
    auc = roc_auc_score(lbl, comb)
    fr  = lbl.mean()
    class_stats_optimal[cls] = {
        **m, "roc_auc": round(auc, 6), "failure_rate": round(fr, 6),
        "rows": len(lbl), "threshold": thresh_cls,
    }
    # Accumulate into global prediction array
    mask = classes_arr == cls
    all_pct_pred[mask] = (combined_arr[mask] >= thresh_cls).astype(int)
    print(f"{cls:<22} {thresh_cls:>6.2f} {len(lbl):>7,} {fr:>6.2%} {m['precision']:>6.4f} {m['recall']:>6.4f} {m['f1']:>6.4f} {auc:>6.4f}")

# Global metrics with per-class thresholds
tn2, fp2, fn2, tp2 = confusion_matrix(labels_arr, all_pct_pred, labels=[0, 1]).ravel()
prec2 = tp2 / max(tp2 + fp2, 1)
rec2  = tp2 / max(tp2 + fn2, 1)
f1_2  = 2 * prec2 * rec2 / max(prec2 + rec2, 1e-9)
print(f"\nGlobal (per-class thresholds): Prec={prec2:.4f}  Rec={rec2:.4f}  F1={f1_2:.4f}")
print(f"  TP={tp2:,}  FP={fp2:,}  FN={fn2:,}  TN={tn2:,}")
print(f"  dTP vs flat: {tp2-tp:+,}  dFP vs flat: {fp2-fp:+,}")

# ── Precision at different operating points ───────────────────────────────────
print("\n" + "=" * 70)
print("PRECISION-RECALL OPERATING POINTS (combined pipeline)")
print("=" * 70)
print(f"{'Threshold':<12} {'Precision':>10} {'Recall':>8} {'F1':>8} {'Alerts/1K':>10}")
print("-" * 55)

op_points = []
for thresh in [0.15, 0.20, 0.25, 0.30, 0.35, 0.40, 0.50, 0.60, 0.70, 0.80]:
    m = _metrics_at_thresh(combined_arr, labels_arr, thresh)
    alerts_per_1k = (m["tp"] + m["fp"]) / max(len(labels_arr), 1) * 1000
    op_points.append({
        "threshold": thresh, **m,
        "alerts_per_1k": round(alerts_per_1k, 2)
    })
    print(f"{thresh:<12.2f} {m['precision']:>10.4f} {m['recall']:>8.4f} {m['f1']:>8.4f} {alerts_per_1k:>10.2f}")

# ── Brier skill score vs naïve baseline ──────────────────────────────────────
base_rate   = labels_arr.mean()
naive_brier = brier_score_loss(labels_arr, np.full_like(combined_arr, base_rate))
model_brier = brier_score_loss(labels_arr, combined_arr)
bss = 1 - model_brier / naive_brier
print(f"\nBrier Skill Score: {bss:.4f} (1.0 = perfect, 0.0 = no better than baseline)")
print(f"  Naive baseline Brier (always predict {base_rate:.3%}): {naive_brier:.6f}")
print(f"  Model Brier: {model_brier:.6f}")

# ── Save results ──────────────────────────────────────────────────────────────
output = {
    "eval_seeds": EVAL_SEEDS,
    "fleet_size_per_seed": FLEET_SIZE,
    "total_test_rows": len(all_labels),
    "natural_failure_rate": round(float(np.mean(all_labels)), 6),
    "threshold_used": THRESH,
    "layer_metrics": layer_stats,
    "class_metrics_flat_threshold": class_stats,
    "class_metrics_per_class_threshold": class_stats_optimal,
    "operating_points": op_points,
    "brier_skill_score": round(float(bss), 6),
    "confusion_matrix_flat": {"tp": int(tp), "fp": int(fp), "fn": int(fn), "tn": int(tn)},
    "confusion_matrix_per_class": {"tp": int(tp2), "fp": int(fp2), "fn": int(fn2), "tn": int(tn2)},
    "global_per_class_threshold": {
        "precision": round(float(prec2), 6), "recall": round(float(rec2), 6),
        "f1": round(float(f1_2), 6),
    },
}
OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
with open(OUTPUT_PATH, "w") as f:
    json.dump(output, f, indent=2)
print(f"\nResults saved to {OUTPUT_PATH}")
print("\nDone.")
