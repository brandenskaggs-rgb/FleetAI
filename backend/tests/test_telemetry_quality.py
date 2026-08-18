from backend.app.ml.diagnosis import run_diagnosis
from backend.app.ml.features import coalesce_samples, extract_features


def sample(ts: str, **metrics):
    return {"vehicleId": "VEH_TEST", "ts": ts, "metrics": metrics}


def test_burst_samples_are_coalesced_and_richer_metrics_survive():
    rows = [
        sample("2026-08-18T12:00:00.000Z", rpm=900, batteryVoltage=14.2),
        sample("2026-08-18T12:00:00.050Z", rpm=905, coolantTemp=94),
        sample("2026-08-18T12:00:05.000Z", rpm=910),
    ]
    merged = coalesce_samples(rows)
    assert len(merged) == 2
    assert merged[0]["metrics"]["rpm"] == 905
    assert merged[0]["metrics"]["batteryVoltage"] == 14.2
    assert merged[0]["metrics"]["coolantTemp"] == 94


def test_invalid_zero_voltage_does_not_train_python_features():
    features = extract_features([
        sample("2026-08-18T12:00:00.000Z", rpm=0, batteryVoltage=0),
        sample("2026-08-18T12:00:05.000Z", rpm=900, batteryVoltage=14.3),
    ])
    stats = features["window_stats"]["batteryVoltage"]["all"]
    assert stats["count"] == 1
    assert stats["mean"] == 14.3


def test_engine_off_heat_soak_does_not_name_cooling_components():
    diagnosis = run_diagnosis(
        current_metrics={"rpm": 0, "coolantTemp": 104, "batteryVoltage": 12.84},
        dtc_codes=[],
        window_stats={"coolantTemp": {"h24": {"slope": 0.8}}},
    )
    assert diagnosis["primaryDiagnosis"] is None
    assert diagnosis["noFaultDetected"] is True


def test_normal_running_temperature_does_not_name_cooling_components():
    diagnosis = run_diagnosis(
        current_metrics={"rpm": 850, "coolantTemp": 104, "batteryVoltage": 14.2},
        dtc_codes=[],
        window_stats={"coolantTemp": {"h24": {"slope": 0.1}}},
    )
    assert diagnosis["primaryDiagnosis"] is None
