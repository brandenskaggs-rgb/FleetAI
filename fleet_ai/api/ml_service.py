"""Fleet AI Python ML service.

Primary inference path for pretrained synthetic priors. The Node backend calls
this service and falls back to deterministic JavaScript scoring if unavailable.
"""

from __future__ import annotations

import json
import hmac
import os
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

import joblib
import pandas as pd
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

# Shared RF missing-value matrix builder (see fleet_ai/physics/vehicle_physics.py).
# Falls back to feeding RF the same matrix as HGB if the registry is unreachable
# (e.g. stripped deploy) or the loaded model bundle predates this fix — matches
# the old (pre-imputer) behavior rather than hard-crashing the service.
_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))
try:
    from fleet_ai.physics.vehicle_physics import build_rf_matrix
except Exception:
    build_rf_matrix = None


ROOT = Path(__file__).resolve().parents[1]
MODELS_DIR = ROOT / "models"
MODEL_PATH = MODELS_DIR / "fleet_ai_model.pkl"
METADATA_PATH = MODELS_DIR / "fleet_ai_model_metadata.json"
PROFILES_PATH = MODELS_DIR / "fleet_ai_baseline_profiles.json"

app = FastAPI(title="Fleet AI ML Service", version="2.0.0")
_ML_INTERNAL_TOKEN = os.getenv("FLEETAI_ML_INTERNAL_TOKEN", "").strip()


@app.middleware("http")
async def require_internal_service_token(request: Request, call_next):
    supplied = request.headers.get("x-fleetai-ml-token", "")
    if _ML_INTERNAL_TOKEN and hmac.compare_digest(supplied, _ML_INTERNAL_TOKEN):
        return await call_next(request)
    client_host = request.client.host if request.client else ""
    if not _ML_INTERNAL_TOKEN and client_host in {"127.0.0.1", "::1", "testclient"}:
        return await call_next(request)
    status = 503 if not _ML_INTERNAL_TOKEN else 401
    code = "ML_SERVICE_AUTH_NOT_CONFIGURED" if not _ML_INTERNAL_TOKEN else "ML_SERVICE_AUTH_REQUIRED"
    return JSONResponse(status_code=status, content={"ok": False, "error": code})


class VehicleMeta(BaseModel):
    vehicleId: Optional[str] = None
    vin: Optional[str] = None
    make: Optional[str] = None
    model: Optional[str] = None
    year: Optional[int] = None
    protocol: Optional[str] = None
    vehicleClass: Optional[str] = None
    powertrain: Optional[str] = None


class TelemetrySample(BaseModel):
    ts: Optional[str] = None
    metrics: Dict[str, Any] = Field(default_factory=dict)
    raw: Dict[str, Any] = Field(default_factory=dict)
    odometer: Optional[float] = None
    engineHours: Optional[float] = None


class PredictRequest(BaseModel):
    orgId: Optional[str] = None
    vehicleId: str
    vehicleMeta: VehicleMeta = Field(default_factory=VehicleMeta)
    samples: List[TelemetrySample] = Field(default_factory=list)
    alertMode: str = "launch_default"


MODEL: Optional[dict] = None
METADATA: dict = {}
PROFILES: dict = {}


def _load_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def load_artifacts(force: bool = False) -> None:
    global MODEL, METADATA, PROFILES
    if MODEL is not None and not force:
        return
    from backend.app.ml.artifact_registry import configured_registry
    registry = configured_registry()
    MODEL = registry.load_active("pretrained") if registry else None
    if MODEL is None and MODEL_PATH.exists():
        loaded = joblib.load(MODEL_PATH)
        MODEL = loaded if isinstance(loaded, dict) else {"model": loaded, "model_type": "single", "threshold": 0.5}
    if MODEL and MODEL.get("artifactId"):
        METADATA = MODEL.get("metadata", {})
        PROFILES = MODEL.get("baseline_profiles", {})
    else:
        METADATA = _load_json(METADATA_PATH, {})
        profile_payload = _load_json(PROFILES_PATH, {"profiles": {}})
        PROFILES = profile_payload.get("profiles", profile_payload if isinstance(profile_payload, dict) else {})


def _norm(value: Any) -> str:
    return str(value or "").strip().lower().replace(" ", "_")


def infer_vehicle_class(meta: VehicleMeta) -> str:
    explicit = _norm(meta.vehicleClass)
    if explicit:
        return explicit
    protocol = str(meta.protocol or "").upper()
    make = _norm(meta.make)
    model = _norm(meta.model)
    if protocol == "J1939" or model in {"cascadia", "vnl", "579", "t680", "lt"}:
        return "heavy_duty_j1939"
    if model in {"m2", "f-650", "f650"}:
        return "medium_duty"
    if model in {"transit", "express", "promaster"}:
        return "cargo_van"
    if make in {"freightliner", "volvo", "peterbilt", "kenworth", "international"}:
        return "heavy_duty_j1939"
    if make in {"ford", "chevrolet", "ram"}:
        return "light_duty_truck"
    return "passenger_car"


