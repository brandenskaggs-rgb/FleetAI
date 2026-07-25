"""
Stage 3 Temporal Arbitrator — Sequential Evaluation (fast version)

Strategy:
  1. Generate fleet data and BATCH-score all rows at once (vectorized)
  2. Store pre-computed scores + signal values per vehicle
  3. Walk each vehicle's 45-day sequence using cached scores
  4. Run Stage 3 only when a day's score hits the borderline zone [0.30, 0.70]
  5. Compare global metrics before vs. after Stage 3 at vehicle level
"""
import sys, time, json, collections, warnings
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

warnings.filterwarnings("ignore")

import numpy as np
import pandas as pd
import joblib
from sklearn.metrics import (
    precision_score, recall_score, f1_score, roc_auc_score,
    brier_score_loss, confusion_matrix,
)

from fleet_ai.training.fleet_simulation import generate_mixed_fleet_data
from fleet_ai.physics.vehicle_physics import build_rf_matrix
from backend.app.ml.stage3 import Stage3Arbitrator, TemporalBuffer, STAGE3_LOW, STAGE3_HIGH

MODEL_PATH  = Path(__file__).resolve().parents[2] / "fleet_ai" / "models" / "fleet_ai_model.pkl"
OUTPUT_PATH = Path(__file__).resolve().parents[2] / "fleet_ai" / "models" / "stage3_eval.json"
EVAL_SEEDS  = [777, 888, 999]
FLEET_SIZE  = 10_000
DAYS        = 45
THRESH      = 0.35

CLASS_MULT = {
    "heavy_duty_j1939": 1.00,
    "medium_duty":      0.92,
    "cargo_van":        0.90,
    "light_duty_truck": 0.88,
    "passenger_car":    0.86,
}

# Simulation column → Stage 3 signal name mapping
SIM_TO_S3 = {
    "hub_temp_fl_c":   "hubTempFL",
    "hub_temp_fr_c":   "hubTempFR",
    "hub_temp_rl_c":   "hubTempRL",
    "hub_temp_rr_c":   "hubTempRR",
    "engine_temp":     "coolantTemp",
    "oil_temp":        "oilTemp",
    "battery_voltage": "batteryVoltage",
    "dpf_soot_load":   "dpfSootLoad",
    "vibration":       "bearingFreqScore",
    "egr_flow_rate":   "egrCoolerDelta",
}

print("=" * 70)
print("Fleet AI v4.1 — Stage 3 Sequential Evaluation (batch-score optimised)")
print("=" * 70)

# ── Load model ────────────────────────────────────────────────────────────────
bundle    = joblib.load(MODEL_PATH)
models    = bundle.get("models", bundle)
rf_model  = models.get("random_forest") or models.get("rf")
hgb_model = models.get("hist_gradient_boosting") or models.get("hgb")
cals      = bundle.get("calibrators", {})
feat_names = bundle.get("features", [])
rf_cal    = cals.get("random_forest")
hgb_cal   = cals.get("hist_gradient_boosting")
rf_w      = bundle.get("rf_weight", 0.25)
hgb_w     = bundle.get("hgb_weight", 0.75)
rf_imputer = bundle.get("rf_imputer")
rf_missingness_cols = bundle.get("rf_missingness_cols")
print(f"Loaded: {len(feat_names)} features, RF_w={rf_w}, HGB_w={hgb_w}")


def _batch_calibrated(X: np.ndarray) -> np.ndarray:
    # RF was fit on an imputed + _was_missing-flagged matrix (see
    # fleet_ai/training/fleet_simulation.py _train_from_df) — X here is the
    # plain HGB-shaped array, so build RF's matrix separately from it.
    if rf_imputer is not None and rf_missingness_cols is not None:
        X_rf, _ = build_rf_matrix(pd.DataFrame(X, columns=feat_names), rf_missingness_cols, rf_imputer)
    else:
        X_rf = X  # older model bundle predating the RF imputation fix
    rf_raw  = rf_model.predict_proba(X_rf)[:, 1]
    hgb_raw = hgb_model.predict_proba(X)[:, 1]
    rf_p    = rf_cal.predict(rf_raw)  if rf_cal  else rf_raw
    hgb_p   = hgb_cal.predict(hgb_raw) if hgb_cal else hgb_raw
    return (rf_w * rf_p + hgb_w * hgb_p).astype(np.float32)


