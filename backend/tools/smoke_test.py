import json
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path


BASE_URL = "http://127.0.0.1:8000"


def http_json(method, url, payload=None):
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=5) as resp:
        body = resp.read().decode("utf-8")
        return resp.status, json.loads(body) if body else {}


def wait_for_health(timeout_s=8):
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            status, _ = http_json("GET", f"{BASE_URL}/health")
            if status == 200:
                return True
        except Exception:
            time.sleep(0.5)
    return False


def start_backend():
    repo_root = Path(__file__).resolve().parents[2]
    cmd = [
        sys.executable,
        "-m",
        "uvicorn",
        "backend.app.main:app",
        "--host",
        "0.0.0.0",
        "--port",
        "8000",
    ]
    proc = subprocess.Popen(cmd, cwd=str(repo_root))
    if not wait_for_health():
        proc.terminate()
        proc.wait(timeout=5)
        raise RuntimeError("Backend failed to start.")
    return proc


def main():
    proc = None
    if not wait_for_health():
        proc = start_backend()

    status, health = http_json("GET", f"{BASE_URL}/health")
    if status != 200 or health.get("status") != "ok":
        raise RuntimeError("Health check failed.")

    status, ai_status = http_json("GET", f"{BASE_URL}/ai/status")
    if status != 200 or not isinstance(ai_status.get("ai_enabled"), bool):
        raise RuntimeError("AI status check failed.")

    vehicle_payload = {
        "vehicle_id": "VEHICLE_002",
        "unit_name": "Unit 2 - Pilot",
        "vin": "2HGBH41JXMN109187",
        "type": "Truck",
    }
    try:
        http_json("POST", f"{BASE_URL}/api/settings/vehicles", vehicle_payload)
    except urllib.error.HTTPError as err:
        if err.code != 409:
            raise

    ingest_payload = {
        "vehicle_id": "VEHICLE_002",
        "device_id": "DEVICE_001",
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "metrics": {
            "speed": 62.4,
            "rpm": 1850,
            "coolant_temp": 198.2,
            "fuel_level": 52.5,
            "mileage": 45212.3,
            "engine_hours": 1320.4,
            "hard_brake_count": 1,
            "harsh_accel_count": 0,
            "abs_events": 0,
            "wheel_speed_variance": 4.2,
            "tpms_low_pressure_flags": 0,
        },
    }
    http_json("POST", f"{BASE_URL}/api/ingest/telemetry", ingest_payload)

    status, telemetry = http_json(
        "GET", f"{BASE_URL}/api/telemetry?vehicle_id=VEHICLE_002"
    )
    if status != 200 or telemetry.get("vehicle_id") != "VEHICLE_002":
        raise RuntimeError("Telemetry fetch failed.")

    status, alerts = http_json("GET", f"{BASE_URL}/api/alerts?vehicle_id=VEHICLE_002&limit=5")
    if status != 200 or not isinstance(alerts, list):
        raise RuntimeError("Alerts fetch failed.")

    print("Smoke test passed.")

    if proc:
        proc.terminate()
        proc.wait(timeout=5)


if __name__ == "__main__":
    main()
