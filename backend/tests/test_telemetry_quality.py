from pathlib import Path

from backend.app.ml.diagnosis import run_diagnosis
from backend.app.ml.ensemble import compute_ensemble
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


def test_duty_cycle_metrics_do_not_become_mechanical_risk():
    result = compute_ensemble(
        if_score=None,
        welford_zscores={"vehicleSpeed": 5.5, "fuelLevel": -5.0},
        current_metrics={"vehicleSpeed": 130.0, "fuelLevel": 2.0},
        dtc_analysis=None,
        fleet_norm={"_summary": {}},
        fleet_boost=0.0,
        sample_count=500,
        if_trained=False,
        welford_count=500,
    )
    assert result["components"]["welford"] == 0.0
    assert result["components"]["threshold"] == 0.0
    assert result["topMetrics"] == []
    assert "Elevated signals" not in result["advisoryText"]


def test_fleet_outlier_summary_excludes_duty_cycle_metrics():
    source = (Path(__file__).parents[1] / "app" / "ml" / "fleet.py").read_text()
    assert '_CONTEXT_ONLY_METRICS = {"vehicleSpeed", "fuelLevel"}' in source
    assert "if metric_key not in _CONTEXT_ONLY_METRICS:" in source
