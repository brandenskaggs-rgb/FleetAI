import os
from pathlib import Path

# Snapshot path — persists baselines/alerts across restarts
SNAPSHOT_PATH = Path(os.getenv(
    "FLEETAI_STORE_SNAPSHOT",
    str(Path(__file__).resolve().parent / "store_snapshot.json"),
))

store = {
    "companies": {},
    "vehicles": {},
    "devices": {},
    "pairing_codes": {},
    "telemetry_latest": {},
    "telemetry_history": {},
    "telemetry_latest_normalized": {},
    "telemetry_history_normalized": {},
    "vehicle_activation": {},
    "baseline_models": {},
    "baseline_flags": {},
    "alerts": {},
    "alert_index": {},          # alert_id → AlertRecord for O(1) lookup
    "alert_counter": 0,
    "ai_cooldowns": {},
    "insights_latest": {},
    "driver_devices": {},
    "driver_trips": {},
    "driver_telemetry": {},
    "driver_alerts": {},
}