def resolve_profile(meta: VehicleMeta) -> dict:
    load_artifacts()
    vehicle_class = infer_vehicle_class(meta)
    make = _norm(meta.make)
    model = _norm(meta.model)
    candidates = []
    if make and model:
        candidates.append(f"{vehicle_class}:{make}:{model}")
    if make:
        candidates.extend([key for key, profile in PROFILES.items() if _norm(profile.get("make")) == make and profile.get("vehicleClass") == vehicle_class])
    candidates.extend([key for key, profile in PROFILES.items() if profile.get("vehicleClass") == vehicle_class])
    for key in candidates:
        profile = PROFILES.get(key)
        if profile:
            return profile
    return {
        "profileKey": "unknown",
        "vehicleClass": vehicle_class,
        "make": meta.make or "Unknown",
        "model": meta.model or "Unknown",
        "protocol": meta.protocol or ("J1939" if vehicle_class == "heavy_duty_j1939" else "OBD2"),
        "powertrain": meta.powertrain or ("diesel" if vehicle_class in {"heavy_duty_j1939", "medium_duty"} else "gasoline"),
        "trainingSource": "synthetic_prior_unmatched",
        "modelVersion": METADATA.get("modelVersion", "unknown"),
        "sampleCount": 0,
        "failureRate": None,
        "baselineMetrics": {},
        "subsystemPriors": {},
    }


def _num(value: Any, default: Optional[float] = None) -> Optional[float]:
    try:
        if value is None or value == "":
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def latest_metric(samples: List[TelemetrySample], names: List[str], default: Optional[float] = None) -> Optional[float]:
    normalized_names = {name.lower() for name in names}
    for sample in reversed(samples):
        data = {**(sample.raw or {}), **(sample.metrics or {})}
        for name in names:
            val = _num(data.get(name))
            if val is None:
                continue
            # Adapter transitions can briefly emit zero-filled frames. Those
            # frames are transport artifacts, not physical charging evidence.
            if {"battery_voltage", "batteryvoltage"} & normalized_names and not 5 <= val <= 40:
                continue
            if "rpm" in normalized_names and not 0 <= val <= 10_000:
                continue
            if val is not None:
                return val
    return default


def delta_from_profile(current: Optional[float], profile: dict, metric: str) -> float:
    mean = _num(profile.get("baselineMetrics", {}).get(metric, {}).get("mean"), 0.0)
    if current is None or mean is None:
        return 0.0
    return float(current - mean)


