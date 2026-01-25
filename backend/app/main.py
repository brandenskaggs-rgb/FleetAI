from datetime import datetime, timedelta
from math import sqrt
from typing import Dict, List, Optional
import os
import string

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from dotenv import load_dotenv
from pathlib import Path

from app.services.ai_explain import explain_alert
from app.routes.insights import router as insights_router
from app.storage import store


load_dotenv()


def utc_now() -> str:
    return datetime.utcnow().isoformat() + "Z"


def parse_iso(ts: str) -> datetime:
    return datetime.fromisoformat(ts.replace("Z", ""))


class Company(BaseModel):
    company_id: str
    name: str
    created_at: str


class Vehicle(BaseModel):
    vehicle_id: str
    unit_name: str
    vin: str
    type: str
    created_at: str


class Device(BaseModel):
    device_id: str
    label: str
    status: str
    last_seen: Optional[str] = None
    paired_vehicle_id: Optional[str] = None


class PairingCode(BaseModel):
    code: str
    device_id: Optional[str] = None
    paired_vehicle_id: Optional[str] = None
    expires_at: str
    used_at: Optional[str] = None


class TelemetryIngest(BaseModel):
    vehicle_id: str
    device_id: Optional[str] = None
    timestamp: Optional[str] = None
    metrics: Dict[str, float] = Field(default_factory=dict)


class TelemetryEngine(BaseModel):
    rpm: Optional[float] = None
    torqueDemandPct: Optional[float] = None
    torqueActualPct: Optional[float] = None
    coolantTempC: Optional[float] = None
    oilPressureKpa: Optional[float] = None
    oilTempC: Optional[float] = None
    exhaustTempC: Optional[float] = None
    engineHours: Optional[float] = None


class TelemetryVehicle(BaseModel):
    speedKph: Optional[float] = None
    distanceKm: Optional[float] = None


class TelemetryFuel(BaseModel):
    rateLph: Optional[float] = None
    economyKmpl: Optional[float] = None
    fuelTempC: Optional[float] = None


class TelemetryElectrical(BaseModel):
    batteryVoltage: Optional[float] = None


class TelemetryEnvironment(BaseModel):
    ambientTempC: Optional[float] = None
    barometricPressureKpa: Optional[float] = None


class TelemetryDiagnostics(BaseModel):
    activeDTCs: List[str] = Field(default_factory=list)
    previousDTCs: List[str] = Field(default_factory=list)


class TelemetryMeta(BaseModel):
    supportedStandards: List[str] = Field(default_factory=list)
    busHealth: Dict[str, Optional[float]] = Field(default_factory=dict)
    confidenceScore: Optional[float] = None


class TelemetryNormalized(BaseModel):
    vehicleId: str
    deviceId: Optional[str] = None
    vehicleClass: str = "heavy"
    timestamp: Optional[str] = None
    engine: TelemetryEngine = Field(default_factory=TelemetryEngine)
    vehicle: TelemetryVehicle = Field(default_factory=TelemetryVehicle)
    fuel: TelemetryFuel = Field(default_factory=TelemetryFuel)
    electrical: TelemetryElectrical = Field(default_factory=TelemetryElectrical)
    environment: TelemetryEnvironment = Field(default_factory=TelemetryEnvironment)
    diagnostics: TelemetryDiagnostics = Field(default_factory=TelemetryDiagnostics)
    meta: TelemetryMeta = Field(default_factory=TelemetryMeta)


class VehicleCreate(BaseModel):
    vehicle_id: Optional[str] = None
    unit_name: str
    vin: str
    type: str


class PairingCodeRequest(BaseModel):
    vehicle_id: str


class PairingCodeClaim(BaseModel):
    code: str
    device_id: str
    label: str


class VehicleActivation(BaseModel):
    vehicle_id: str
    activated_at: str
    learning_days: int = 90


class ActivationRequest(BaseModel):
    learning_days: Optional[int] = None


class BaselineStats(BaseModel):
    count: int = 0
    mean: float = 0.0
    m2: float = 0.0


