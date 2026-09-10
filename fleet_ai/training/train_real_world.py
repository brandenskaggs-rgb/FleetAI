"""Train Fleet AI model on real fleet history with time-based validation."""

from __future__ import annotations

import argparse
import json
import sys
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


sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from backend.app.ml.feature_contract import time_features, SENSOR_FEATURES, manifest
from backend.app.ml.evaluation import partition, metrics, fit_calibration
from backend.app.ml.artifact_registry import training_registry


def build_derived_features(df: pd.DataFrame) -> pd.DataFrame:
    """Observed 30-day differences and trailing seven-day statistics."""
    mapping = {value: key for key, value in SENSOR_FEATURES.items()}
    data = time_features(df.reset_index(drop=True), "truck_id", "timestamp", mapping)
    for feature, column, method in [
        ("rpm_roll7_mean", "rpm", "mean"),
        ("engine_temp_roll7_mean", "engine_temp", "mean"),
        ("fuel_pressure_roll7_mean", "fuel_pressure", "mean"),
        ("vibration_roll7_std", "vibration", "std"),
    ]:
        data[feature] = np.nan
        for _, group in data.groupby("truck_id", sort=False):
            series = group.set_index("timestamp")[column]
            rolling = series.rolling("7D", min_periods=2, closed="both")
            values = getattr(rolling, method)()
            values.loc[values.index < values.index.min() + pd.Timedelta(days=7)] = np.nan
            data.loc[group.index, feature] = values.to_numpy()
    return data

def infer_label(df: pd.DataFrame) -> pd.Series:
    """Resolve label column from common naming conventions."""
    for candidate in ["failure", "label", "failure_within_14d", "failure_within_30d"]:
        if candidate in df.columns:
            labels = pd.to_numeric(df[candidate], errors="coerce")
            if not labels.isin([0, 1]).all():
                raise ValueError("Failure labels must be 0 or 1; missing or fractional labels are not accepted.")
            return labels.astype(int)
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
    both_classes = set(np.unique(y_true)) == {0, 1}
    roc_auc = float(roc_auc_score(y_true, y_prob)) if both_classes else None
    pr_auc = float(average_precision_score(y_true, y_prob)) if both_classes else None
    roc_auc = roc_auc if roc_auc is not None and np.isfinite(roc_auc) else None
    pr_auc = pr_auc if pr_auc is not None and np.isfinite(pr_auc) else None
    return {
        "accuracy": float(accuracy_score(y_true, y_pred)),
        "precision": float(precision_score(y_true, y_pred, zero_division=0)),
        "recall": float(recall_score(y_true, y_pred, zero_division=0)),
        "f1": float(f1_score(y_true, y_pred, zero_division=0)),
        "roc_auc": roc_auc,
        "pr_auc": pr_auc,
        "evaluation_status": "both_classes_present" if both_classes else "insufficient_label_diversity",
        "confusion_matrix": {"tn": int(tn), "fp": int(fp), "fn": int(fn), "tp": int(tp)},
    }


