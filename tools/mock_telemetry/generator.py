#!/usr/bin/env python3
"""Simple mock telemetry generator for local testing."""
import json
import sys
from datetime import datetime
import random


def generate_telemetry(vehicle_id: str = "VEHICLE_001") -> dict:
    return {
        "vehicle_id": vehicle_id,
        "ts": datetime.utcnow().isoformat() + "Z",
        "speed": round(random.uniform(0, 80), 1),
        "rpm": random.randint(600, 3000),
        "coolant_temp": round(random.uniform(70, 110), 1),
        "fuel_level": round(random.uniform(5, 100), 1),
        "mileage": round(random.uniform(10000, 200000), 1),
        "engine_hours": round(random.uniform(100, 5000), 1),
    }


def main():
    vehicle_id = sys.argv[1] if len(sys.argv) > 1 else "VEHICLE_001"
    payload = generate_telemetry(vehicle_id)
    print(json.dumps(payload, indent=2))


if __name__ == "__main__":
    main()