def _gate_batch(scores: np.ndarray, X: np.ndarray) -> np.ndarray:
    """Phase 3A gate applied in batch."""
    hub_cols = [feat_names.index(f) for f in
                ["hub_temp_fl_c","hub_temp_fr_c","hub_temp_rl_c","hub_temp_rr_c"]
                if f in feat_names]
    out = scores.copy()
    if not hub_cols:
        return out
    hub_hot = (X[:, hub_cols] > 60.0).sum(axis=1)  # count elevated hub temps
    extra_active = np.zeros(len(X), dtype=int)
    for fn, thr, below in [("battery_voltage",11.8,True),("vibration",0.3,False),("dpf_soot_load",60,False)]:
        if fn in feat_names:
            v = X[:, feat_names.index(fn)]
            extra_active += (v < thr).astype(int) if below else (v > thr).astype(int)
    active = hub_hot + extra_active
    firing = out >= THRESH
    cap1   = firing & (active <= 1)
    cap2   = firing & (active == 2)
    out[cap1] = np.minimum(out[cap1], 0.28)
    out[cap2] = np.minimum(out[cap2], THRESH - 0.06)
    return out


def _build_metrics(labels, probs, thresh):
    p = (np.array(probs) >= thresh).astype(int)
    l = np.array(labels, dtype=int)
    tn, fp, fn, tp = confusion_matrix(l, p, labels=[0,1]).ravel()
    prec = tp / max(tp+fp, 1)
    rec  = tp / max(tp+fn, 1)
    f1   = 2*prec*rec / max(prec+rec, 1e-9)
    return {
        "precision": round(prec,6), "recall": round(rec,6), "f1": round(f1,6),
        "tp": int(tp), "fp": int(fp), "fn": int(fn), "tn": int(tn),
        "fpr": round(fp/max(tn+fp,1),6),
    }


# ── Accumulators ──────────────────────────────────────────────────────────────
all_labels   = []
all_pre      = []   # peak pipeline score before Stage 3
all_post     = []   # peak score after Stage 3
all_classes  = []

s3_verdicts  = collections.Counter()
s3_correct   = {"CONFIRM": {"tp":0,"fp":0}, "CLEAR": {"tp":0,"fp":0}, "DEFER": {"tp":0,"fp":0}}
s3_total_invocations = 0

# ── Per-seed loop ─────────────────────────────────────────────────────────────
for seed in EVAL_SEEDS:
    t0 = time.time()
    print(f"\nSeed {seed}: generating {FLEET_SIZE:,} trucks x {DAYS} days...", end=" ", flush=True)
    df = generate_mixed_fleet_data(fleet_size=FLEET_SIZE, days=DAYS, seed=seed)
    df = df.reset_index(drop=True)

    # Build full feature matrix (batch)
    full_X = np.zeros((len(df), len(feat_names)), dtype=np.float32)
    for j, fn in enumerate(feat_names):
        if fn in df.columns:
            full_X[:, j] = df[fn].fillna(0).values

    print(f"scoring {len(df):,} rows...", end=" ", flush=True)
    cal_scores  = _batch_calibrated(full_X)
    gated_scores = _gate_batch(cal_scores, full_X)

    # Apply class multiplier per row
    adj_scores = gated_scores.copy()
    for i, cls in enumerate(df["vehicle_class"].values):
        adj_scores[i] *= CLASS_MULT.get(cls, 0.92)
    adj_scores = np.clip(adj_scores, 0.0, 1.0).astype(np.float32)

    # Store signal values for Stage 3 (only columns we need)
    s3_cols = {s3_name: (sim_col if sim_col in df.columns else None)
               for sim_col, s3_name in SIM_TO_S3.items()}

    print(f"Stage 3 sequential pass...", end=" ", flush=True)

    # Fresh arbitrator per seed
    arb    = Stage3Arbitrator()
    buf    = TemporalBuffer()

    # Group by vehicle — preserve original row order (= day sequence)
    veh_groups = df.groupby("vehicle_id", sort=False).indices  # {vid: array of row indices}

    n_veh = 0
    for vehicle_id, row_indices in veh_groups.items():
        n_veh += 1
        rows_sorted = sorted(row_indices)  # day 0 → day 44
        true_label  = int(df.iloc[rows_sorted]["failure"].max())
        vehicle_cls = df.iloc[rows_sorted[0]]["vehicle_class"]

        peak_pre  = float(np.max(adj_scores[rows_sorted]))
        peak_post = peak_pre
        s3_fired  = False
        s3_verdict_final = None

        for day_idx, row_idx in enumerate(rows_sorted):
            score  = float(adj_scores[row_idx])
            ts_day = float(seed * 10000 + n_veh + day_idx * 0.1)

            # Build current_metrics dict for Stage 3
            current_metrics: dict[str, float] = {}
            for s3_name, sim_col in s3_cols.items():
                if sim_col and sim_col in df.columns:
                    v = float(df[sim_col].iloc[row_idx])
                    if not np.isnan(v):
                        current_metrics[s3_name] = v

            # Normalise vibration proxy to 0-1
            if "bearingFreqScore" in current_metrics:
                current_metrics["bearingFreqScore"] = min(1.0, current_metrics["bearingFreqScore"] / 2.0)

            # Feed into Stage 3 buffer
            Stage3Arbitrator._ingest(vehicle_id, current_metrics, ts_day)

            # Fire Stage 3 only in the borderline zone
            if STAGE3_LOW <= score <= STAGE3_HIGH:
                s3_total_invocations += 1
                result = arb.evaluate(
                    vehicle_id=vehicle_id,
                    stage2_score=score,
                    current_metrics=current_metrics,
                    timestamp=ts_day * 86400.0,
                )
                if result:
                    verdict = result["verdict"]
                    s3_verdicts[verdict] += 1
                    s3_fired = True
                    s3_verdict_final = verdict

                    if verdict == "CONFIRM":
                        # Escalate this day's score
                        adj_scores[row_idx] = max(score, 0.75)
                    elif verdict == "CLEAR":
                        adj_scores[row_idx] = min(score, 0.25)

        # Recompute peak_post with Stage 3 adjustments
        peak_post = float(np.max(adj_scores[rows_sorted]))

        # Stage 3 accuracy accounting (vehicle-level final verdict)
        if s3_fired and s3_verdict_final:
            if s3_verdict_final in s3_correct:
                if s3_verdict_final == "CONFIRM":
                    if true_label == 1: s3_correct["CONFIRM"]["tp"] += 1
                    else:               s3_correct["CONFIRM"]["fp"] += 1
                elif s3_verdict_final == "CLEAR":
                    if true_label == 0: s3_correct["CLEAR"]["tp"] += 1   # correctly suppressed
                    else:               s3_correct["CLEAR"]["fp"] += 1   # wrongly suppressed

        all_labels.append(true_label)
        all_pre.append(peak_pre)
        all_post.append(peak_post)
        all_classes.append(vehicle_cls)

    elapsed = time.time() - t0
    print(f"done in {elapsed:.0f}s ({n_veh:,} vehicles, {s3_total_invocations:,} Stage 3 calls so far)")

