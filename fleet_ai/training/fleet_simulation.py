"""Train a heavy-duty Fleet AI maintenance model on realistic synthetic operations."""

from __future__ import annotations

import json
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier, RandomForestClassifier
from sklearn.metrics import accuracy_score, f1_score, precision_score, recall_score, roc_auc_score
from sklearn.model_selection import train_test_split


FEATURE_COLUMNS = [
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
    "engine_temp_delta_30d",
    "fuel_pressure_delta_30d",
    "battery_voltage_delta_30d",
    "vibration_delta_30d",
]


def _sigmoid(x: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-x))


def generate_heavy_duty_data(
    fleet_size: int = 12,
    days: int = 365,
    observations_per_day: int = 8,
    seed: int = 42,
) -> pd.DataFrame:
    """
    Generate heavy-duty semi-truck synthetic data with weather and elevation stress.

    Notes:
    - `payload_ratio` is normalized 0..1 (1.0 ~= near full legal payload).
    - `road_grade_pct` approximates route steepness effect.
    """
    rng = np.random.default_rng(seed)
    rows = fleet_size * days * observations_per_day
    truck_id = np.repeat(np.arange(fleet_size), days * observations_per_day)
    day_idx = np.tile(np.repeat(np.arange(days), observations_per_day), fleet_size)
    month_idx = day_idx // 30

    region = rng.choice(
        ["hot", "cold", "mountain", "temperate"],
        size=rows,
        p=[0.24, 0.22, 0.20, 0.34],
    )
    region_series = pd.Series(region)

    ambient_temp_c = np.select(
        [
            region_series.eq("hot"),
            region_series.eq("cold"),
            region_series.eq("mountain"),
            region_series.eq("temperate"),
        ],
        [
            rng.normal(36, 8, rows),
            rng.normal(-8, 10, rows),
            rng.normal(7, 11, rows),
            rng.normal(18, 9, rows),
        ],
    )

    elevation_ft = np.select(
        [
            region_series.eq("hot"),
            region_series.eq("cold"),
            region_series.eq("mountain"),
            region_series.eq("temperate"),
        ],
        [
            rng.normal(1200, 700, rows),
            rng.normal(1800, 900, rows),
            rng.normal(6200, 1600, rows),
            rng.normal(1400, 800, rows),
        ],
    )
    elevation_ft = np.clip(elevation_ft, 0, 12000)

    payload_ratio = np.clip(rng.beta(5.0, 2.2, rows), 0.25, 1.0)
    road_grade_pct = np.clip(
        rng.normal(1.2, 0.9, rows) + np.where(region_series.eq("mountain"), 2.4, 0.0),
        0.0,
        8.0,
    )
    idle_hours_day = np.clip(
        rng.normal(1.6, 0.8, rows) + np.where(region_series.eq("cold"), 0.6, 0.0),
        0.0,
        5.0,
    )

    temp_stress = np.clip((ambient_temp_c - 32) / 18, 0, 2.2) + np.clip(
        (-ambient_temp_c - 6) / 18, 0, 2.2
    )
    altitude_stress = np.clip(elevation_ft / 7000, 0, 1.8)
    load_stress = np.clip((payload_ratio - 0.65) / 0.35, 0, 1.2)

    rpm = (
        1220
        + 620 * payload_ratio
        + 85 * road_grade_pct
        + 80 * altitude_stress
        + rng.normal(0, 90, rows)
    )
    rpm = np.clip(rpm, 700, 3200)

    engine_temp = (
        84
        + 0.0105 * rpm
        + 0.30 * ambient_temp_c
        + 2.4 * road_grade_pct
        + 2.0 * load_stress
        + rng.normal(0, 3.6, rows)
    )
    engine_temp = np.clip(engine_temp, 45, 145)

    fuel_pressure = (
        64
        - 4.8 * altitude_stress
        - 2.2 * temp_stress
        - 1.9 * load_stress
        + rng.normal(0, 2.8, rows)
    )
    fuel_pressure = np.clip(fuel_pressure, 24, 75)

    battery_voltage = (
        13.9
        - 0.050 * np.clip(-ambient_temp_c, 0, 40)
        - 0.12 * idle_hours_day
        - 0.14 * temp_stress
        + rng.normal(0, 0.22, rows)
    )
    battery_voltage = np.clip(battery_voltage, 10.2, 14.7)

    vibration = (
        0.28
        + 0.66 * load_stress
        + 0.10 * road_grade_pct
        + 0.09 * altitude_stress
        + 0.06 * idle_hours_day
        + rng.normal(0, 0.09, rows)
    )
    vibration = np.clip(vibration, 0.05, 2.2)

    # Month-over-month drift features ("last month vs this month" anomalies).
    wear_progress = np.clip(month_idx / 12.0, 0.0, 1.2)
    truck_wear_bias = rng.normal(0.0, 0.6, fleet_size)[truck_id]

    engine_temp_delta_30d = (
        1.4 * wear_progress + 1.0 * temp_stress + 0.9 * load_stress + truck_wear_bias + rng.normal(0, 1.8, rows)
    )
    fuel_pressure_delta_30d = (
        -1.2 * wear_progress - 0.8 * altitude_stress - 0.6 * temp_stress + rng.normal(0, 1.5, rows)
    )
    battery_voltage_delta_30d = (
        -0.20 * wear_progress - 0.10 * idle_hours_day - 0.08 * temp_stress + rng.normal(0, 0.10, rows)
    )
    vibration_delta_30d = (
        0.18 * wear_progress + 0.15 * load_stress + 0.06 * road_grade_pct + rng.normal(0, 0.09, rows)
    )

    # Failure label is probabilistic to avoid simplistic threshold leakage.
    risk_score = (
        -7.1
        + 1.8 * (rpm > 2600)
        + 1.3 * (rpm < 900)
        + 2.1 * (engine_temp > 110)
        + 1.7 * (engine_temp > 120)
        + 1.9 * (fuel_pressure < 42)
        + 1.4 * (battery_voltage < 12.0)
        + 1.8 * (vibration > 1.1)
        + 0.8 * (temp_stress > 0.8)
        + 0.7 * (altitude_stress > 0.9)
        + 0.6 * (idle_hours_day > 2.7)
        + 1.3 * (engine_temp_delta_30d > 6.0)
        + 1.1 * (fuel_pressure_delta_30d < -3.5)
        + 0.9 * (battery_voltage_delta_30d < -0.35)
        + 1.1 * (vibration_delta_30d > 0.45)
    )
    failure_probability = _sigmoid(risk_score)
    failure = rng.binomial(1, failure_probability)

    return pd.DataFrame(
        {
            "rpm": np.round(rpm, 2),
            "engine_temp": np.round(engine_temp, 2),
            "fuel_pressure": np.round(fuel_pressure, 2),
            "battery_voltage": np.round(battery_voltage, 3),
            "vibration": np.round(vibration, 3),
            "ambient_temp_c": np.round(ambient_temp_c, 2),
            "elevation_ft": np.round(elevation_ft, 1),
            "payload_ratio": np.round(payload_ratio, 3),
            "road_grade_pct": np.round(road_grade_pct, 3),
            "idle_hours_day": np.round(idle_hours_day, 3),
            "engine_temp_delta_30d": np.round(engine_temp_delta_30d, 3),
            "fuel_pressure_delta_30d": np.round(fuel_pressure_delta_30d, 3),
            "battery_voltage_delta_30d": np.round(battery_voltage_delta_30d, 4),
            "vibration_delta_30d": np.round(vibration_delta_30d, 4),
            "failure": failure.astype(int),
            "failure_probability_true": np.round(failure_probability, 6),
        }
    )


