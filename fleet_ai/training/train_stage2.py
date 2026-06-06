"""
Train the Stage 2 (confirmatory) LightGBM classifier.

Usage:
  python train_stage2.py                   # train from existing parquet
  python train_stage2.py --generate-data   # generate data first, then train
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import joblib
import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.metrics import (
    accuracy_score,
    classification_report,
    f1_score,
    precision_score,
    recall_score,
    roc_auc_score,
)
from sklearn.model_selection import StratifiedKFold, train_test_split

MODEL_DIR = Path(__file__).resolve().parents[1] / "models"
DATA_PATH = MODEL_DIR / "fleet_ai_stage2_training.parquet"
MODEL_PATH = MODEL_DIR / "stage2_model.pkl"

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


def train(generate_data: bool = False, n_seeds: int = 50, sample_per_seed: int = 5000) -> None:
    if generate_data or not DATA_PATH.exists():
        print("Generating Stage 2 training data...")
        import sys
        sys.path.insert(0, str(Path(__file__).parent))
        from fleet_simulation import generate_stage2_training_data
        generate_stage2_training_data(n_seeds=n_seeds, sample_per_seed=sample_per_seed)

    print(f"Loading {DATA_PATH}...")
    df = pd.read_parquet(DATA_PATH)
    print(f"Loaded {len(df):,} rows  |  failure rate: {df['label'].mean():.3%}")
    print(f"FP types: {df['fp_type'].value_counts().to_dict()}")

    available = [f for f in STAGE2_FEATURES if f in df.columns]
    missing = [f for f in STAGE2_FEATURES if f not in df.columns]
    if missing:
        print(f"Warning: {len(missing)} features missing from dataset: {missing}")

    X = df[available].values.astype(np.float32)
    y = df["label"].values.astype(np.int32)

    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.20, random_state=42, stratify=y
    )

    print(f"\nTraining set: {len(X_train):,} rows  |  Test set: {len(X_test):,} rows")
    print(f"Positive rate — train: {y_train.mean():.3%}  |  test: {y_test.mean():.3%}")

    model = lgb.LGBMClassifier(
        n_estimators=300,
        learning_rate=0.04,
        num_leaves=31,
        max_depth=6,
        min_child_samples=20,
        subsample=0.85,
        colsample_bytree=0.85,
        class_weight="balanced",
        reg_alpha=0.05,
        reg_lambda=0.10,
        random_state=42,
        verbose=-1,
    )

    model.fit(
        X_train,
        y_train,
        eval_set=[(X_test, y_test)],
        callbacks=[lgb.early_stopping(50, verbose=False), lgb.log_evaluation(100)],
    )

    y_prob = model.predict_proba(X_test)[:, 1]
    y_pred = (y_prob >= 0.50).astype(int)

    precision = float(precision_score(y_test, y_pred, zero_division=0))
    recall = float(recall_score(y_test, y_pred, zero_division=0))
    f1 = float(f1_score(y_test, y_pred, zero_division=0))
    roc_auc = float(roc_auc_score(y_test, y_prob))
    accuracy = float(accuracy_score(y_test, y_pred))

    print("\n--- Stage 2 Test Results ---")
    print(f"Accuracy:  {accuracy:.4f}")
    print(f"Precision: {precision:.4f}")
    print(f"Recall:    {recall:.4f}")
    print(f"F1:        {f1:.4f}")
    print(f"ROC-AUC:   {roc_auc:.4f}")
    print()
    print(classification_report(y_test, y_pred, target_names=["not_failure", "failure"]))

    # Feature importance
    feat_imp = sorted(
        zip(available, model.feature_importances_),
        key=lambda x: x[1],
        reverse=True,
    )
    print("--- Top 10 Feature Importances ---")
    for feat, imp in feat_imp[:10]:
        print(f"  {feat:<35} {imp:.4f}")

    # Per-FP-type breakdown on test set
    test_idx = np.arange(len(X_test))
    # We can't easily recover fp_type for test rows here — summarize by threshold
    print("\n--- Threshold Sensitivity ---")
    for thr in [0.35, 0.40, 0.45, 0.50, 0.55, 0.60, 0.65]:
        preds_t = (y_prob >= thr).astype(int)
        p = precision_score(y_test, preds_t, zero_division=0)
        r = recall_score(y_test, preds_t, zero_division=0)
        print(f"  thr={thr:.2f}  precision={p:.4f}  recall={r:.4f}  f1={f1_score(y_test, preds_t, zero_division=0):.4f}")

    # Save
    bundle = {
        "model": model,
        "features": available,
        "train_sample_count": len(X_train),
        "feedback_samples": 0,
        "metrics": {
            "accuracy": round(accuracy, 6),
            "precision": round(precision, 6),
            "recall": round(recall, 6),
            "f1": round(f1, 6),
            "roc_auc": round(roc_auc, 6),
        },
    }
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    joblib.dump(bundle, MODEL_PATH)

    # Save eval report
    report = {
        "modelVersion": "stage2-v1.0.0",
        "trainRows": int(len(X_train)),
        "testRows": int(len(X_test)),
        "features": available,
        "featureCount": len(available),
        "metrics": bundle["metrics"],
        "featureImportance": [
            {"feature": f, "importance": round(float(imp), 6)}
            for f, imp in feat_imp[:20]
        ],
        "notes": "Stage 2 confirmatory LightGBM. Trained on synthetic false-positive archetypes at natural 0.4% failure rate.",
    }
    report_path = MODEL_DIR / "stage2_eval_report.json"
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")

    print(f"\nSaved model:  {MODEL_PATH}")
    print(f"Saved report: {report_path}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Train Stage 2 LightGBM confirmatory classifier.")
    parser.add_argument("--generate-data", action="store_true", help="Generate training data before training")
    parser.add_argument("--n-seeds", type=int, default=50, help="Seeds for data generation")
    parser.add_argument("--sample-per-seed", type=int, default=5000, help="Rows per seed")
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    train(
        generate_data=args.generate_data,
        n_seeds=args.n_seeds,
        sample_per_seed=args.sample_per_seed,
    )