# ── Results ───────────────────────────────────────────────────────────────────
labels_arr = np.array(all_labels, dtype=int)
pre_arr    = np.array(all_pre,    dtype=np.float32)
post_arr   = np.array(all_post,   dtype=np.float32)
cls_arr    = np.array(all_classes)

total_v  = len(labels_arr)
fail_v   = int(labels_arr.sum())
healthy_v = total_v - fail_v

borderline_mask = (pre_arr >= STAGE3_LOW) & (pre_arr <= STAGE3_HIGH)
n_bl     = int(borderline_mask.sum())
n_bl_fail= int(labels_arr[borderline_mask].sum())

print(f"\n{'='*70}")
print(f"Total vehicles: {total_v:,}  |  Failing: {fail_v:,} ({fail_v/total_v:.2%})  |  Healthy: {healthy_v:,}")
print(f"Borderline (0.30-0.70): {n_bl:,} ({n_bl/total_v:.2%})  |  Fail in borderline: {n_bl_fail:,} ({n_bl_fail/max(n_bl,1):.2%})")
print(f"Stage 3 total invocations: {s3_total_invocations:,}")

print(f"\nStage 3 verdict breakdown:")
for v in ["CONFIRM","DEFER","CLEAR"]:
    n = s3_verdicts[v]
    print(f"  {v:<8}: {n:>7,}  ({n/max(s3_total_invocations,1):.2%})")

print(f"\nStage 3 accuracy (vehicle-level, last verdict per vehicle):")
for verdict, cnt in s3_correct.items():
    tp, fp = cnt["tp"], cnt["fp"]
    tot = tp + fp
    if tot > 0:
        print(f"  {verdict:<8}: {tot:>6,} decisions — {tp/tot:.2%} correct  (tp={tp:,} fp={fp:,})")

# ── Global comparison ─────────────────────────────────────────────────────────
print(f"\n{'='*70}")
print("VEHICLE-LEVEL METRICS: BEFORE vs AFTER STAGE 3")
print(f"{'='*70}")
pre_m  = _build_metrics(labels_arr, pre_arr,  THRESH)
post_m = _build_metrics(labels_arr, post_arr, THRESH)

print(f"\n{'Metric':<26} {'Pre-Stage3':>12} {'Post-Stage3':>12} {'Delta':>10}")
print("-"*62)
for k in ["precision","recall","f1","fpr"]:
    d = post_m[k] - pre_m[k]
    print(f"  {k:<24} {pre_m[k]:>12.4f} {post_m[k]:>12.4f} {d:>+10.4f}")