class AlertRecord(BaseModel):
    alert_id: str
    vehicle_id: str
    timestamp: str
    severity: str
    confidence: str
    title: str
    details: str
    recommended_action: str
    learning_mode_flag: bool
    explanation: Optional[str] = None


app = FastAPI()

UI_DASHBOARD_PATH = Path(__file__).resolve().parents[2] / "ui" / "fleetai-dashboard.html"

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

app.include_router(insights_router)




METRIC_MAP = {
    "speed_mph": "speed_mph",
    "engine_rpm": "engine_rpm",
    "engine_coolant_temp_f": "engine_coolant_temp_f",
    "engine_oil_temp_f": "engine_oil_temp_f",
    "engine_oil_pressure_psi": "engine_oil_pressure_psi",
    "battery_voltage_v": "battery_voltage_v",
    "fuel_level_pct": "fuel_level_pct",
    "transmission_temp_f": "transmission_temp_f",
    "dpf_soot_load_pct": "dpf_soot_load_pct",
    "def_level_pct": "def_level_pct",
}

LEGACY_METRIC_MAP = {
    "speed": "speed_mph",
    "rpm": "engine_rpm",
    "coolant_temp": "engine_coolant_temp_f",
    "fuel_level": "fuel_level_pct",
}

HARD_THRESHOLDS = {
    "engine_coolant_temp_f": 230.0,
    "engine_oil_temp_f": 260.0,
    "engine_oil_pressure_psi": 10.0,
    "battery_voltage_v": 11.5,
    "transmission_temp_f": 240.0,
    "dpf_soot_load_pct": 90.0,
    "def_level_pct": 10.0,
}

Z_SCORE_THRESHOLD = 3.0
Z_SCORE_CRITICAL = 5.0
BASELINE_MIN_POINTS = 50
PERSISTENCE_WINDOW = 10
PERSISTENCE_REQUIRED = 3
AI_COOLDOWN_SECONDS = 900


def normalize_metrics(metrics: Dict[str, float]) -> Dict[str, float]:
    normalized = {}
    for key, value in metrics.items():
        if key in METRIC_MAP:
            normalized[METRIC_MAP[key]] = value
        elif key in LEGACY_METRIC_MAP:
            normalized[LEGACY_METRIC_MAP[key]] = value
    return normalized


def c_to_f(value: Optional[float]) -> Optional[float]:
    if value is None:
        return None
    return value * 9 / 5 + 32


def kph_to_mph(value: Optional[float]) -> Optional[float]:
    if value is None:
        return None
    return value * 0.621371


def km_to_miles(value: Optional[float]) -> Optional[float]:
    if value is None:
        return None
    return value * 0.621371


def normalized_to_metrics(payload: TelemetryNormalized) -> Dict[str, float]:
    metrics: Dict[str, float] = {}
    if payload.vehicle.speedKph is not None:
        metrics["speed"] = kph_to_mph(payload.vehicle.speedKph)
    if payload.engine.rpm is not None:
        metrics["rpm"] = payload.engine.rpm
    if payload.engine.coolantTempC is not None:
        metrics["coolant_temp"] = c_to_f(payload.engine.coolantTempC)
    if payload.engine.engineHours is not None:
        metrics["engine_hours"] = payload.engine.engineHours
    if payload.vehicle.distanceKm is not None:
        metrics["mileage"] = km_to_miles(payload.vehicle.distanceKm)
    if payload.fuel.fuelTempC is not None:
        metrics["fuel_temp_c"] = payload.fuel.fuelTempC
    if payload.fuel.rateLph is not None:
        metrics["fuel_rate_lph"] = payload.fuel.rateLph
    if payload.electrical.batteryVoltage is not None:
        metrics["battery_v"] = payload.electrical.batteryVoltage
    if payload.engine.oilTempC is not None:
        metrics["engine_oil_temp_c"] = payload.engine.oilTempC
    if payload.engine.oilPressureKpa is not None:
        metrics["engine_oil_pressure_kpa"] = payload.engine.oilPressureKpa
    return metrics


