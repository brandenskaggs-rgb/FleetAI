from datetime import datetime
from typing import Dict, List, Optional
from uuid import uuid4

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.storage import store


router = APIRouter(prefix="/api/driver", tags=["driver"])


def _utc_now() -> str:
    return datetime.utcnow().isoformat() + "Z"


class DeviceRegistrationRequest(BaseModel):
    driver_name: str = Field(min_length=1)
    device_model: str = Field(min_length=1)


class TripStartRequest(BaseModel):
    device_id: str = Field(min_length=1)
    vehicle_id: str = Field(min_length=1)


class TripEndRequest(BaseModel):
    trip_id: str = Field(min_length=1)


class TelemetrySample(BaseModel):
    ts: str
    speed: float
    rpm: float
    coolant_temp: float
    fuel_level: float
    voltage: float
    odometer: float


class TelemetryUploadRequest(BaseModel):
    device_id: str = Field(min_length=1)
    vehicle_id: str = Field(min_length=1)
    trip_id: str = Field(min_length=1)
    samples: List[TelemetrySample] = Field(default_factory=list)


class DriverAlert(BaseModel):
    id: str
    severity: str
    message: str
    created_at: str


@router.post("/register-device")
async def register_device(payload: DeviceRegistrationRequest):
    device_id = str(uuid4())
    token = str(uuid4())
    store["driver_devices"][device_id] = {
        "device_id": device_id,
        "driver_name": payload.driver_name,
        "device_model": payload.device_model,
        "token": token,
        "registered_at": _utc_now(),
    }
    return {"device_id": device_id, "token": token}


@router.post("/trips/start")
async def start_trip(payload: TripStartRequest):
    if payload.device_id not in store["driver_devices"]:
        raise HTTPException(status_code=404, detail="Device not found")
    if payload.vehicle_id not in store["vehicles"]:
        raise HTTPException(status_code=404, detail="Vehicle not found")
    trip_id = str(uuid4())
    started_at = _utc_now()
    store["driver_trips"][trip_id] = {
        "trip_id": trip_id,
        "device_id": payload.device_id,
        "vehicle_id": payload.vehicle_id,
        "started_at": started_at,
        "ended_at": None,
    }
    return {"trip_id": trip_id, "started_at": started_at}


@router.post("/trips/end")
async def end_trip(payload: TripEndRequest):
    trip = store["driver_trips"].get(payload.trip_id)
    if not trip:
        raise HTTPException(status_code=404, detail="Trip not found")
    ended_at = _utc_now()
    trip["ended_at"] = ended_at
    store["driver_trips"][payload.trip_id] = trip
    return {"trip_id": payload.trip_id, "ended_at": ended_at}


@router.post("/telemetry")
async def upload_driver_telemetry(payload: TelemetryUploadRequest):
    if payload.device_id not in store["driver_devices"]:
        raise HTTPException(status_code=404, detail="Device not found")
    if payload.vehicle_id not in store["vehicles"]:
        raise HTTPException(status_code=404, detail="Vehicle not found")
    if payload.trip_id not in store["driver_trips"]:
        raise HTTPException(status_code=404, detail="Trip not found")

    trip_samples = store["driver_telemetry"].setdefault(payload.trip_id, [])
    for sample in payload.samples:
        trip_samples.append(sample.dict())
    store["driver_telemetry"][payload.trip_id] = trip_samples[-2000:]

    return {"received": len(payload.samples), "stored": True}


def _sync_driver_alerts(vehicle_id: str) -> List[Dict[str, str]]:
    alerts = store["driver_alerts"].setdefault(vehicle_id, [])
    if alerts:
        return alerts

    source_alerts = store["alerts"].get(vehicle_id, [])
    for alert in source_alerts[:20]:
        severity = (
            "high"
            if alert.severity == "critical"
            else "medium"
            if alert.severity == "warning"
            else "low"
        )
        alerts.append(
            {
                "id": str(uuid4()),
                "severity": severity,
                "message": alert.title,
                "created_at": alert.timestamp,
            }
        )
    store["driver_alerts"][vehicle_id] = alerts
    return alerts


@router.get("/alerts", response_model=List[DriverAlert])
async def list_driver_alerts(vehicle_id: str):
    if vehicle_id not in store["vehicles"]:
        raise HTTPException(status_code=404, detail="Vehicle not found")
    return _sync_driver_alerts(vehicle_id)


@router.post("/alerts/{alert_id}/ack")
async def ack_driver_alert(alert_id: str):
    for alerts in store["driver_alerts"].values():
        for alert in alerts:
            if alert["id"] == alert_id:
                alert["acknowledged_at"] = _utc_now()
                return {"acknowledged": True}
    raise HTTPException(status_code=404, detail="Alert not found")


@router.get("/config")
async def get_driver_config():
    return {"sampling_rate_seconds": 2, "upload_interval_seconds": 10}
