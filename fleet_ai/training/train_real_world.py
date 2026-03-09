"""Train Fleet AI model on real fleet history with time-based validation."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.calibration import CalibratedClassifierCV
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.metrics import (
    accuracy_score,
    average_precision_score,
    confusion_matrix,
    f1_score,
    precision_score,
    recall_score,
    roc_auc_score,
)


BASE_FEATURES = [
    "rpm",
    "engine_temp",
    "fuel_pressure",
    "battery_voltage",
    "vibration",
    "ambient_temp_c",
    "elevation_ft",
    "payload_ratio",
    "road_grade_pct",
    "idle_hours_day",
]

DERIVED_FEATURES = [
    "engine_temp_delta_30d",
    "fuel_pressure_delta_30d",
    "battery_voltage_delta_30d",
    "vibration_delta_30d",
    "rpm_roll7_mean",
    "engine_temp_roll7_mean",
    "fuel_pressure_roll7_mean",
    "vibration_roll7_std",
]

FEATURE_COLUMNS = BASE_FEATURES + DERIVED_FEATURES


def _safe_to_datetime(series: pd.Series) -> pd.Series:
    return pd.to_datetime(series, errors="coerce", utc=True)


def build_derived_features(df: pd.DataFrame) -> pd.DataFrame:
    """Add trend/anomaly features per truck with time ordering."""
    data = df.copy()
    data["timestamp"] = _safe_to_datetime(data["timestamp"])
    data = data.sort_values(["truck_id", "timestamp"]).reset_index(drop=True)

    g = data.groupby("truck_id", sort=False)
    data["engine_temp_delta_30d"] = g["engine_temp"].diff(30).fillna(0.0)
    data["fuel_pressure_delta_30d"] = g["fuel_pressure"].diff(30).fillna(0.0)
    data["battery_voltage_delta_30d"] = g["battery_voltage"].diff(30).fillna(0.0)
    data["vibration_delta_30d"] = g["vibration"].diff(30).fillna(0.0)

    data["rpm_roll7_mean"] = (
        g["rpm"].rolling(window=7, min_periods=1).mean().reset_index(level=0, drop=True)
    )
    data["engine_temp_roll7_mean"] = (
        g["engine_temp"].rolling(window=7, min_periods=1).mean().reset_index(level=0, drop=True)
    )
    data["fuel_pressure_roll7_mean"] = (
        g["fuel_pressure"].rolling(window=7, min_periods=1).mean().reset_index(level=0, drop=True)
    )
    data["vibration_roll7_std"] = (
        g["vibration"].rolling(window=7, min_periods=2).std().reset_index(level=0, drop=True)
    ).fillna(0.0)
    return data


def infer_label(df: pd.DataFrame) -> pd.Series:
    """Resolve label column from common naming conventions."""
    for candidate in ["failure", "label", "failure_within_14d", "failure_within_30d"]:
        if candidate in df.columns:
            return df[candidate].astype(int)
    raise ValueError(
        "Missing label column. Add one of: failure, label, failure_within_14d, failure_within_30d."
    )


def choose_thresholds(y_true: np.ndarray, y_prob: np.ndarray) -> dict:
    """Pick profile thresholds from validation probabilities."""
    balanced = {"score": -1.0, "threshold": 0.5}
    high_precision = {"score": -1.0, "threshold": 0.6}
    high_recall = {"score": -1.0, "threshold": 0.2}

    for threshold in np.arange(0.05, 0.96, 0.01):
        y_pred = (y_prob >= threshold).astype(int)
        precision = precision_score(y_true, y_pred, zero_division=0)
        recall = recall_score(y_true, y_pred, zero_division=0)
        f1 = f1_score(y_true, y_pred, zero_division=0)
        accuracy = accuracy_score(y_true, y_pred)

        balance_score = f1 + (0.08 * precision) + (0.03 * accuracy)
        if balance_score > balanced["score"]:
            balanced = {"score": balance_score, "threshold": float(threshold)}

        if precision >= 0.70 and precision > high_precision["score"]:
            high_precision = {"score": precision, "threshold": float(threshold)}

        if recall >= 0.75 and f1 > high_recall["score"]:
            high_recall = {"score": f1, "threshold": float(threshold)}

    return {
        "balanced": balanced["threshold"],
        "high_precision": high_precision["threshold"],
        "high_recall": high_recall["threshold"],
    }


def evaluate(y_true: np.ndarray, y_prob: np.ndarray, threshold: float) -> dict:
    y_pred = (y_prob >= threshold).astype(int)
    tn, fp, fn, tp = confusion_matrix(y_true, y_pred, labels=[0, 1]).ravel()
    try:
        roc_auc = float(roc_auc_score(y_true, y_prob))
    except ValueError:
        roc_auc = None
    try:
        pr_auc = float(average_precision_score(y_true, y_prob))
    except ValueError:
        pr_auc = None
    return {
        "accuracy": float(accuracy_score(y_true, y_pred)),
        "precision": float(precision_score(y_true, y_pred, zero_division=0)),
        "recall": float(recall_score(y_true, y_pred, zero_division=0)),
        "f1": float(f1_score(y_true, y_pred, zero_division=0)),
        "roc_auc": roc_auc,
        "pr_auc": pr_auc,
        "confusion_matrix": {"tn": int(tn), "fp": int(fp), "fn": int(fn), "tp": int(tp)},
    }


def train(csv_path: Path, test_fraction: float = 0.20) -> None:
    raw = pd.read_csv(csv_path)
    if "timestamp" not in raw.columns or "truck_id" not in raw.columns:
        raise ValueError("CSV must include timestamp and truck_id columns.")
    for col in BASE_FEATURES:
        if col not in raw.columns:
            raise ValueError(f"Missing required feature column: {col}")

    prepared = build_derived_features(raw)
    y = infer_label(prepared).to_numpy()

    prepared = prepared.sort_values("timestamp").reset_index(drop=True)
    split_idx = int(len(prepared) * (1.0 - test_fraction))
    train_df = prepared.iloc[:split_idx].copy()
    test_df = prepared.iloc[split_idx:].copy()

    X_train = train_df[FEATURE_COLUMNS]
    y_train = infer_label(train_df).to_numpy()
    X_test = test_df[FEATURE_COLUMNS]
    y_test = infer_label(test_df).to_numpy()

    base_model = HistGradientBoostingClassifier(
        max_depth=9,
        learning_rate=0.05,
        max_iter=650,
        random_state=42,
    )
    class_counts = np.bincount(y_train.astype(int), minlength=2)
    min_class = int(class_counts.min()) if class_counts.size > 0 else 0
    cv_folds = max(2, min(3, min_class))
    if min_class >= 2:
        calibrated = CalibratedClassifierCV(base_model, cv=cv_folds, method="isotonic")
        calibrated.fit(X_train, y_train)
    else:
        base_model.fit(X_train, y_train)
        calibrated = base_model

    # Validation slice from tail of train period for threshold selection.
    val_cut = int(len(X_train) * 0.80)
    X_val = X_train.iloc[val_cut:]
    y_val = y_train[val_cut:]
    val_prob = calibrated.predict_proba(X_val)[:, 1]
    thresholds = choose_thresholds(y_val, val_prob)

    test_prob = calibrated.predict_proba(X_test)[:, 1]
    report = {
        "rows_total": int(len(prepared)),
        "rows_train": int(len(train_df)),
        "rows_test": int(len(test_df)),
        "features": FEATURE_COLUMNS,
        "thresholds": thresholds,
        "metrics_balanced": evaluate(y_test, test_prob, thresholds["balanced"]),
        "metrics_high_precision": evaluate(y_test, test_prob, thresholds["high_precision"]),
        "metrics_high_recall": evaluate(y_test, test_prob, thresholds["high_recall"]),
    }

    model_bundle = {
        "model_type": "single",
        "model_name": "calibrated_hgb_realworld",
        "model": calibrated,
        "features": FEATURE_COLUMNS,
        "threshold": float(thresholds["balanced"]),
        "thresholds": thresholds,
    }

    model_dir = Path(__file__).resolve().parents[1] / "models"
    model_dir.mkdir(parents=True, exist_ok=True)
    model_path = model_dir / "fleet_ai_model_realworld.pkl"
    report_path = model_dir / "fleet_ai_realworld_report.json"

    joblib.dump(model_bundle, model_path)
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")

    print("Real-world training complete")
    print(f"Rows total: {report['rows_total']}")
    print(f"Train rows: {report['rows_train']} | Test rows: {report['rows_test']}")
    print(f"Balanced threshold: {thresholds['balanced']:.2f}")
    print(f"Balanced precision: {report['metrics_balanced']['precision']:.4f}")
    print(f"Balanced recall: {report['metrics_balanced']['recall']:.4f}")
    print(f"Balanced F1: {report['metrics_balanced']['f1']:.4f}")
    print(f"Balanced ROC-AUC: {report['metrics_balanced']['roc_auc']:.4f}")
    print(f"Saved model: {model_path}")
    print(f"Saved report: {report_path}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Train Fleet AI on real-world CSV history.")
    parser.add_argument(
        "--csv",
        required=True,
        help="Path to fleet history CSV with timestamp, truck_id, features, and label.",
    )
    parser.add_argument(
        "--test-fraction",
        type=float,
        default=0.20,
        help="Fraction of latest timeline to reserve for test.",
    )
    args = parser.parse_args()
    train(Path(args.csv), test_fraction=args.test_fraction)


if __name__ == "__main__":
    main()