def record_telemetry_normalized(payload: TelemetryNormalized) -> Dict[str, float]:
    timestamp = payload.timestamp or utc_now()
    normalized = payload.dict()
    store["telemetry_latest_normalized"][payload.vehicleId] = normalized
    history = store["telemetry_history_normalized"].setdefault(payload.vehicleId, [])
    history.insert(0, normalized)
    store["telemetry_history_normalized"][payload.vehicleId] = history[:500]

    metrics = normalized_to_metrics(payload)
    record_telemetry(payload.vehicleId, payload.deviceId, timestamp, metrics)
    return metrics


def record_telemetry(
    vehicle_id: str, device_id: Optional[str], timestamp: str, metrics: Dict[str, float]
) -> None:
    payload = {
        "vehicle_id": vehicle_id,
        "device_id": device_id,
        "timestamp": timestamp,
        "metrics": metrics,
    }
    store["telemetry_latest"][vehicle_id] = payload
    history = store["telemetry_history"].setdefault(vehicle_id, [])
    history.insert(0, payload)
    store["telemetry_history"][vehicle_id] = history[:500]

    if device_id:
        device = store["devices"].get(device_id)
        if device:
            device.status = "online"
            device.last_seen = timestamp
        else:
            store["devices"][device_id] = Device(
                device_id=device_id,
                label=device_id,
                status="online",
                last_seen=timestamp,
                paired_vehicle_id=vehicle_id,
            )


def build_telemetry_response(vehicle_id: str) -> Dict[str, Optional[float]]:
    vehicle = store["vehicles"].get(vehicle_id)
    if not vehicle:
        raise HTTPException(status_code=404, detail="Vehicle not found")

    latest = store["telemetry_latest"].get(vehicle_id)
    if not latest:
        return {
            "vehicle_id": vehicle.vehicle_id,
            "vin": vehicle.vin,
            "timestamp": None,
            "speed": None,
            "rpm": None,
            "coolant_temp": None,
            "fuel_level": None,
            "mileage": None,
            "engine_hours": None,
            "device_id": None,
            "metrics": {},
        }

    metrics = latest.get("metrics", {})
    return {
        "vehicle_id": vehicle.vehicle_id,
        "vin": vehicle.vin,
        "timestamp": latest.get("timestamp", utc_now()),
        "speed": metrics.get("speed"),
        "rpm": metrics.get("rpm"),
        "coolant_temp": metrics.get("coolant_temp"),
        "fuel_level": metrics.get("fuel_level"),
        "mileage": metrics.get("mileage"),
        "engine_hours": metrics.get("engine_hours"),
        "device_id": latest.get("device_id"),
        "metrics": metrics,
    }


def generate_code() -> str:
    return "".join(random.choices(string.ascii_uppercase + string.digits, k=6))


def get_ai_learning_days() -> int:
    raw = os.getenv("AI_LEARNING_DAYS", "90")
    try:
        return max(1, int(raw))
    except ValueError:
        return 90


def ensure_activation(vehicle_id: str) -> VehicleActivation:
    activation = store["vehicle_activation"].get(vehicle_id)
    if activation:
        return activation
    activation = VehicleActivation(
        vehicle_id=vehicle_id,
        activated_at=utc_now(),
        learning_days=get_ai_learning_days(),
    )
    store["vehicle_activation"][vehicle_id] = activation
    return activation


def learning_status(activation: VehicleActivation) -> Dict[str, object]:
    activated_at = parse_iso(activation.activated_at)
    ends_at = activated_at + timedelta(days=activation.learning_days)
    now = datetime.utcnow()
    days_remaining = max(0, (ends_at - now).days)
    mode = "learning" if now < ends_at else "optimized"
    return {
        "vehicle_id": activation.vehicle_id,
        "activated_at": activation.activated_at,
        "learning_days": activation.learning_days,
        "learning_ends_at": ends_at.isoformat() + "Z",
        "days_remaining": days_remaining,
        "mode": mode,
        "note": "First 90 days are used to establish a baseline of normal operating behavior.",
    }


