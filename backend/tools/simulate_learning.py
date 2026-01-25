import json
import time
import urllib.request


BASE_URL = "http://127.0.0.1:8000"


def http_json(method, url, payload=None):
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=5) as resp:
        body = resp.read().decode("utf-8")
        return resp.status, json.loads(body) if body else {}


def main():
    vehicle_id = "VEHICLE_001"
    http_json("POST", f"{BASE_URL}/api/vehicles/{vehicle_id}/activate", {})

    for i in range(100):
        payload = {
            "vehicle_id": vehicle_id,
            "device_id": "DEVICE_001",
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "metrics": {
                "speed_mph": 62.0 + (i % 5) * 0.4,
                "engine_rpm": 1750 + (i % 7) * 15,
                "engine_coolant_temp_f": 195.0 + (i % 3) * 1.5,
                "battery_voltage_v": 13.6,
                "fuel_level_pct": 55.0,
            },
        }
        http_json("POST", f"{BASE_URL}/api/ingest/telemetry", payload)
        time.sleep(0.02)

    outlier = {
        "vehicle_id": vehicle_id,
        "device_id": "DEVICE_001",
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "metrics": {
            "speed_mph": 82.0,
            "engine_rpm": 2850,
            "engine_coolant_temp_f": 238.0,
            "battery_voltage_v": 11.2,
            "fuel_level_pct": 48.0,
        },
    }
    http_json("POST", f"{BASE_URL}/api/ingest/telemetry", outlier)

    _, alert = http_json(
        "GET", f"{BASE_URL}/api/alerts/latest?vehicle_id={vehicle_id}"
    )
    status, learning = http_json(
        "GET", f"{BASE_URL}/api/vehicles/{vehicle_id}/learning-status"
    )

    print("Latest alert:", alert)
    print("Learning status:", learning)


if __name__ == "__main__":
    main()