def train(csv_path: Path, test_fraction: float = 0.20) -> None:
    if not 0 < test_fraction < 1:
        raise ValueError("test_fraction must be between 0 and 1.")
    raw = pd.read_csv(csv_path)
    if "timestamp" not in raw.columns or "truck_id" not in raw.columns:
        raise ValueError("CSV must include timestamp and truck_id columns.")
    for col in BASE_FEATURES:
        if col not in raw.columns:
            raise ValueError(f"Missing required feature column: {col}")

    prepared = build_derived_features(raw)
    if prepared["timestamp"].isna().any():
        raise ValueError("Every training row needs a valid timestamp.")
    infer_label(prepared)

    if "outcome_confirmed" not in prepared or not prepared["outcome_confirmed"].isin([True, 1]).all():
        raise ValueError("Real training requires outcome_confirmed=true; unlabeled telemetry is not supervised evidence.")
    if "org_id" not in prepared or prepared["org_id"].nunique() != 1 or prepared["org_id"].isna().any():
        raise ValueError("Real training must be scoped to exactly one organization.")
    if test_fraction != .20:
        raise ValueError("The independent split currently fixes the untouched test allocation at 20%.")
    train_df, val_df, test_df = partition(prepared, group="truck_id")
    # Outcome horizons must be observable before each partition closes.
    if "label_observed_at" not in prepared:
        raise ValueError("Confirmed labels require label_observed_at timestamps.")
    def observed(part):
        known = pd.to_datetime(part["label_observed_at"], utc=True, errors="raise")
        if known.isna().any() or (known < part["timestamp"]).any():
            raise ValueError("Outcome observation times must be known and not precede prediction times.")
        return part.loc[known <= part["timestamp"].max()].copy()
    train_df, val_df, test_df = map(observed, (train_df, val_df, test_df))
    if any(p.empty for p in (train_df, val_df, test_df)):
        raise ValueError("Insufficient independently observed outcome history.")
    y_train, y_val, y_test = (infer_label(p).to_numpy() for p in (train_df, val_df, test_df))
    if len(np.unique(y_train)) != 2:
        raise ValueError("Training requires confirmed positive and negative outcomes.")
    base_model = HistGradientBoostingClassifier(
        max_depth=9, learning_rate=.05, max_iter=650, random_state=42, early_stopping=False)
    base_model.fit(train_df[FEATURE_COLUMNS], y_train)
    source = "real_confirmed_outcomes"
    cal_df = val_df.iloc[:0]
    selection_df = val_df
    validation_groups = sorted(val_df["truck_id"].unique())
    if len(validation_groups) >= 2:
        cutoff = val_df["timestamp"].median()
        calibration_groups = set(validation_groups[:len(validation_groups)//2])
        proposed_cal = val_df.loc[val_df.truck_id.isin(calibration_groups) & (val_df.timestamp <= cutoff)]
        proposed_cal = proposed_cal.loc[pd.to_datetime(proposed_cal.label_observed_at, utc=True) <= cutoff]
        proposed_selection = val_df.loc[~val_df.truck_id.isin(calibration_groups) & (val_df.timestamp > cutoff)]
        if not proposed_cal.empty and not proposed_selection.empty:
            cal_df, selection_df = proposed_cal, proposed_selection
    calibration_model = None
    calibration = {"status": "uncalibrated", "reason": "no_separate_calibration_partition", "fieldValidated": False}
    if not cal_df.empty:
        calibration_model, calibration = fit_calibration(infer_label(cal_df),
            base_model.predict_proba(cal_df[FEATURE_COLUMNS])[:, 1], source, "realworld-hgb-v2")
    val_prob = base_model.predict_proba(selection_df[FEATURE_COLUMNS])[:, 1]
    if calibration_model is not None:
        val_prob = calibration_model.predict(val_prob)
    y_val = infer_label(selection_df).to_numpy()
    thresholds = choose_thresholds(y_val, val_prob)
    test_prob = base_model.predict_proba(test_df[FEATURE_COLUMNS])[:, 1]
    if calibration_model is not None:
        test_prob = calibration_model.predict(test_prob)
    lead_times = None
    if "failure_at" in test_df:
        failure_times = pd.to_datetime(test_df["failure_at"], utc=True, errors="raise")
        if (failure_times.loc[y_test == 1] <= test_df.loc[y_test == 1, "timestamp"]).any():
            raise ValueError("Failure evaluation requires predictions made before the confirmed failure.")
        lead_times = ((failure_times - test_df["timestamp"]).dt.total_seconds() / 3600).to_numpy()
    report = {
        "rows_total": len(prepared), "rows_train": len(train_df), "rows_validation": len(val_df),
        "rows_test": len(test_df), "rows_purged": len(prepared)-len(train_df)-len(val_df)-len(test_df),
        "partition": "untouched_test", "evidenceSource": source, "features": FEATURE_COLUMNS,
        "thresholds": thresholds, "calibration": calibration,
        "rows_calibration": len(cal_df), "rows_selection": len(selection_df),
        **{f"metrics_{name}": metrics(y_test, test_prob, threshold, source, lead_times)
           for name, threshold in thresholds.items()},
    }
    metadata = {"modelVersion": "realworld-hgb-v2", "trainingSource": source,
                "featureSchema": manifest(FEATURE_COLUMNS), "calibration": calibration}
    model_bundle = {"model_type": "single", "model_name": "hgb_realworld", "model": base_model,
                    "calibrator": calibration_model, "calibration": calibration,
                    "features": FEATURE_COLUMNS, "threshold": thresholds["balanced"], "thresholds": thresholds}
    registry = training_registry()
    identifier = registry.candidate("realworld_hgb", model_bundle, metadata,
                                    scope="tenant:" + str(prepared["org_id"].iloc[0]))
    registry.evaluate(identifier, {**report, "metrics": report["metrics_balanced"]})
    model_path = registry.path
    report_path = f"registry artifact {identifier}"

    print("Real-world training complete")
    print(f"Rows total: {report['rows_total']}")
    print(f"Train rows: {report['rows_train']} | Test rows: {report['rows_test']}")
    print(f"Balanced threshold: {thresholds['balanced']:.2f}")
    print(f"Balanced precision: {report['metrics_balanced']['precision']:.4f}")
    print(f"Balanced recall: {report['metrics_balanced']['recall']:.4f}")
    print(f"Balanced F1: {report['metrics_balanced']['f1']:.4f}")
    auc = report["metrics_balanced"]["roc_auc"]
    print("Balanced ROC-AUC: " + (f"{auc:.4f}" if auc is not None else "not assessed"))
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