def update_baseline(vehicle_id: str, metrics: Dict[str, float]) -> None:
    baseline = store["baseline_models"].setdefault(vehicle_id, {})
    for key, value in metrics.items():
        stats = baseline.get(key, BaselineStats())
        stats.count += 1
        delta = value - stats.mean
        stats.mean += delta / stats.count
        delta2 = value - stats.mean
        stats.m2 += delta * delta2
        baseline[key] = stats
    store["baseline_models"][vehicle_id] = baseline


def compute_z_score(stats: BaselineStats, value: float) -> float:
    if stats.count < 2:
        return 0.0
    variance = stats.m2 / (stats.count - 1)
    if variance <= 0:
        return 0.0
    return (value - stats.mean) / sqrt(variance)


def recent_alerts(vehicle_id: str, metric_name: str, window: int = 5) -> int:
    alerts = store["alerts"].get(vehicle_id, [])
    count = 0
    for alert in alerts[:window]:
        if metric_name in alert.details:
            count += 1
    return count


def explanation_template(alert: AlertRecord, learning_mode: bool) -> str:
    mode = "learning" if learning_mode else "optimized"
    return (
        f"Explanation: {alert.title}. Confidence is {alert.confidence} "
        f"while in {mode} mode. Review recent trends and schedule inspection if persistent."
    )


def create_alert(
    vehicle_id: str,
    severity: str,
    confidence: str,
    title: str,
    details: str,
    recommended_action: str,
    learning_mode: bool,
) -> AlertRecord:
    store["alert_counter"] += 1
    alert = AlertRecord(
        alert_id=f"ALERT_{store['alert_counter']:06d}",
        vehicle_id=vehicle_id,
        timestamp=utc_now(),
        severity=severity,
        confidence=confidence,
        title=title,
        details=details,
        recommended_action=recommended_action,
        learning_mode_flag=learning_mode,
    )
    alerts = store["alerts"].setdefault(vehicle_id, [])
    alerts.insert(0, alert)
    store["alerts"][vehicle_id] = alerts[:50]
    return alert


def update_persistence(vehicle_id: str, metric_name: str, flagged: bool) -> int:
    per_vehicle = store["baseline_flags"].setdefault(vehicle_id, {})
    history = per_vehicle.get(metric_name, [])
    history.insert(0, flagged)
    per_vehicle[metric_name] = history[:PERSISTENCE_WINDOW]
    store["baseline_flags"][vehicle_id] = per_vehicle
    return sum(1 for x in history[:PERSISTENCE_WINDOW] if x)


def should_call_ai(vehicle_id: str) -> bool:
    if os.getenv("AI_ENABLED", "false").lower() != "true":
        return False
    last = store["ai_cooldowns"].get(vehicle_id)
    if not last:
        return True
    return (datetime.utcnow() - last).total_seconds() >= AI_COOLDOWN_SECONDS


def mark_ai_call(vehicle_id: str) -> None:
    store["ai_cooldowns"][vehicle_id] = datetime.utcnow()


def evaluate_thresholds(
    vehicle_id: str, metrics: Dict[str, float], learning_mode: bool
) -> Optional[AlertRecord]:
    for metric_name, value in metrics.items():
        if metric_name not in HARD_THRESHOLDS:
            continue
        threshold = HARD_THRESHOLDS[metric_name]
        is_low = metric_name in ("engine_oil_pressure_psi", "battery_voltage_v", "def_level_pct")
        breach = value <= threshold if is_low else value >= threshold
        if breach:
            title = f"Safety threshold breach: {metric_name}"
            details = f"{metric_name} at {value} (threshold {threshold})"
            action = "Inspect immediately and reduce load until resolved."
            alert = create_alert(
                vehicle_id,
                "critical",
                "high",
                title,
                details,
                action,
                learning_mode,
            )
            if should_call_ai(vehicle_id):
                alert.explanation = explain_alert(alert, learning_mode)
                mark_ai_call(vehicle_id)
            return alert
    return None