def feature_vector(req: PredictRequest, profile: dict) -> dict:
    samples = req.samples or []
    meta = req.vehicleMeta
    codes = MODEL or {}
    vehicle_class = profile.get("vehicleClass") or infer_vehicle_class(meta)
    protocol = profile.get("protocol") or meta.protocol or ("J1939" if vehicle_class == "heavy_duty_j1939" else "OBD2")
    powertrain = profile.get("powertrain") or meta.powertrain or ("diesel" if protocol == "J1939" else "gasoline")
    make = profile.get("make") or meta.make or "Unknown"

    rpm = latest_metric(samples, ["rpm"], profile.get("baselineMetrics", {}).get("rpm", {}).get("mean", 1500))
    engine_temp = latest_metric(samples, ["engine_temp", "coolantTemp", "coolant_temp"], profile.get("baselineMetrics", {}).get("engine_temp", {}).get("mean", 94))
    oil_temp = latest_metric(samples, ["oil_temp", "oilTemp"], profile.get("baselineMetrics", {}).get("oil_temp", {}).get("mean", engine_temp or 98))
    transmission_temp = latest_metric(samples, ["transmission_temp", "transmissionTemp"], profile.get("baselineMetrics", {}).get("transmission_temp", {}).get("mean", 90))
    fuel_pressure = latest_metric(samples, ["fuel_pressure", "fuelRailPressure", "fuel_rail"], profile.get("baselineMetrics", {}).get("fuel_pressure", {}).get("mean", 52))
    fuel_rate = latest_metric(samples, ["fuel_rate", "fuelRate"], profile.get("baselineMetrics", {}).get("fuel_rate", {}).get("mean", 5))
    battery_voltage = latest_metric(samples, ["battery_voltage", "batteryVoltage"], profile.get("baselineMetrics", {}).get("battery_voltage", {}).get("mean", 13.8))
    vibration = latest_metric(samples, ["vibration", "vibrationG"], profile.get("baselineMetrics", {}).get("vibration", {}).get("mean", 0.4))
    dpf_soot = latest_metric(samples, ["dpf_soot_load", "dpfSootLoad"], profile.get("baselineMetrics", {}).get("dpf_soot_load", {}).get("mean", 20))
    brake_temp = latest_metric(samples, ["brake_temp", "brakeTemp"], profile.get("baselineMetrics", {}).get("brake_temp", {}).get("mean", 110))
    tire_pressure = latest_metric(samples, ["tire_pressure", "tpmsPressure"], profile.get("baselineMetrics", {}).get("tire_pressure", {}).get("mean", 250))
    ambient = latest_metric(samples, ["ambientTemp", "ambient_temp_c"], 20)

    latest = samples[-1] if samples else None
    odometer = _num(latest.odometer if latest else None, 50000)
    engine_hours = _num(latest.engineHours if latest else None, (odometer or 50000) / 32)

    return {
        "vehicle_class_code": (codes.get("vehicle_class_codes") or {}).get(vehicle_class, 4),
        "protocol_code": (codes.get("protocol_codes") or {}).get(protocol, 1),
        "make_code": (codes.get("make_codes") or {}).get(make, 0),
        "powertrain_code": (codes.get("powertrain_codes") or {}).get(powertrain, 1),
        "model_year": meta.year or 2020,
        "odometer_miles": odometer,
        "engine_hours": engine_hours,
        "rpm": rpm,
        "engine_temp": engine_temp,
        "oil_temp": oil_temp,
        "transmission_temp": transmission_temp,
        "fuel_pressure": fuel_pressure,
        "fuel_rate": fuel_rate,
        "battery_voltage": battery_voltage,
        "vibration": vibration,
        "dpf_soot_load": dpf_soot,
        "brake_temp": brake_temp,
        "tire_pressure": tire_pressure,
        "ambient_temp_c": ambient,
        "elevation_ft": latest_metric(samples, ["elevation_ft", "elevation"], 1000),
        "payload_ratio": latest_metric(samples, ["payload_ratio", "payloadRatio"], 0.55),
        "road_grade_pct": latest_metric(samples, ["road_grade_pct", "roadGradePct"], 1.0),
        "idle_hours_day": latest_metric(samples, ["idle_hours_day", "idleHoursDay"], 1.0),
        "stop_go_ratio": latest_metric(samples, ["stop_go_ratio", "stopGoRatio"], 0.35),
        "long_haul_ratio": latest_metric(samples, ["long_haul_ratio", "longHaulRatio"], 0.45),
        "towing_ratio": latest_metric(samples, ["towing_ratio", "towingRatio"], 0.10),
        "maintenance_neglect": latest_metric(samples, ["maintenance_neglect", "maintenanceNeglect"], 0.18),
        "sensor_missing_rate": 0.0 if samples else 0.25,
        "engine_temp_delta_30d": delta_from_profile(engine_temp, profile, "engine_temp"),
        "fuel_pressure_delta_30d": delta_from_profile(fuel_pressure, profile, "fuel_pressure"),
        "battery_voltage_delta_30d": delta_from_profile(battery_voltage, profile, "battery_voltage"),
        "vibration_delta_30d": delta_from_profile(vibration, profile, "vibration"),
        "dpf_soot_delta_30d": delta_from_profile(dpf_soot, profile, "dpf_soot_load"),
        "brake_temp_delta_30d": delta_from_profile(brake_temp, profile, "brake_temp"),
    }


def confidence_stage(sample_count: int) -> tuple[str, float]:
    if sample_count < 50:
        return "pretrained_prior", 0.35
    if sample_count < 200:
        return "calibrating", 0.55 + min(sample_count, 199) / 1000
    return "vehicle_specific", min(0.95, 0.74 + sample_count / 5000)


def top_features(vector: dict, profile: dict, risk_probability: float) -> list[dict]:
    rows = []
    for metric in ["engine_temp", "fuel_pressure", "battery_voltage", "vibration", "dpf_soot_load", "brake_temp", "tire_pressure"]:
        baseline = profile.get("baselineMetrics", {}).get(metric, {})
        mean = _num(baseline.get("mean"))
        std = _num(baseline.get("std"), 1.0) or 1.0
        value = _num(vector.get(metric))
        if value is None or mean is None:
            continue
        z = abs((value - mean) / std)
        rows.append({"metric": metric, "value": value, "baselineMean": mean, "zScore": round(z, 3), "reason": f"{metric} compared against pretrained {profile.get('profileKey')} prior."})
    rows.sort(key=lambda item: item["zScore"], reverse=True)
    if risk_probability >= 0.5 and not rows:
        rows.append({"metric": "model_prior", "zScore": 0, "reason": "Risk came from pretrained profile prior and sparse telemetry."})
    return rows[:5]


