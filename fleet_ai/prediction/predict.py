"""Run inference for Fleet AI predictive maintenance."""

from pathlib import Path

import joblib
import pandas as pd


def load_model():
    """Load trained model from the models directory."""
    model_path = Path(__file__).resolve().parents[1] / "models" / "fleet_ai_model.pkl"
    if not model_path.exists():
        raise FileNotFoundError(
            f"Model file not found at {model_path}. Run training/fleet_simulation.py first."
        )
    return joblib.load(model_path)


def main() -> None:
    """Create sample sensor input and print prediction result."""
    loaded = load_model()
    model = loaded
    threshold = 0.5
    rf_weight = 0.5
    hgb_weight = 0.5
    model_type = "single"
    alert_mode = "precision_33"
    if isinstance(loaded, dict):
        thresholds = loaded.get("thresholds", {})
        threshold = float(thresholds.get(alert_mode, loaded.get("threshold", 0.5)))
        model_type = loaded.get("model_type", "single")
        if model_type == "ensemble":
            rf_weight = float(loaded.get("rf_weight", 0.5))
            hgb_weight = float(loaded.get("hgb_weight", 0.5))
        elif "model" in loaded:
            model = loaded["model"]

    sample_data = pd.DataFrame(
        [
            {
                "rpm": 2600,
                "engine_temp": 108,
                "fuel_pressure": 43,
                "battery_voltage": 12.4,
                "vibration": 1.05,
                "ambient_temp_c": 38,
                "elevation_ft": 4200,
                "payload_ratio": 0.88,
                "road_grade_pct": 3.2,
                "idle_hours_day": 2.4,
                "engine_temp_delta_30d": 8.0,
                "fuel_pressure_delta_30d": -3.8,
                "battery_voltage_delta_30d": -0.28,
                "vibration_delta_30d": 0.41,
            }
        ]
    )

    if model_type == "ensemble" and isinstance(loaded, dict):
        models = loaded["models"]
        rf_prob = float(models["random_forest"].predict_proba(sample_data)[0, 1])
        hgb_prob = float(models["hist_gradient_boosting"].predict_proba(sample_data)[0, 1])
        probability = (rf_weight * rf_prob) + (hgb_weight * hgb_prob)
    elif hasattr(model, "predict_proba"):
        probability = float(model.predict_proba(sample_data)[0, 1])
    else:
        probability = float(model.predict(sample_data)[0])
    prediction = int(probability >= threshold)

    if prediction == 1:
        print(f"Failure risk detected (risk={probability:.2%}, threshold={threshold:.2f})")
    else:
        print(f"Truck operating normally (risk={probability:.2%}, threshold={threshold:.2f})")


if __name__ == "__main__":
    main()