def evaluate_baseline_deviation(
    vehicle_id: str, metrics: Dict[str, float], learning_mode: bool
) -> Optional[AlertRecord]:
    baseline = store["baseline_models"].get(vehicle_id, {})

    for metric_name, value in metrics.items():
        stats = baseline.get(metric_name)
        if not stats or stats.count < BASELINE_MIN_POINTS:
            update_persistence(vehicle_id, metric_name, False)
            continue

        z_score = compute_z_score(stats, value)
        flagged = abs(z_score) >= Z_SCORE_THRESHOLD
        hits = update_persistence(vehicle_id, metric_name, flagged)
        if hits < PERSISTENCE_REQUIRED:
            continue

        severity = "critical" if abs(z_score) >= Z_SCORE_CRITICAL else "warning"
        if learning_mode:
            confidence = "medium" if abs(z_score) >= Z_SCORE_CRITICAL else "low"
        else:
            confidence = "high" if abs(z_score) >= Z_SCORE_CRITICAL or hits >= 6 else "medium"

        title = f"Baseline deviation: {metric_name}"
        details = f"{metric_name} z-score {z_score:.2f} (value {value})"
        action = "Review recent trends and schedule inspection if persistent."
        alert = create_alert(
            vehicle_id, severity, confidence, title, details, action, learning_mode
        )
        if severity == "critical" and should_call_ai(vehicle_id):
            alert.explanation = explain_alert(alert, learning_mode)
            mark_ai_call(vehicle_id)
        return alert

    return None


def calculate_tire_risk(vehicle_id: str) -> Dict[str, object]:
    latest = store["telemetry_latest"].get(vehicle_id)
    metrics = latest.get("metrics", {}) if latest else {}
    if not metrics:
        return {
            "riskScore": None,
            "confidence": "unknown",
            "topReasons": [],
            "recommendedActions": [],
            "timestamp": utc_now(),
            "note": "No telemetry received yet.",
        }

    speed = metrics.get("speed", 0.0)
    rpm = metrics.get("rpm", 0.0)
    coolant_temp = metrics.get("coolant_temp", 0.0)

    hard_brake_count = int(metrics.get("hard_brake_count", 0))
    harsh_accel_count = int(metrics.get("harsh_accel_count", 0))
    abs_events = int(metrics.get("abs_events", 0))
    wheel_speed_variance = float(metrics.get("wheel_speed_variance", 0.0))
    tpms_low_pressure_flags = int(metrics.get("tpms_low_pressure_flags", 0))

    missing_tpms = "tpms_low_pressure_flags" not in metrics
    missing_wheel = "wheel_speed_variance" not in metrics

    risk = 18
    reasons: List[str] = []
    actions: List[str] = []

    if speed > 70:
        risk += 10
        reasons.append("Sustained high speed increases tire heat.")
        actions.append("Review route speed and driver coaching.")
    if rpm > 2400:
        risk += 6
        reasons.append("Elevated RPM suggests aggressive driving or load.")
        actions.append("Check gearing and load profile.")
    if coolant_temp > 220:
        risk += 8
        reasons.append("Cooling temps are elevated, raising overall heat load.")
        actions.append("Inspect cooling system before long hauls.")
    if hard_brake_count >= 3:
        risk += 12
        reasons.append("Frequent hard braking raises wear and flat-spot risk.")
        actions.append("Coach braking behavior and inspect tread.")
    if harsh_accel_count >= 3:
        risk += 8
        reasons.append("Harsh acceleration increases tire shear stress.")
        actions.append("Coach launch behavior and check torque delivery.")
    if abs_events >= 1:
        risk += 14
        reasons.append("ABS events indicate traction stress.")
        actions.append("Inspect tires for uneven wear and balance.")
    if wheel_speed_variance > 8:
        risk += 16
        reasons.append("Wheel speed variance suggests imbalance or pressure issues.")
        actions.append("Check wheel balance and alignment.")
    if tpms_low_pressure_flags > 0:
        risk += 18
        reasons.append("Low pressure flags increase blowout risk.")
        actions.append("Adjust tire pressure and inspect for leaks.")

    if not reasons:
        reasons.append("Telemetry within expected range.")
        actions.append("Continue regular tire inspections.")

    risk = max(0, min(100, risk))
    confidence = "low" if (missing_tpms or missing_wheel) else "medium"

    return {
        "riskScore": risk,
        "confidence": confidence,
        "topReasons": reasons[:4],
        "recommendedActions": actions[:4],
        "timestamp": utc_now(),
    }


