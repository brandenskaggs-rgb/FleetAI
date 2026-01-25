from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.services.ai_advisor import generate_ai_insight
from app.storage import store


router = APIRouter(prefix="/api/insights", tags=["insights"])


class InsightGenerateRequest(BaseModel):
    telemetry_snapshot: Optional[Dict[str, Any]] = None
    telemetry_history: Optional[List[Dict[str, Any]]] = None
    rules_output: Dict[str, Any] = Field(default_factory=dict)


def _utc_now() -> str:
    return datetime.utcnow().isoformat() + "Z"


def _is_learning_mode(vehicle_id: str) -> bool:
    activation = store["vehicle_activation"].get(vehicle_id)
    if not activation:
        return False
    activated_at = datetime.fromisoformat(activation.activated_at.replace("Z", ""))
    ends_at = activated_at + timedelta(days=activation.learning_days)
    return datetime.utcnow() < ends_at


def _load_telemetry(vehicle_id: str, payload: InsightGenerateRequest) -> Dict[str, Any]:
    snapshot = payload.telemetry_snapshot or store["telemetry_latest"].get(vehicle_id)
    if not snapshot:
        raise HTTPException(status_code=404, detail="No telemetry available for vehicle")
    history = payload.telemetry_history or store["telemetry_history"].get(vehicle_id, [])
    return {"snapshot": snapshot, "history": history}


@router.post("/generate")
async def generate_insight(
    vehicle_id: str,
    payload: InsightGenerateRequest = InsightGenerateRequest(),
):
    if vehicle_id not in store["vehicles"]:
        raise HTTPException(status_code=404, detail="Vehicle not found")

    telemetry = _load_telemetry(vehicle_id, payload)
    learning_mode = _is_learning_mode(vehicle_id)

    try:
        insight = generate_ai_insight(
            vehicle_id=vehicle_id,
            telemetry_snapshot=telemetry["snapshot"],
            telemetry_history=telemetry["history"],
            learning_mode=learning_mode,
            rules_output=payload.rules_output,
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    response = {
        "vehicle_id": vehicle_id,
        "generated_at": _utc_now(),
        "insight": insight,
    }
    store["insights_latest"][vehicle_id] = response
    return response


@router.get("/latest")
async def latest_insight(vehicle_id: str):
    if vehicle_id not in store["vehicles"]:
        raise HTTPException(status_code=404, detail="Vehicle not found")
    latest = store["insights_latest"].get(vehicle_id)
    if not latest:
        raise HTTPException(status_code=404, detail="No insight available for vehicle")
    return latest