def train_and_save_model() -> None:
    """Train model, print quick metrics, and save artifact + metadata."""
    df = generate_heavy_duty_data()
    X = df[FEATURE_COLUMNS]
    y = df["failure"]

    X_dev, X_test, y_dev, y_test = train_test_split(
        X, y, test_size=0.25, random_state=42, stratify=y
    )
    X_train, X_val, y_train, y_val = train_test_split(
        X_dev, y_dev, test_size=0.25, random_state=42, stratify=y_dev
    )

    rf_model = RandomForestClassifier(
        n_estimators=500,
        max_depth=14,
        min_samples_leaf=3,
        random_state=42,
        class_weight="balanced",
        n_jobs=-1,
    )
    hgb_model = HistGradientBoostingClassifier(
        max_depth=8,
        learning_rate=0.06,
        max_iter=450,
        random_state=42,
    )
    rf_model.fit(X_train, y_train)
    hgb_model.fit(X_train, y_train)

    rf_val_prob = rf_model.predict_proba(X_val)[:, 1]
    hgb_val_prob = hgb_model.predict_proba(X_val)[:, 1]

    def estimate_utility(tp: int, fp: int, fn: int) -> float:
        # Utility equation (dollar-based balance):
        # U = TP*V_tp - FP*C_fp - FN*C_fn
        # where:
        #   V_tp: value captured when a true high-risk alert triggers intervention
        #   C_fp: inspection/dispatch cost of a false alert
        #   C_fn: missed-failure opportunity cost
        avoided_breakdown_value = (1850.0 + (9.0 * 160.0)) * 0.62
        false_alert_cost = 115.0 + 35.0
        missed_failure_cost = (1850.0 + (9.0 * 160.0)) * 0.38
        return (
            (tp * avoided_breakdown_value)
            - (fp * false_alert_cost)
            - (fn * missed_failure_cost)
        )

    # Tune operating point for balanced precision/recall with economic tie-breaker.
    best_value = None
    best_tuple = None
    for rf_weight in np.arange(0.00, 1.01, 0.05):
        val_prob = (rf_weight * rf_val_prob) + ((1.0 - rf_weight) * hgb_val_prob)
        for threshold in np.arange(0.10, 0.81, 0.01):
            val_pred = (val_prob >= threshold).astype(int)
            precision = precision_score(y_val, val_pred, zero_division=0)
            recall = recall_score(y_val, val_pred, zero_division=0)
            f1 = f1_score(y_val, val_pred, zero_division=0)
            accuracy = accuracy_score(y_val, val_pred)
            tp = int(((y_val == 1) & (val_pred == 1)).sum())
            fp = int(((y_val == 0) & (val_pred == 1)).sum())
            fn = int(((y_val == 1) & (val_pred == 0)).sum())
            utility = estimate_utility(tp, fp, fn)
            if precision < 0.28 or recall < 0.45:
                continue
            balanced_score = f1 + (0.12 * precision) + (0.04 * accuracy)
            candidate = (balanced_score, utility, f1, precision, recall)
            if best_value is None or candidate > best_value:
                best_value = candidate
                best_tuple = (float(rf_weight), float(threshold))

    if best_tuple is None:
        rf_weight = 0.55
        threshold = 0.315
    else:
        rf_weight, threshold = best_tuple

    rf_test_prob = rf_model.predict_proba(X_test)[:, 1]
    hgb_test_prob = hgb_model.predict_proba(X_test)[:, 1]
    test_prob = (rf_weight * rf_test_prob) + ((1.0 - rf_weight) * hgb_test_prob)
    predictions = (test_prob >= threshold).astype(int)

    accuracy = accuracy_score(y_test, predictions)
    precision = precision_score(y_test, predictions, zero_division=0)
    recall = recall_score(y_test, predictions, zero_division=0)
    f1 = f1_score(y_test, predictions, zero_division=0)
    auc = roc_auc_score(y_test, test_prob)
    positive_rate = float(y.mean())

    # Build profile thresholds from validation probabilities.
    val_prob_final = (rf_weight * rf_val_prob) + ((1.0 - rf_weight) * hgb_val_prob)
    thresholds = {
        "balanced": float(threshold),
        "high_precision": 0.50,
        "high_recall": 0.20,
        "precision_33": float(threshold),
        "max_accuracy": float(threshold),
    }
    for candidate in np.arange(0.10, 0.91, 0.01):
        pred = (val_prob_final >= candidate).astype(int)
        prec = precision_score(y_val, pred, zero_division=0)
        rec = recall_score(y_val, pred, zero_division=0)
        if prec >= 0.50:
            thresholds["high_precision"] = float(candidate)
            break
    for candidate in np.arange(0.10, 0.91, 0.01):
        pred = (val_prob_final >= candidate).astype(int)
        rec = recall_score(y_val, pred, zero_division=0)
        if rec >= 0.70:
            thresholds["high_recall"] = float(candidate)
            break

    # Precision-targeted threshold (>=33%) with best recall under that constraint.
    best_precision33 = None
    for candidate in np.arange(0.10, 0.91, 0.01):
        pred = (val_prob_final >= candidate).astype(int)
        prec = precision_score(y_val, pred, zero_division=0)
        rec = recall_score(y_val, pred, zero_division=0)
        if prec < 0.33:
            continue
        score = (rec, prec)
        if best_precision33 is None or score > best_precision33[0]:
            best_precision33 = (score, float(candidate))
    if best_precision33 is not None:
        thresholds["precision_33"] = best_precision33[1]

    # Accuracy-optimal threshold with minimum recall floor to avoid degenerate all-clear behavior.
    best_acc = None
    for candidate in np.arange(0.10, 0.91, 0.01):
        pred = (val_prob_final >= candidate).astype(int)
        acc = accuracy_score(y_val, pred)
        rec = recall_score(y_val, pred, zero_division=0)
        if rec < 0.20:
            continue
        score = (acc, rec)
        if best_acc is None or score > best_acc[0]:
            best_acc = (score, float(candidate))
    if best_acc is not None:
        thresholds["max_accuracy"] = best_acc[1]

    model_bundle = {
        "model_type": "ensemble",
        "models": {
            "random_forest": rf_model,
            "hist_gradient_boosting": hgb_model,
        },
        "features": FEATURE_COLUMNS,
        "threshold": float(threshold),
        "thresholds": thresholds,
        "rf_weight": float(rf_weight),
        "hgb_weight": float(1.0 - rf_weight),
        "model_name": "rf_hgb_ensemble",
        "random_state": 42,
    }

    model_dir = Path(__file__).resolve().parents[1] / "models"
    model_dir.mkdir(parents=True, exist_ok=True)

    model_path = model_dir / "fleet_ai_model.pkl"
    metadata_path = model_dir / "fleet_ai_model_metadata.json"
    dataset_path = model_dir / "fleet_ai_synthetic_dataset.csv"

    joblib.dump(model_bundle, model_path)
    df.to_csv(dataset_path, index=False)

    metadata = {
        "model_file": str(model_path),
        "features": FEATURE_COLUMNS,
        "rows": int(len(df)),
        "fleet_size": 12,
        "days": 365,
        "observations_per_day": 8,
        "failure_rate": round(positive_rate, 6),
        "accuracy": round(float(accuracy), 6),
        "precision": round(float(precision), 6),
        "recall": round(float(recall), 6),
        "f1": round(float(f1), 6),
        "roc_auc": round(float(auc), 6),
        "threshold": round(float(threshold), 4),
        "thresholds": {k: round(float(v), 4) for k, v in thresholds.items()},
        "rf_weight": round(float(rf_weight), 4),
        "hgb_weight": round(float(1.0 - rf_weight), 4),
        "model_name": "rf_hgb_ensemble",
        "notes": (
            "Synthetic heavy-duty data with weather/elevation/load stress. "
            "Use real maintenance/failure history for production validation."
        ),
        "balance_objective": "maximize [f1 + 0.12*precision + 0.04*accuracy] with utility tie-break U=TP*V_tp-FP*C_fp-FN*C_fn",
    }
    metadata_path.write_text(json.dumps(metadata, indent=2), encoding="utf-8")

    print(f"Rows generated: {len(df)}")
    print(f"Failure rate: {positive_rate:.3%}")
    print(f"Model accuracy: {accuracy:.4f}")
    print(f"Model precision: {precision:.4f}")
    print(f"Model recall: {recall:.4f}")
    print(f"Model F1: {f1:.4f}")
    print(f"Model ROC-AUC: {auc:.4f}")
    print(f"Decision threshold: {threshold:.2f}")
    print(
        "Profile thresholds: "
        f"balanced={thresholds['balanced']:.2f}, "
        f"high_precision={thresholds['high_precision']:.2f}, "
        f"high_recall={thresholds['high_recall']:.2f}, "
        f"precision_33={thresholds['precision_33']:.2f}, "
        f"max_accuracy={thresholds['max_accuracy']:.2f}"
    )
    print(f"Model selected: rf_hgb_ensemble (rf_weight={rf_weight:.2f}, hgb_weight={(1.0-rf_weight):.2f})")
    print(f"Model saved to: {model_path}")
    print(f"Metadata saved to: {metadata_path}")
    print(f"Synthetic dataset saved to: {dataset_path}")


if __name__ == "__main__":
    train_and_save_model()
