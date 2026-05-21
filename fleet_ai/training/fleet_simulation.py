"""Train Fleet AI synthetic pretrained priors across mixed fleet classes.

The generated model is a launch baseline, not proof of real-world production
performance. It gives new vehicles a starting prior while live customer data
calibrates per-vehicle baselines.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier, RandomForestClassifier
from sklearn.metrics import accuracy_score, f1_score, precision_score, recall_score, roc_auc_score
from sklearn.model_selection import train_test_split


MODEL_VERSION = "synthetic-priors-v2.0.0"
TRAINING_SOURCE = "synthetic_10000_vehicle_priors"

VEHICLE_CLASS_CODES = {
    "heavy_duty_j1939": 0,
    "medium_duty": 1,
    "light_duty_truck": 2,
    "cargo_van": 3,
    "passenger_car": 4,
}

PROTOCOL_CODES = {"J1939": 0, "OBD2": 1}
POWERTRAIN_CODES = {"diesel": 0, "gasoline": 1, "hybrid": 2}

MAKE_MODEL_PROFILES = [
    ("Freightliner", "Cascadia", "heavy_duty_j1939", "J1939", "diesel"),
    ("Volvo", "VNL", "heavy_duty_j1939", "J1939", "diesel"),
    ("Peterbilt", "579", "heavy_duty_j1939", "J1939", "diesel"),
    ("Kenworth", "T680", "heavy_duty_j1939", "J1939", "diesel"),
    ("International", "LT", "heavy_duty_j1939", "J1939", "diesel"),
    ("Freightliner", "M2", "medium_duty", "J1939", "diesel"),
    ("Ford", "F-650", "medium_duty", "J1939", "diesel"),
    ("Ford", "F-150", "light_duty_truck", "OBD2", "gasoline"),
    ("Ford", "F-250", "light_duty_truck", "OBD2", "gasoline"),
    ("Chevrolet", "Silverado", "light_duty_truck", "OBD2", "gasoline"),
    ("Ram", "2500", "light_duty_truck", "OBD2", "gasoline"),
    ("Ford", "Transit", "cargo_van", "OBD2", "gasoline"),
    ("Chevrolet", "Express", "cargo_van", "OBD2", "gasoline"),
    ("Ram", "ProMaster", "cargo_van", "OBD2", "gasoline"),
    ("Toyota", "Camry", "passenger_car", "OBD2", "gasoline"),
    ("Toyota", "RAV4", "passenger_car", "OBD2", "hybrid"),
]

MAKE_CODES = {make: idx for idx, make in enumerate(sorted({p[0] for p in MAKE_MODEL_PROFILES}))}

FEATURE_COLUMNS = [
    "vehicle_class_code",
    "protocol_code",
    "make_code",
    "powertrain_code",
    "model_year",
    "odometer_miles",
    "engine_hours",
    "rpm",
    "engine_temp",
    "oil_temp",
    "transmission_temp",
    "fuel_pressure",
    "fuel_rate",
    "battery_voltage",
    "vibration",
    "dpf_soot_load",
    "brake_temp",
    "tire_pressure",
    "ambient_temp_c",
    "elevation_ft",
    "payload_ratio",
    "road_grade_pct",
    "idle_hours_day",
    "stop_go_ratio",
    "long_haul_ratio",
    "towing_ratio",
    "maintenance_neglect",
    "sensor_missing_rate",
    "engine_temp_delta_30d",
    "fuel_pressure_delta_30d",
    "battery_voltage_delta_30d",
    "vibration_delta_30d",
    "dpf_soot_delta_30d",
    "brake_temp_delta_30d",
]

BASELINE_METRICS = [
    "rpm",
    "engine_temp",
    "oil_temp",
    "transmission_temp",
    "fuel_pressure",
    "fuel_rate",
    "battery_voltage",
    "vibration",
    "dpf_soot_load",
    "brake_temp",
    "tire_pressure",
]


@dataclass(frozen=True)
class Profile:
    make: str
    model: str
    vehicle_class: str
    protocol: str
    powertrain: str

    @property
    def profile_key(self) -> str:
        return f"{self.vehicle_class}:{self.make}:{self.model}".lower().replace(" ", "_")


def _sigmoid(x: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-x))


def _class_factor(vehicle_class: np.ndarray, mapping: dict[str, float]) -> np.ndarray:
    out = np.zeros(len(vehicle_class))
    for key, value in mapping.items():
        out = np.where(vehicle_class == key, value, out)
    return out


def generate_mixed_fleet_data(
    fleet_size: int = 10000,
    days: int = 45,
    observations_per_day: int = 1,
    seed: int = 42,
) -> pd.DataFrame:
    """Generate mixed synthetic fleet operations with class/make/model priors."""
    rng = np.random.default_rng(seed)
    rows = int(fleet_size * days * observations_per_day)
    vehicle_idx = np.repeat(np.arange(fleet_size), days * observations_per_day)
    day_idx = np.tile(np.repeat(np.arange(days), observations_per_day), fleet_size)

    profile_choices = np.array(MAKE_MODEL_PROFILES, dtype=object)
    vehicle_profiles_idx = rng.choice(len(profile_choices), size=fleet_size, replace=True)
    selected = profile_choices[vehicle_profiles_idx[vehicle_idx]]
    make = selected[:, 0]
    model = selected[:, 1]
    vehicle_class = selected[:, 2]
    protocol = selected[:, 3]
    powertrain = selected[:, 4]

    vehicle_class_code = np.vectorize(VEHICLE_CLASS_CODES.get)(vehicle_class)
    protocol_code = np.vectorize(PROTOCOL_CODES.get)(protocol)
    make_code = np.vectorize(MAKE_CODES.get)(make)
    powertrain_code = np.vectorize(POWERTRAIN_CODES.get)(powertrain)

    model_year_vehicle = rng.integers(2014, 2027, size=fleet_size)
    model_year = model_year_vehicle[vehicle_idx]
    age_years = np.clip(2026 - model_year, 0, 14)

    region = rng.choice(["hot", "cold", "mountain", "temperate", "coastal"], size=rows, p=[0.20, 0.20, 0.18, 0.32, 0.10])
    ambient_temp_c = np.select(
        [region == "hot", region == "cold", region == "mountain", region == "coastal"],
        [
            rng.normal(36, 8, rows),
            rng.normal(-6, 10, rows),
            rng.normal(8, 10, rows),
            rng.normal(20, 6, rows),
        ],
        default=rng.normal(18, 9, rows),
    )
    seasonal = 8.0 * np.sin((day_idx / 365.0) * 2 * np.pi)
    ambient_temp_c = ambient_temp_c + seasonal

    elevation_ft = np.select(
        [region == "mountain", region == "hot", region == "cold"],
        [rng.normal(6200, 1700, rows), rng.normal(1400, 800, rows), rng.normal(1900, 900, rows)],
        default=rng.normal(900, 650, rows),
    )
    elevation_ft = np.clip(elevation_ft, 0, 12000)

    heavy = vehicle_class == "heavy_duty_j1939"
    medium = vehicle_class == "medium_duty"
    light = vehicle_class == "light_duty_truck"
    van = vehicle_class == "cargo_van"
    car = vehicle_class == "passenger_car"

    payload_ratio = np.clip(
        np.where(heavy, rng.beta(5.2, 2.1, rows),
        np.where(medium, rng.beta(4.0, 2.4, rows),
        np.where(light | van, rng.beta(3.0, 3.0, rows), rng.beta(1.8, 5.5, rows)))),
        0.05,
        1.05,
    )
    stop_go_ratio = np.clip(np.where(van | car, rng.beta(4.0, 2.4, rows), rng.beta(2.2, 4.0, rows)), 0, 1)
    long_haul_ratio = np.clip(np.where(heavy, rng.beta(4.5, 2.0, rows), rng.beta(1.6, 5.2, rows)), 0, 1)
    towing_ratio = np.clip(np.where(light, rng.beta(1.4, 7.0, rows), np.where(heavy | medium, rng.beta(2.2, 4.0, rows), 0)), 0, 1)
    road_grade_pct = np.clip(rng.normal(1.0, 0.9, rows) + np.where(region == "mountain", 2.6, 0), 0, 8.5)
    idle_hours_day = np.clip(
        rng.normal(1.0, 0.6, rows)
        + np.where(heavy, 0.7, 0)
        + np.where(region == "cold", 0.7, 0)
        + stop_go_ratio * 0.6,
        0,
        6,
    )
    odometer_vehicle = rng.uniform(8000, 780000, size=fleet_size)
    odometer_miles = odometer_vehicle[vehicle_idx] + day_idx * np.where(heavy, 320, np.where(car, 70, 140))
    engine_hours = np.clip(odometer_miles / np.where(heavy, 38, np.where(car, 31, 27)), 100, 45000)
    maintenance_neglect = np.clip(rng.beta(1.5, 5.0, fleet_size)[vehicle_idx] + age_years / 40, 0, 1)
    sensor_missing_rate = np.clip(rng.beta(1.0, 16.0, rows) + np.where(model_year < 2015, 0.08, 0), 0, 0.42)

    temp_stress = np.clip((ambient_temp_c - 32) / 18, 0, 2.2) + np.clip((-ambient_temp_c - 6) / 18, 0, 2.2)
    altitude_stress = np.clip(elevation_ft / 7000, 0, 1.8)
    load_stress = np.clip((payload_ratio - 0.55) / 0.45, 0, 1.4)
    age_stress = np.clip(age_years / 10, 0, 1.4)

    base_rpm = np.where(heavy, 1180, np.where(medium, 1450, np.where(car, 1900, 1750)))
    rpm = base_rpm + 560 * payload_ratio + 78 * road_grade_pct + 95 * towing_ratio + rng.normal(0, np.where(heavy, 85, 160), rows)
    rpm = np.clip(rpm, 550, np.where(heavy, 3200, 6200))

    engine_temp = 78 + 0.010 * rpm + 0.31 * ambient_temp_c + 2.2 * road_grade_pct + 2.7 * load_stress + 3.2 * maintenance_neglect + rng.normal(0, 3.8, rows)
    oil_temp = engine_temp + np.where(heavy, 10, 7) + 3.0 * load_stress + rng.normal(0, 2.2, rows)
    transmission_temp = 70 + 0.006 * rpm + 2.6 * towing_ratio + 2.0 * road_grade_pct + 0.22 * ambient_temp_c + rng.normal(0, 3.0, rows)
    fuel_pressure = np.where(powertrain == "diesel", 63, 51) - 4.5 * altitude_stress - 2.0 * temp_stress - 3.0 * maintenance_neglect + rng.normal(0, 2.9, rows)
    fuel_rate = np.where(heavy, 8.5, np.where(medium, 5.2, np.where(car, 1.9, 3.2))) + 0.0026 * rpm + 2.5 * load_stress + 0.8 * road_grade_pct + rng.normal(0, 0.7, rows)
    battery_voltage = 14.0 - 0.055 * np.clip(-ambient_temp_c, 0, 40) - 0.13 * idle_hours_day - 0.18 * maintenance_neglect + rng.normal(0, 0.22, rows)
    vibration = 0.18 + 0.62 * load_stress + 0.11 * road_grade_pct + 0.10 * towing_ratio + 0.26 * maintenance_neglect + rng.normal(0, 0.10, rows)
    dpf_soot_load = np.where(powertrain == "diesel", 22 + 22 * idle_hours_day + 15 * stop_go_ratio + 16 * maintenance_neglect + rng.normal(0, 8, rows), 0)
    brake_temp = 95 + 24 * stop_go_ratio + 8 * payload_ratio + 6 * road_grade_pct + 10 * towing_ratio + rng.normal(0, 8, rows)
    tire_pressure = np.where(heavy, 690, np.where(medium, 570, np.where(car, 230, 250))) - 20 * age_stress - 22 * maintenance_neglect + rng.normal(0, np.where(heavy, 22, 12), rows)

    wear_progress = np.clip((day_idx / max(days, 1)) + age_stress * 0.22 + maintenance_neglect * 0.55, 0, 1.8)
    engine_temp_delta_30d = 1.0 + 5.2 * wear_progress + 1.6 * temp_stress + 1.3 * load_stress + rng.normal(0, 1.8, rows)
    fuel_pressure_delta_30d = -0.5 - 4.0 * wear_progress - 0.9 * altitude_stress - 1.1 * maintenance_neglect + rng.normal(0, 1.4, rows)
    battery_voltage_delta_30d = -0.05 - 0.45 * wear_progress - 0.08 * idle_hours_day + rng.normal(0, 0.10, rows)
    vibration_delta_30d = 0.05 + 0.55 * wear_progress + 0.10 * road_grade_pct + rng.normal(0, 0.09, rows)
    dpf_soot_delta_30d = np.where(powertrain == "diesel", 1.0 + 18 * wear_progress + 7 * stop_go_ratio + rng.normal(0, 4, rows), 0)
    brake_temp_delta_30d = 0.8 + 12 * wear_progress + 5 * stop_go_ratio + 4 * towing_ratio + rng.normal(0, 3, rows)

    subsystem_scores = {
        "cooling": -6.0 + 1.9 * (engine_temp > np.where(heavy, 108, 112)) + 1.3 * (engine_temp_delta_30d > 7) + 0.8 * temp_stress + 0.8 * maintenance_neglect,
        "charging": -6.2 + 1.8 * (battery_voltage < 12.2) + 1.1 * (battery_voltage_delta_30d < -0.35) + 0.7 * idle_hours_day + 0.8 * age_stress,
        "fuel": -6.4 + 1.7 * (fuel_pressure < np.where(powertrain == "diesel", 42, 36)) + 1.0 * (fuel_pressure_delta_30d < -4.0) + 0.7 * altitude_stress,
        "dpf_emissions": -7.0 + 2.1 * (dpf_soot_load > 78) + 1.4 * (dpf_soot_delta_30d > 18) + 0.9 * stop_go_ratio,
        "drivetrain": -6.3 + 1.3 * (transmission_temp > 110) + 1.1 * (vibration > 1.15) + 0.9 * towing_ratio + 0.8 * road_grade_pct / 5,
        "brakes_tires": -6.0 + 1.6 * (brake_temp > 145) + 1.5 * (tire_pressure < np.where(heavy, 620, 205)) + 0.9 * stop_go_ratio,
        "engine_wear": -6.1 + 1.5 * (oil_temp > 124) + 1.1 * (rpm > np.where(heavy, 2650, 4300)) + 1.2 * age_stress + 0.9 * maintenance_neglect,
    }
    subsystem_prob = {name: _sigmoid(score) for name, score in subsystem_scores.items()}
    risk_score = np.maximum.reduce(list(subsystem_scores.values()))
    # Use a low-noise synthetic label so the pretrained prior learns actual
    # degradation patterns instead of mostly sampling noise. Real fleet history
    # should still replace or recalibrate this launch prior.
    failure_probability = _sigmoid((risk_score + 1.05) * 1.45)
    failure_signal = failure_probability + rng.normal(0.0, 0.055, rows)
    failure = (failure_signal >= 0.46).astype(int)
    subsystem = np.array(list(subsystem_prob.keys()))[
        np.argmax(np.vstack(list(subsystem_prob.values())), axis=0)
    ]

    return pd.DataFrame(
        {
            "vehicle_id": [f"SIM-{idx:05d}" for idx in vehicle_idx],
            "profile_key": [Profile(a, b, c, d, e).profile_key for a, b, c, d, e in zip(make, model, vehicle_class, protocol, powertrain)],
            "make": make,
            "model": model,
            "vehicle_class": vehicle_class,
            "protocol": protocol,
            "powertrain": powertrain,
            "vehicle_class_code": vehicle_class_code,
            "protocol_code": protocol_code,
            "make_code": make_code,
            "powertrain_code": powertrain_code,
            "model_year": model_year,
            "odometer_miles": np.round(odometer_miles, 1),
            "engine_hours": np.round(engine_hours, 1),
            "rpm": np.round(rpm, 2),
            "engine_temp": np.round(engine_temp, 2),
            "oil_temp": np.round(oil_temp, 2),
            "transmission_temp": np.round(transmission_temp, 2),
            "fuel_pressure": np.round(fuel_pressure, 2),
            "fuel_rate": np.round(fuel_rate, 3),
            "battery_voltage": np.round(battery_voltage, 3),
            "vibration": np.round(vibration, 4),
            "dpf_soot_load": np.round(dpf_soot_load, 2),
            "brake_temp": np.round(brake_temp, 2),
            "tire_pressure": np.round(tire_pressure, 2),
            "ambient_temp_c": np.round(ambient_temp_c, 2),
            "elevation_ft": np.round(elevation_ft, 1),
            "payload_ratio": np.round(payload_ratio, 4),
            "road_grade_pct": np.round(road_grade_pct, 4),
            "idle_hours_day": np.round(idle_hours_day, 4),
            "stop_go_ratio": np.round(stop_go_ratio, 4),
            "long_haul_ratio": np.round(long_haul_ratio, 4),
            "towing_ratio": np.round(towing_ratio, 4),
            "maintenance_neglect": np.round(maintenance_neglect, 4),
            "sensor_missing_rate": np.round(sensor_missing_rate, 4),
            "engine_temp_delta_30d": np.round(engine_temp_delta_30d, 4),
            "fuel_pressure_delta_30d": np.round(fuel_pressure_delta_30d, 4),
            "battery_voltage_delta_30d": np.round(battery_voltage_delta_30d, 4),
            "vibration_delta_30d": np.round(vibration_delta_30d, 4),
            "dpf_soot_delta_30d": np.round(dpf_soot_delta_30d, 4),
            "brake_temp_delta_30d": np.round(brake_temp_delta_30d, 4),
            "failure": failure.astype(int),
            "failure_probability_true": np.round(failure_probability, 6),
            "failure_subsystem": subsystem,
        }
    )


def generate_heavy_duty_data(
    fleet_size: int = 12,
    days: int = 365,
    observations_per_day: int = 8,
    seed: int = 42,
) -> pd.DataFrame:
    """Backward-compatible helper used by existing evaluation scripts."""
    df = generate_mixed_fleet_data(fleet_size=fleet_size, days=days, observations_per_day=observations_per_day, seed=seed)
    return df[df["vehicle_class"].eq("heavy_duty_j1939")].copy()


def build_baseline_profiles(df: pd.DataFrame) -> dict:
    profiles = {}
    grouped = df.groupby(["profile_key", "vehicle_class", "make", "model", "protocol", "powertrain"], sort=True)
    for (profile_key, vehicle_class, make, model, protocol, powertrain), group in grouped:
        metrics = {}
        for metric in BASELINE_METRICS:
            values = group[metric].dropna()
            metrics[metric] = {
                "mean": round(float(values.mean()), 6),
                "std": round(float(values.std(ddof=0)), 6),
                "p10": round(float(values.quantile(0.10)), 6),
                "p50": round(float(values.quantile(0.50)), 6),
                "p90": round(float(values.quantile(0.90)), 6),
            }
        subsystem_counts = group["failure_subsystem"].value_counts(normalize=True).to_dict()
        profiles[profile_key] = {
            "profileKey": profile_key,
            "vehicleClass": vehicle_class,
            "make": make,
            "model": model,
            "protocol": protocol,
            "powertrain": powertrain,
            "trainingSource": TRAINING_SOURCE,
            "modelVersion": MODEL_VERSION,
            "sampleCount": int(len(group)),
            "failureRate": round(float(group["failure"].mean()), 6),
            "baselineMetrics": metrics,
            "subsystemPriors": {k: round(float(v), 6) for k, v in subsystem_counts.items()},
        }
    return profiles


def train_and_save_model(fleet_size: int = 10000, days: int = 45, observations_per_day: int = 1, seed: int = 42) -> None:
    df = generate_mixed_fleet_data(fleet_size=fleet_size, days=days, observations_per_day=observations_per_day, seed=seed)
    X = df[FEATURE_COLUMNS]
    y = df["failure"]

    X_dev, X_test, y_dev, y_test = train_test_split(X, y, test_size=0.22, random_state=seed, stratify=y)
    X_train, X_val, y_train, y_val = train_test_split(X_dev, y_dev, test_size=0.20, random_state=seed, stratify=y_dev)

    rf_model = RandomForestClassifier(
        n_estimators=180,
        max_depth=13,
        min_samples_leaf=4,
        random_state=seed,
        class_weight="balanced_subsample",
        n_jobs=-1,
    )
    hgb_model = HistGradientBoostingClassifier(
        max_depth=8,
        learning_rate=0.055,
        max_iter=320,
        l2_regularization=0.08,
        random_state=seed,
    )
    rf_model.fit(X_train, y_train)
    hgb_model.fit(X_train, y_train)

    rf_val_prob = rf_model.predict_proba(X_val)[:, 1]
    hgb_val_prob = hgb_model.predict_proba(X_val)[:, 1]
    best = None
    best_tuple = (0.55, 0.32)
    for rf_weight in np.arange(0.20, 0.86, 0.05):
        val_prob = (rf_weight * rf_val_prob) + ((1.0 - rf_weight) * hgb_val_prob)
        for threshold in np.arange(0.10, 0.81, 0.01):
            val_pred = (val_prob >= threshold).astype(int)
            precision = precision_score(y_val, val_pred, zero_division=0)
            recall = recall_score(y_val, val_pred, zero_division=0)
            f1 = f1_score(y_val, val_pred, zero_division=0)
            if precision < 0.55 or recall < 0.45:
                continue
            score = (f1 + 0.18 * precision + 0.05 * recall, precision, recall)
            if best is None or score > best:
                best = score
                best_tuple = (float(rf_weight), float(threshold))
    if best is None:
        for rf_weight in np.arange(0.20, 0.86, 0.05):
            val_prob = (rf_weight * rf_val_prob) + ((1.0 - rf_weight) * hgb_val_prob)
            for threshold in np.arange(0.10, 0.91, 0.01):
                val_pred = (val_prob >= threshold).astype(int)
                precision = precision_score(y_val, val_pred, zero_division=0)
                recall = recall_score(y_val, val_pred, zero_division=0)
                f1 = f1_score(y_val, val_pred, zero_division=0)
                if recall < 0.25:
                    continue
                score = (f1 + 0.22 * precision, precision, recall)
                if best is None or score > best:
                    best = score
                    best_tuple = (float(rf_weight), float(threshold))

    rf_weight, threshold = best_tuple
    hgb_weight = 1.0 - rf_weight
    rf_test_prob = rf_model.predict_proba(X_test)[:, 1]
    hgb_test_prob = hgb_model.predict_proba(X_test)[:, 1]
    test_prob = (rf_weight * rf_test_prob) + (hgb_weight * hgb_test_prob)
    predictions = (test_prob >= threshold).astype(int)

    thresholds = {
        "balanced": float(threshold),
        "high_precision": 0.55,
        "high_recall": 0.18,
        "launch_default": float(threshold),
    }

    model_bundle = {
        "model_type": "ensemble",
        "models": {"random_forest": rf_model, "hist_gradient_boosting": hgb_model},
        "features": FEATURE_COLUMNS,
        "threshold": float(threshold),
        "thresholds": thresholds,
        "rf_weight": float(rf_weight),
        "hgb_weight": float(hgb_weight),
        "model_name": "mixed_fleet_rf_hgb_ensemble",
        "model_version": MODEL_VERSION,
        "training_source": TRAINING_SOURCE,
        "vehicle_class_codes": VEHICLE_CLASS_CODES,
        "protocol_codes": PROTOCOL_CODES,
        "make_codes": MAKE_CODES,
        "powertrain_codes": POWERTRAIN_CODES,
    }

    profiles = build_baseline_profiles(df)
    class_report = {}
    eval_df = X_test.copy()
    eval_df["actual"] = y_test.to_numpy()
    eval_df["predicted"] = predictions
    eval_df["vehicle_class_code"] = X_test["vehicle_class_code"].to_numpy()
    inverse_class = {v: k for k, v in VEHICLE_CLASS_CODES.items()}
    for class_code, group in eval_df.groupby("vehicle_class_code"):
        actual = group["actual"]
        predicted = group["predicted"]
        class_report[inverse_class[int(class_code)]] = {
            "rows": int(len(group)),
            "precision": round(float(precision_score(actual, predicted, zero_division=0)), 6),
            "recall": round(float(recall_score(actual, predicted, zero_division=0)), 6),
            "f1": round(float(f1_score(actual, predicted, zero_division=0)), 6),
            "failureRate": round(float(actual.mean()), 6),
        }

    model_dir = Path(__file__).resolve().parents[1] / "models"
    model_dir.mkdir(parents=True, exist_ok=True)
    model_path = model_dir / "fleet_ai_model.pkl"
    metadata_path = model_dir / "fleet_ai_model_metadata.json"
    dataset_path = model_dir / "fleet_ai_synthetic_dataset.csv"
    profiles_path = model_dir / "fleet_ai_baseline_profiles.json"
    eval_path = model_dir / "fleet_ai_eval_report.json"

    joblib.dump(model_bundle, model_path)
    df.to_csv(dataset_path, index=False)
    profiles_path.write_text(json.dumps({"modelVersion": MODEL_VERSION, "profiles": profiles}, indent=2), encoding="utf-8")

    metadata = {
        "model_file": str(model_path),
        "modelVersion": MODEL_VERSION,
        "trainingSource": TRAINING_SOURCE,
        "features": FEATURE_COLUMNS,
        "rows": int(len(df)),
        "fleet_size": int(fleet_size),
        "days": int(days),
        "observations_per_day": int(observations_per_day),
        "vehicle_classes": sorted(VEHICLE_CLASS_CODES.keys()),
        "make_model_profiles": [{"make": a, "model": b, "vehicleClass": c, "protocol": d, "powertrain": e} for a, b, c, d, e in MAKE_MODEL_PROFILES],
        "failure_rate": round(float(y.mean()), 6),
        "accuracy": round(float(accuracy_score(y_test, predictions)), 6),
        "precision": round(float(precision_score(y_test, predictions, zero_division=0)), 6),
        "recall": round(float(recall_score(y_test, predictions, zero_division=0)), 6),
        "f1": round(float(f1_score(y_test, predictions, zero_division=0)), 6),
        "roc_auc": round(float(roc_auc_score(y_test, test_prob)), 6),
        "threshold": round(float(threshold), 4),
        "thresholds": {k: round(float(v), 4) for k, v in thresholds.items()},
        "rf_weight": round(float(rf_weight), 4),
        "hgb_weight": round(float(hgb_weight), 4),
        "model_name": "mixed_fleet_rf_hgb_ensemble",
        "notes": "Simulation-backed pretrained priors. Live customer telemetry calibrates each vehicle after onboarding.",
    }
    metadata_path.write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    eval_path.write_text(json.dumps({"overall": metadata, "byVehicleClass": class_report}, indent=2), encoding="utf-8")

    print(f"Rows generated: {len(df)}")
    print(f"Vehicles simulated: {fleet_size}")
    print(f"Failure rate: {y.mean():.3%}")
    print(f"Precision: {metadata['precision']:.4f}")
    print(f"Recall: {metadata['recall']:.4f}")
    print(f"ROC-AUC: {metadata['roc_auc']:.4f}")
    print(f"Model saved to: {model_path}")
    print(f"Baseline profiles saved to: {profiles_path}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Train Fleet AI synthetic pretrained priors.")
    parser.add_argument("--fleet-size", type=int, default=10000)
    parser.add_argument("--days", type=int, default=45)
    parser.add_argument("--observations-per-day", type=int, default=1)
    parser.add_argument("--seed", type=int, default=42)
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    train_and_save_model(
        fleet_size=args.fleet_size,
        days=args.days,
        observations_per_day=args.observations_per_day,
        seed=args.seed,
    )