@app.get("/health")
async def health():
    return {"status": "ok", "timestamp": utc_now()}


@app.get("/")
async def ui_root():
    if UI_DASHBOARD_PATH.is_file():
        return FileResponse(UI_DASHBOARD_PATH)
    raise HTTPException(status_code=404, detail="UI not found")


@app.get("/ai/status")
async def ai_status():
    return {
        "ai_enabled": os.getenv("AI_ENABLED", "false").lower() == "true",
        "has_openai_key": bool(os.getenv("OPENAI_API_KEY")),
        "learning_days": get_ai_learning_days(),
    }


@app.get("/api/telemetry")
async def get_telemetry(vehicle_id: str = "VEHICLE_001"):
    return build_telemetry_response(vehicle_id)


@app.get("/api/telemetry/latest")
async def get_telemetry_latest(vehicle_id: str = "VEHICLE_001"):
    return build_telemetry_response(vehicle_id)


@app.post("/api/ingest/telemetry")
async def ingest_telemetry(payload: TelemetryIngest):
    vehicle = store["vehicles"].get(payload.vehicle_id)
    if not vehicle:
        raise HTTPException(status_code=404, detail="Vehicle not found")
    timestamp = payload.timestamp or utc_now()
    record_telemetry(payload.vehicle_id, payload.device_id, timestamp, payload.metrics)

    normalized = normalize_metrics(payload.metrics)
    if normalized:
        update_baseline(payload.vehicle_id, normalized)
        activation = ensure_activation(payload.vehicle_id)
        learning_mode = learning_status(activation)["mode"] == "learning"
        alert = evaluate_thresholds(payload.vehicle_id, normalized, learning_mode)
        if not alert:
            evaluate_baseline_deviation(payload.vehicle_id, normalized, learning_mode)

    return build_telemetry_response(payload.vehicle_id)


@app.post("/api/ingest/telemetry/normalized")
async def ingest_telemetry_normalized(payload: TelemetryNormalized):
    vehicle = store["vehicles"].get(payload.vehicleId)
    if not vehicle:
        raise HTTPException(status_code=404, detail="Vehicle not found")
    normalized = record_telemetry_normalized(payload)
    if normalized:
        update_baseline(payload.vehicleId, normalized)
        activation = ensure_activation(payload.vehicleId)
        learning_mode = learning_status(activation)["mode"] == "learning"
        alert = evaluate_thresholds(payload.vehicleId, normalized, learning_mode)
        if not alert:
            evaluate_baseline_deviation(payload.vehicleId, normalized, learning_mode)
    return build_telemetry_response(payload.vehicleId)


@app.get("/api/tire-risk")
async def tire_risk(vehicle_id: str = "VEHICLE_001"):
    if vehicle_id not in store["vehicles"]:
        raise HTTPException(status_code=404, detail="Vehicle not found")
    return calculate_tire_risk(vehicle_id)


@app.post("/api/vehicles/{vehicle_id}/activate")
async def activate_vehicle(vehicle_id: str, payload: ActivationRequest = ActivationRequest()):
    if vehicle_id not in store["vehicles"]:
        raise HTTPException(status_code=404, detail="Vehicle not found")
    learning_days = payload.learning_days or get_ai_learning_days()
    activation = VehicleActivation(
        vehicle_id=vehicle_id,
        activated_at=utc_now(),
        learning_days=learning_days,
    )
    store["vehicle_activation"][vehicle_id] = activation
    status = learning_status(activation)
    return {
        "vehicle_id": activation.vehicle_id,
        "activated_at": activation.activated_at,
        "learning_days": activation.learning_days,
        "learning_ends_at": status["learning_ends_at"],
    }


