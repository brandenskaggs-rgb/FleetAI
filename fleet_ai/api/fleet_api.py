"""FastAPI app for Fleet AI maintenance prediction."""

from pathlib import Path

import joblib
import pandas as pd
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel


class SensorInput(BaseModel):
    rpm: float
    engine_temp: float
    fuel_pressure: float
    battery_voltage: float
    vibration: float
    ambient_temp_c: float = 20.0
    elevation_ft: float = 1000.0
    payload_ratio: float = 0.75
    road_grade_pct: float = 1.0
    idle_hours_day: float = 1.5
    engine_temp_delta_30d: float = 0.0
    fuel_pressure_delta_30d: float = 0.0
    battery_voltage_delta_30d: float = 0.0
    vibration_delta_30d: float = 0.0
    alert_mode: str = "precision_33"


app = FastAPI(title="Fleet AI Predictive Maintenance API")


def load_model():
    """Load trained model once for API predictions."""
    model_path = Path(__file__).resolve().parents[1] / "models" / "fleet_ai_model.pkl"
    if not model_path.exists():
        raise FileNotFoundError(
            f"Model file not found at {model_path}. Train model first."
        )
    loaded = joblib.load(model_path)
    if isinstance(loaded, dict):
        return loaded
    return {"model": loaded, "model_type": "single", "threshold": 0.5}


try:
    MODEL = load_model()
except FileNotFoundError:
    MODEL = None


@app.post("/predict")
def predict(sensor_data: SensorInput):
    """Predict failure risk from incoming sensor payload."""
    if MODEL is None:
        raise HTTPException(
            status_code=503,
            detail="Model unavailable. Run training/fleet_simulation.py to generate it.",
        )

    payload = sensor_data.model_dump() if hasattr(sensor_data, "model_dump") else sensor_data.dict()
    alert_mode = str(payload.pop("alert_mode", "precision_33") or "precision_33").strip().lower()
    input_df = pd.DataFrame([payload])
    model_type = MODEL.get("model_type", "single")
    thresholds = MODEL.get("thresholds", {})
    threshold = float(thresholds.get(alert_mode, MODEL.get("threshold", 0.5)))
    if model_type == "ensemble":
        models = MODEL["models"]
        rf_weight = float(MODEL.get("rf_weight", 0.5))
        hgb_weight = float(MODEL.get("hgb_weight", 0.5))
        rf_prob = float(models["random_forest"].predict_proba(input_df)[0, 1])
        hgb_prob = float(models["hist_gradient_boosting"].predict_proba(input_df)[0, 1])
        risk_score = (rf_weight * rf_prob) + (hgb_weight * hgb_prob)
    else:
        model = MODEL["model"]
        if hasattr(model, "predict_proba"):
            risk_score = float(model.predict_proba(input_df)[0, 1])
        else:
            risk_score = float(model.predict(input_df)[0])
    prediction = int(risk_score >= threshold)
    message = "Failure risk detected" if prediction == 1 else "Truck operating normally"

    return {
        "prediction": prediction,
        "result": message,
        "risk_score": round(risk_score, 6),
        "threshold": threshold,
        "alert_mode": alert_mode,
    }