auc_pre  = roc_auc_score(labels_arr, pre_arr)
auc_post = roc_auc_score(labels_arr, post_arr)
bs_pre   = brier_score_loss(labels_arr, pre_arr)
bs_post  = brier_score_loss(labels_arr, post_arr)
print(f"  {'ROC-AUC':<24} {auc_pre:>12.4f} {auc_post:>12.4f} {auc_post-auc_pre:>+10.4f}")
print(f"  {'Brier Score':<24} {bs_pre:>12.6f} {bs_post:>12.6f} {bs_post-bs_pre:>+10.6f}")

print(f"\nConfusion matrix (vehicle-level):")
print(f"  {'':20} {'Pre':>10} {'Post':>10} {'Delta':>8}")
for k in ["tp","fp","fn","tn"]:
    d = post_m[k] - pre_m[k]
    print(f"  {k.upper():<20} {pre_m[k]:>10,} {post_m[k]:>10,} {d:>+8,}")

# ── Borderline-only metrics ───────────────────────────────────────────────────
print(f"\n{'='*70}")
print("BORDERLINE VEHICLES ONLY (score 0.30-0.70 before Stage 3)")
print(f"{'='*70}")
bl_l  = labels_arr[borderline_mask]
bl_pr = pre_arr[borderline_mask]
bl_po = post_arr[borderline_mask]

if len(bl_l) > 10 and bl_l.sum() > 2:
    bl_pre_m  = _build_metrics(bl_l, bl_pr, THRESH)
    bl_post_m = _build_metrics(bl_l, bl_po, THRESH)
    print(f"\n  {'Metric':<24} {'Pre-Stage3':>12} {'Post-Stage3':>12} {'Delta':>10}")
    print("  " + "-"*60)
    for k in ["precision","recall","f1","fpr"]:
        d = bl_post_m[k] - bl_pre_m[k]
        print(f"  {k:<24} {bl_pre_m[k]:>12.4f} {bl_post_m[k]:>12.4f} {d:>+10.4f}")
    for k in ["tp","fp","fn","tn"]:
        d = bl_post_m[k] - bl_pre_m[k]
        print(f"  {k.upper():<24} {bl_pre_m[k]:>12,} {bl_post_m[k]:>12,} {d:>+10,}")

# ── Per-class breakdown ───────────────────────────────────────────────────────
print(f"\n{'='*70}")
print("PER-CLASS (post Stage 3, vehicle-level, threshold=0.35)")
print(f"{'='*70}")
print(f"  {'Class':<22} {'N':>7} {'Fail%':>6} {'Prec':>7} {'Rec':>7} {'F1':>7} {'AUC':>7}")
print("  " + "-"*62)
class_detail = {}
for cls in sorted(np.unique(cls_arr)):
    mask = cls_arr == cls
    cl   = labels_arr[mask]
    cp   = post_arr[mask]
    if cl.sum() < 5:
        continue
    cm  = _build_metrics(cl, cp, THRESH)
    auc = roc_auc_score(cl, cp)
    fr  = cl.mean()
    class_detail[cls] = {**cm, "failure_rate": round(float(fr),6), "n": int(mask.sum()), "auc": round(auc,6)}
    print(f"  {cls:<22} {mask.sum():>7,} {fr:>6.2%} {cm['precision']:>7.4f} {cm['recall']:>7.4f} {cm['f1']:>7.4f} {auc:>7.4f}")

# ── Save ──────────────────────────────────────────────────────────────────────
output = {
    "eval_seeds": EVAL_SEEDS, "fleet_size_per_seed": FLEET_SIZE, "days": DAYS,
    "total_vehicles": total_v, "failing_vehicles": fail_v,
    "n_borderline": n_bl, "borderline_pct": round(n_bl/total_v,4),
    "s3_total_invocations": s3_total_invocations,
    "stage3_verdicts": dict(s3_verdicts),
    "stage3_accuracy": {k: {**v, "accuracy": round(v["tp"]/max(v["tp"]+v["fp"],1),4)}
                        for k,v in s3_correct.items()},
    "global_pre":  pre_m, "global_post": post_m,
    "borderline_pre":  bl_pre_m  if len(bl_l) > 10 else {},
    "borderline_post": bl_post_m if len(bl_l) > 10 else {},
    "auc_pre": round(auc_pre,6), "auc_post": round(auc_post,6),
    "brier_pre": round(bs_pre,6), "brier_post": round(bs_post,6),
    "class_detail": class_detail,
}
with open(OUTPUT_PATH, "w") as f:
    json.dump(output, f, indent=2)
print(f"\nSaved to {OUTPUT_PATH.name}")
print("Done.")
