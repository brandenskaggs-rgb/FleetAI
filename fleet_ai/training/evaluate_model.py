"""Evaluate Fleet AI model performance on a fresh heavy-duty synthetic holdout."""

from __future__ import annotations

import json
from pathlib import Path

import joblib
import numpy as np
from sklearn.metrics import (
    accuracy_score,
    confusion_matrix,
    f1_score,
    precision_score,
    recall_score,
    roc_auc_score,
)

from fleet_simulation import FEATURE_COLUMNS, generate_heavy_duty_data


def evaluate_model() -> None:
    model_path = Path(__file__).resolve().parents[1] / "models" / "fleet_ai_model.pkl"
    if not model_path.exists():
        raise FileNotFoundError(f"Model not found at {model_path}. Run fleet_simulation.py first.")

    loaded = joblib.load(model_path)
    model_type = "single"
    threshold = 0.5
    if isinstance(loaded, dict):
        model_type = loaded.get("model_type", "single")
        threshold = float(loaded.get("threshold", 0.5))
    else:
        loaded = {"model": loaded, "model_type": "single", "threshold": 0.5}

    # New seed to simulate out-of-sample behavior.
    eval_df = generate_heavy_duty_data(seed=777)
    X_eval = eval_df[FEATURE_COLUMNS]
    y_true = eval_df["failure"].to_numpy()

    if model_type == "ensemble":
        models = loaded["models"]
        rf_weight = float(loaded.get("rf_weight", 0.5))
        hgb_weight = float(loaded.get("hgb_weight", 0.5))
        rf_prob = models["random_forest"].predict_proba(X_eval)[:, 1]
        hgb_prob = models["hist_gradient_boosting"].predict_proba(X_eval)[:, 1]
        y_prob = (rf_weight * rf_prob) + (hgb_weight * hgb_prob)
    else:
        model = loaded["model"]
        y_prob = model.predict_proba(X_eval)[:, 1]
    y_pred = (y_prob >= threshold).astype(int)

    tn, fp, fn, tp = confusion_matrix(y_true, y_pred).ravel()
    metrics = {
        "rows": int(len(eval_df)),
        "accuracy": float(accuracy_score(y_true, y_pred)),
        "precision": float(precision_score(y_true, y_pred, zero_division=0)),
        "recall": float(recall_score(y_true, y_pred, zero_division=0)),
        "f1": float(f1_score(y_true, y_pred, zero_division=0)),
        "roc_auc": float(roc_auc_score(y_true, y_prob)),
        "confusion_matrix": {"tn": int(tn), "fp": int(fp), "fn": int(fn), "tp": int(tp)},
        "predicted_positive_rate": float(np.mean(y_pred)),
        "actual_positive_rate": float(np.mean(y_true)),
        "threshold": float(threshold),
    }

    report_path = Path(__file__).resolve().parents[1] / "models" / "fleet_ai_eval_report.json"
    report_path.write_text(json.dumps(metrics, indent=2), encoding="utf-8")

    print("Evaluation complete")
    print(f"Rows: {metrics['rows']}")
    print(f"Accuracy: {metrics['accuracy']:.4f}")
    print(f"Precision: {metrics['precision']:.4f}")
    print(f"Recall: {metrics['recall']:.4f}")
    print(f"F1: {metrics['f1']:.4f}")
    print(f"ROC-AUC: {metrics['roc_auc']:.4f}")
    print(f"Threshold: {threshold:.2f}")
    print(f"Confusion matrix (tn, fp, fn, tp): {tn}, {fp}, {fn}, {tp}")
    print(f"Saved report: {report_path}")


if __name__ == "__main__":
    evaluate_model()