@app.get("/api/vehicles/{vehicle_id}/learning-status")
async def get_learning_status(vehicle_id: str):
    if vehicle_id not in store["vehicles"]:
        raise HTTPException(status_code=404, detail="Vehicle not found")
    activation = ensure_activation(vehicle_id)
    return learning_status(activation)


@app.get("/api/alerts/latest")
async def get_latest_alert(vehicle_id: str):
    alerts = store["alerts"].get(vehicle_id, [])
    return alerts[0] if alerts else None


@app.get("/api/alerts")
async def list_alerts(vehicle_id: str, limit: int = 20):
    alerts = store["alerts"].get(vehicle_id, [])
    return alerts[:limit]


@app.get("/api/alerts/{alert_id}/explain")
async def explain_alert_endpoint(alert_id: str):
    for vehicle_alerts in store["alerts"].values():
        for alert in vehicle_alerts:
            if alert.alert_id == alert_id:
                activation = ensure_activation(alert.vehicle_id)
                learning_mode = learning_status(activation)["mode"] == "learning"
                if should_call_ai(alert.vehicle_id):
                    alert.explanation = explain_alert(alert, learning_mode)
                    mark_ai_call(alert.vehicle_id)
                else:
                    alert.explanation = explanation_template(alert, learning_mode)
                return {"alert_id": alert.alert_id, "explanation": alert.explanation}
    raise HTTPException(status_code=404, detail="Alert not found")


@app.get("/api/settings/vehicles")
async def list_vehicles():
    return list(store["vehicles"].values())


@app.post("/api/settings/vehicles")
async def create_vehicle(payload: VehicleCreate):
    vehicle_id = payload.vehicle_id or f"VEHICLE_{len(store['vehicles']) + 1:03d}"
    if vehicle_id in store["vehicles"]:
        raise HTTPException(status_code=409, detail="Vehicle already exists")
    vehicle = Vehicle(
        vehicle_id=vehicle_id,
        unit_name=payload.unit_name,
        vin=payload.vin,
        type=payload.type,
        created_at=utc_now(),
    )
    store["vehicles"][vehicle_id] = vehicle
    return vehicle


@app.get("/api/settings/devices")
async def list_devices():
    return list(store["devices"].values())


@app.post("/api/settings/pairing-code")
async def generate_pairing_code(payload: PairingCodeRequest):
    if payload.vehicle_id not in store["vehicles"]:
        raise HTTPException(status_code=404, detail="Vehicle not found")
    code = generate_code()
    expires_at = (datetime.utcnow() + timedelta(minutes=10)).isoformat() + "Z"
    pairing = PairingCode(code=code, paired_vehicle_id=payload.vehicle_id, expires_at=expires_at)
    store["pairing_codes"][code] = pairing
    return {"code": code, "vehicle_id": payload.vehicle_id, "expires_at": expires_at}


@app.post("/api/settings/pairing-code/claim")
async def claim_pairing_code(payload: PairingCodeClaim):
    pairing = store["pairing_codes"].get(payload.code)
    if not pairing:
        raise HTTPException(status_code=404, detail="Pairing code not found")
    if pairing.used_at:
        raise HTTPException(status_code=409, detail="Pairing code already used")
    if datetime.utcnow() > datetime.fromisoformat(pairing.expires_at.replace("Z", "")):
        raise HTTPException(status_code=410, detail="Pairing code expired")

    device = store["devices"].get(payload.device_id)
    if device:
        device.label = payload.label
        device.status = "paired"
        device.paired_vehicle_id = pairing.paired_vehicle_id
        device.last_seen = device.last_seen or utc_now()
    else:
        device = Device(
            device_id=payload.device_id,
            label=payload.label,
            status="paired",
            last_seen=utc_now(),
            paired_vehicle_id=pairing.paired_vehicle_id,
        )
        store["devices"][payload.device_id] = device

    pairing.used_at = utc_now()
    pairing.device_id = payload.device_id
    return device


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("backend.app.main:app", host="0.0.0.0", port=8000, reload=True)