@app.get("/model/status")
def model_status():
    load_artifacts()
    return {
        "ok": MODEL is not None,
        "modelLoaded": MODEL is not None,
        "modelVersion": METADATA.get("modelVersion"),
        "trainingSource": METADATA.get("trainingSource"),
        "rows": METADATA.get("rows"),
        "fleetSize": METADATA.get("fleet_size"),
        "profiles": len(PROFILES),
        "notes": METADATA.get("notes"),
    }


@app.get("/baselines/{profile_key}")
def baseline(profile_key: str):
    load_artifacts()
    profile = PROFILES.get(profile_key)
    if not profile:
        raise HTTPException(status_code=404, detail="baseline profile not found")
    return {"ok": True, "data": profile}


@app.post("/predict")
def predict(req: PredictRequest):
    load_artifacts()
    if MODEL is None:
        raise HTTPException(status_code=503, detail="model unavailable")
    profile = resolve_profile(req.vehicleMeta)
    from backend.app.ml.pretrained import PretrainedScorer
    from backend.app.ml.features import extract_features, coalesce_samples
    from backend.app.ml.engine_state import select_engine_running_samples
    from backend.app.ml.feature_contract import validate_features, json_safe
    if not req.orgId:
        raise HTTPException(status_code=422, detail="orgId is required")
    validate_features(MODEL.get("features", []))
    samples = select_engine_running_samples(coalesce_samples([sample.model_dump() for sample in req.samples]))
    extracted = extract_features(samples, vehicle_meta=req.vehicleMeta.model_dump(exclude_none=True))
    if not extracted.get("available"):
        return {"ok": True, "available": False, "reason": "insufficient_observed_telemetry", "vehicleId": req.vehicleId}
    scorer = PretrainedScorer()
    scorer._bundle = MODEL
    meta = req.vehicleMeta.model_dump(exclude_none=True)
    vector, input_evidence = scorer.build_input(extracted["current_metrics"], extracted["window_stats"], meta, extracted["flat"])
    risk_probability = scorer.score(extracted["current_metrics"], extracted["window_stats"], meta, extracted["flat"])
    if risk_probability is None:
        raise HTTPException(status_code=503, detail="Model input or artifact incompatible")
    thresholds = MODEL.get("thresholds", {})
    threshold = float(thresholds.get(req.alertMode, thresholds.get("launch_default", MODEL.get("threshold", .5))))

    stage, confidence = "pretrained_prior", min(.3, confidence_stage(len(samples))[1])
    subsystem_priors = profile.get("subsystemPriors", {})
    return {
        "ok": True,
        "vehicleId": req.vehicleId,
        "orgId": req.orgId,
        "prediction": int(risk_probability >= threshold),
        "riskProbability": round(risk_probability, 6),
        "threshold": threshold,
        "confidence": round(confidence, 4),
        "confidenceStage": stage,
        "modelVersion": MODEL.get("model_version") or METADATA.get("modelVersion"),
        "trainingSource": MODEL.get("training_source") or METADATA.get("trainingSource"),
        "baselineProfile": {
            "profileKey": profile.get("profileKey"),
            "vehicleClass": profile.get("vehicleClass"),
            "make": profile.get("make"),
            "model": profile.get("model"),
            "protocol": profile.get("protocol"),
            "powertrain": profile.get("powertrain"),
            "failureRate": profile.get("failureRate"),
        },
        "sampleCount": len(req.samples),
        "dataQuality": {
            "stage": stage,
            "sampleCount": len(req.samples),
            "missingRate": vector.get("sensor_missing_rate", 0),
            "message": "Using pretrained synthetic priors; live telemetry calibrates this vehicle over time." if stage != "vehicle_specific" else "Vehicle-specific telemetry baseline is active.",
        },
        "topFeatures": top_features(vector, profile, risk_probability),
        "subsystemPriors": subsystem_priors,
        "featureVector": json_safe(vector),
        "lineage": {"pretrained": scorer.evidence(), "input": json_safe(input_evidence), "service": "stateless_prior"},
    }


def _run_training(args: list[str]) -> dict:
    cmd = [sys.executable, str(ROOT / "training" / "fleet_simulation.py"), *args]
    proc = subprocess.run(cmd, cwd=str(ROOT.parents[0]), capture_output=True, text=True, timeout=3600)
    if proc.returncode != 0:
        raise HTTPException(status_code=500, detail=proc.stderr[-2000:])
    return {"ok": True, "result": "candidate_created_evaluation_required", "activeModelUnchanged": True}


@app.post("/retrain/synthetic")
def retrain_synthetic():
    return _run_training(["--fleet-size", "10000", "--days", "45", "--observations-per-day", "1"])


@app.post("/retrain/real-world")
def retrain_real_world():
    raise HTTPException(status_code=501, detail="Real-world retraining requires an uploaded customer CSV and is intentionally not automatic.")


load_artifacts()
