"""
Batch test: run 1000 simulated vehicles through the full two-stage pipeline.

Reports:
  - Stage 1 precision, recall, false positive rate
  - Stage 2 precision, recall, reduction in false positives
  - Per-false-positive-archetype breakdown

Usage: python test_two_stage.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import joblib
import numpy as np

# Allow imports from the training dir
sys.path.insert(0, str(Path(__file__).parent))

MODEL_DIR = Path(__file__).resolve().parents[1] / "models"
STAGE2_MODEL_PATH = MODEL_DIR / "stage2_model.pkl"
STAGE2_TRAINING_PATH = MODEL_DIR / "fleet_ai_stage2_training.parquet"

STAGE2_FEATURES = [
    "stage1_score", "pretrained_score", "if_score", "welford_score",
    "threshold_score", "dtc_score",
    "w_pretrained", "w_if", "w_welford", "w_threshold", "w_dtc",
    "signal_agreement",
    "fleet_percentile", "mv_stress_max",
    "sample_count", "welford_confidence", "pretrained_decayed",
    "has_cooling_dtc", "has_fuel_dtc", "has_electrical_dtc",
    "has_emissions_dtc", "has_engine_dtc",
    "diagnosis_urgency", "vehicle_class_code",
    "ambient_temp", "idle_heat_soak", "coolant_temp_oscillation",
    "battery_voltage", "engine_temp_delta_30d",
]

STAGE1_THRESHOLD = 0.35


def _precision(tp: int, fp: int) -> float:
    return tp / max(tp + fp, 1)


def _recall(tp: int, fn: int) -> float:
    return tp / max(tp + fn, 1)


def _f1(p: float, r: float) -> float:
    return 2 * p * r / max(p + r, 1e-9)


def run_test(n_vehicles: int = 1000) -> None:
    if not STAGE2_TRAINING_PATH.exists():
        print(f"No training data at {STAGE2_TRAINING_PATH}")
        print("Run: python fleet_simulation.py --stage2-data")
        return

    import pandas as pd
    df = pd.read_parquet(STAGE2_TRAINING_PATH)
    print(f"Test data: {len(df):,} rows  |  failure rate: {df['label'].mean():.3%}")

    # Sample n_vehicles rows
    n_vehicles = min(n_vehicles, len(df))
    sample = df.sample(n=n_vehicles, random_state=999)
    y_true = sample["label"].values

    available = [f for f in STAGE2_FEATURES if f in sample.columns]
    X = sample[available].values.astype(np.float32)

    # Stage 1 predictions
    stage1_scores = sample["stage1_score"].values
    stage1_preds = (stage1_scores >= STAGE1_THRESHOLD).astype(int)

    s1_tp = int(((stage1_preds == 1) & (y_true == 1)).sum())
    s1_fp = int(((stage1_preds == 1) & (y_true == 0)).sum())
    s1_fn = int(((stage1_preds == 0) & (y_true == 1)).sum())
    s1_tn = int(((stage1_preds == 0) & (y_true == 0)).sum())

    s1_prec = _precision(s1_tp, s1_fp)
    s1_rec = _recall(s1_tp, s1_fn)
    s1_f1 = _f1(s1_prec, s1_rec)

    print(f"\n--- Stage 1 Results (threshold={STAGE1_THRESHOLD}) ---")
    print(f"  TP={s1_tp}  FP={s1_fp}  FN={s1_fn}  TN={s1_tn}")
    print(f"  Precision: {s1_prec:.4f}  Recall: {s1_rec:.4f}  F1: {s1_f1:.4f}")
    print(f"  Stage 1 alerts: {s1_tp + s1_fp}  ({(s1_tp + s1_fp)/n_vehicles:.1%} of vehicles)")

    if not STAGE2_MODEL_PATH.exists():
        print(f"\n[WARN] Stage 2 model not found at {STAGE2_MODEL_PATH}")
        print("Run: python train_stage2.py --generate-data")
        print("Showing Stage 1 results only.")
        return

    bundle = joblib.load(STAGE2_MODEL_PATH)
    model = bundle["model"]
    model_features = bundle.get("features", STAGE2_FEATURES)

    # Only run Stage 2 on Stage 1 alerts
    alert_mask = stage1_preds == 1
    if alert_mask.sum() == 0:
        print("\nNo Stage 1 alerts — nothing for Stage 2 to evaluate.")
        return

    X_alerts = sample[alert_mask][model_features].values.astype(np.float32)
    y_alert_true = y_true[alert_mask]
    fp_types_alert = sample[alert_mask]["fp_type"].values if "fp_type" in sample.columns else None

    s2_probs = model.predict_proba(X_alerts)[:, 1]
    s2_preds = (s2_probs >= 0.50).astype(int)

    # After two-stage: TP = Stage1 alert AND Stage2 confirms AND actually failed
    s2_tp = int(((s2_preds == 1) & (y_alert_true == 1)).sum())
    s2_fp = int(((s2_preds == 1) & (y_alert_true == 0)).sum())
    s2_fn = int(((s2_preds == 0) & (y_alert_true == 1)).sum())
    total_fn = s1_fn + s2_fn  # missed by Stage 1 + suppressed by Stage 2

    s2_prec = _precision(s2_tp, s2_fp)
    s2_rec = _recall(s2_tp, total_fn)
    s2_f1 = _f1(s2_prec, s2_rec)

    fp_reduced = s1_fp - s2_fp
    fp_reduction_pct = fp_reduced / max(s1_fp, 1) * 100

    print(f"\n--- Stage 2 Results (threshold=0.50) ---")
    print(f"  TP={s2_tp}  FP={s2_fp}  FN={s2_fn} (stage2)  Total FN={total_fn}")
    print(f"  Precision: {s2_prec:.4f}  Recall: {s2_rec:.4f}  F1: {s2_f1:.4f}")
    print(f"  Confirmed alerts: {s2_tp + s2_fp}  ({(s2_tp + s2_fp)/n_vehicles:.1%} of vehicles)")
    print(f"  FP eliminated by Stage 2: {fp_reduced} ({fp_reduction_pct:.1f}% reduction)")

    if fp_types_alert is not None:
        print(f"\n--- FP Suppression by Archetype ---")
        for fp_type in ["sensor_spike", "load_stress", "prior_artifact", "true_negative"]:
            mask = fp_types_alert == fp_type
            if not mask.any():
                continue
            fp_count = int((y_alert_true[mask] == 0).sum())
            suppressed = int(((s2_preds[mask] == 0) & (y_alert_true[mask] == 0)).sum())
            suppression_pct = suppressed / max(fp_count, 1) * 100
            print(f"  {fp_type:<20}  {fp_count} FPs  →  {suppressed} suppressed ({suppression_pct:.1f}%)")

    print(f"\n--- Summary ---")
    print(f"  Stage 1 only:  Precision={s1_prec:.4f}  Recall={s1_rec:.4f}")
    print(f"  Two-stage:     Precision={s2_prec:.4f}  Recall={s2_rec:.4f}")
    prec_gain = s2_prec - s1_prec
    rec_loss = s1_rec - s2_rec
    print(f"  Precision gain: +{prec_gain:.4f}  |  Recall cost: -{rec_loss:.4f}")

    report = {
        "n_vehicles": n_vehicles,
        "stage1": {"precision": round(s1_prec, 6), "recall": round(s1_rec, 6), "f1": round(s1_f1, 6),
                   "tp": s1_tp, "fp": s1_fp, "fn": s1_fn},
        "stage2": {"precision": round(s2_prec, 6), "recall": round(s2_rec, 6), "f1": round(s2_f1, 6),
                   "tp": s2_tp, "fp": s2_fp, "fn": total_fn},
        "fp_reduction": {"count": fp_reduced, "pct": round(fp_reduction_pct, 2)},
    }
    report_path = MODEL_DIR / "two_stage_test_report.json"
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"\n  Saved: {report_path}")


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--n-vehicles", type=int, default=1000)
    args = parser.parse_args()
    run_test(n_vehicles=args.n_vehicles)
