"""Deterministic fixtures only: no production DB, telemetry, or artifact writes."""
import asyncio
import json
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock
import numpy as np
import pandas as pd
import pytest
from backend.app.ml.feature_contract import (
    PRETRAINED_FEATURES, STAGE2_FEATURES, TEMPORAL_KEYS, manifest, vector,
    validate_features, temporal_acceleration, elapsed_delta, supervised_label)
from backend.app.ml.evaluation import partition, metrics, fit_calibration
from backend.app.ml.artifact_registry import Registry
from backend.app.ml.stacking_evidence import generate_oof
from backend.app.ml.pretrained import PretrainedScorer, PRETRAINED_FEATURE_COLUMNS
from backend.app.ml.stage2 import Stage2Classifier
from backend.app.ml.isolation_forest import VehicleIsolationForest
from backend.app.ml.conformal import ConformalPredictor
from backend.app.ml.features import extract_features, metric_value
from backend.app.ml.stage3 import SignalHistory


def test_all_schema_copies_match():
    from fleet_ai.training.fleet_simulation import FEATURE_COLUMNS
    from fleet_ai.training.train_stage2 import STAGE2_FEATURES as TRAIN_STAGE2
    assert len(PRETRAINED_FEATURES) == 93
    assert len(TEMPORAL_KEYS) == 10
    assert FEATURE_COLUMNS == PRETRAINED_FEATURE_COLUMNS == PRETRAINED_FEATURES
    assert TRAIN_STAGE2 == STAGE2_FEATURES
    with pytest.raises(ValueError):
        validate_features(list(reversed(PRETRAINED_FEATURES)))
    assert np.isnan(vector({}, ["rpm"])[0])


def test_acceleration_uses_elapsed_hours_and_never_future():
    start = datetime(2026, 1, 1, tzinfo=timezone.utc)
    points = [(start+timedelta(hours=t), 2*t*t+3*t+10) for t in [0, .1, .5, 1, 3, 5]]
    assert temporal_acceleration(points, points[-1][0]) == pytest.approx(4)
    assert temporal_acceleration(points[:5]) is None
    assert temporal_acceleration(points+[(start+timedelta(days=2), 1e9)], points[-1][0]) == pytest.approx(4)


def test_thirty_rows_are_not_thirty_days():
    from fleet_ai.training.train_real_world import build_derived_features, BASE_FEATURES
    start = datetime(2026, 1, 1, tzinfo=timezone.utc)
    rows = [{**{k: float(i) for k in BASE_FEATURES}, "truck_id": "fixture",
             "timestamp": start+timedelta(minutes=i)} for i in range(40)]
    derived = build_derived_features(pd.DataFrame(rows))
    assert derived["engine_temp_delta_30d"].isna().all()
    assert derived["rpm_roll7_mean"].isna().all()
    assert elapsed_delta([(start, 10), (start+timedelta(days=30), 13)], start+timedelta(days=30)) == 3
    assert elapsed_delta([(start, 10), (start+timedelta(days=34), 13)], start+timedelta(days=34)) is None


def test_builder_supplies_all_ten_accelerations_and_missing_evidence():
    flat = {f"{key}_accel_h24": .25 for key in TEMPORAL_KEYS}
    row, evidence = PretrainedScorer().build_input({"rpm": 1500}, {}, {}, flat)
    assert all(row[f"{key}_accel_h24"] == .25 for key in TEMPORAL_KEYS)
    assert row["battery_voltage"] is None
    assert "battery_voltage" in evidence["missingFeatures"]
    assert set(PRETRAINED_FEATURES) <= set(row)


def test_training_replays_production_feature_transform():
    from fleet_ai.training.canonical_inputs import canonical_training_frame
    frame = pd.DataFrame([{"vehicle_id": "fixture", "timestamp": "2026-01-01T00:00:00Z",
                           "rpm": 1500., "engine_temp": 90., "battery_voltage": 14.,
                           "vehicle_class": "passenger_car", "make": "Chevrolet", "model_year": 2020}])
    trained = canonical_training_frame(frame)
    expected, _ = PretrainedScorer().build_input(
        {"rpm": 1500., "coolantTemp": 90., "batteryVoltage": 14.},
        {key: {"all": {"mean": value}, "h24": {"mean": value, "std": 0}}
         for key,value in [("rpm",1500.),("coolantTemp",90.),("batteryVoltage",14.)]},
        {"vehicleClass": "passenger_car", "make": "Chevrolet", "year": 2020}, {})
    np.testing.assert_allclose(trained[PRETRAINED_FEATURES].to_numpy(dtype=float)[0], vector(expected, PRETRAINED_FEATURES), equal_nan=True)


def test_pressure_alias_units_and_missing_stage2():
    assert metric_value({"metrics": {"fuelPressureKpa": 689.4757293}}, "fuelPressure") == pytest.approx(100)
    row = Stage2Classifier.build_features({"riskProbability": .4}, {"currentMetrics": {"ambientTemp": 0}})
    assert row.shape == (1, 29)
    assert row[0, STAGE2_FEATURES.index("ambient_temp")] == 0
    assert np.isnan(row[0, STAGE2_FEATURES.index("battery_voltage")])


def test_irregular_multirow_training_inference_parity():
    from fleet_ai.training.canonical_inputs import canonical_training_frame
    start = datetime(2026, 1, 1, tzinfo=timezone.utc)
    hours = [0, .2, .7, 1, 2, 3, 4, 721]
    records = [{"vehicle_id": "fixture", "timestamp": start+timedelta(hours=h),
                "rpm": 1500., "engine_temp": 80+h*.01+h*h*.0001,
                "battery_voltage": 14.-h*.0001} for h in hours]
    trained = canonical_training_frame(pd.DataFrame(records))
    for index in range(len(records)):
        samples = [{"ts": record["timestamp"].isoformat(), "metrics": {
            "rpm": record["rpm"], "coolantTemp": record["engine_temp"],
            "batteryVoltage": record["battery_voltage"]}} for record in records[:index+1]]
        features = extract_features(samples)
        expected, _ = PretrainedScorer().build_input(features["current_metrics"], features["window_stats"], {}, features["flat"])
        np.testing.assert_allclose(trained[PRETRAINED_FEATURES].to_numpy(dtype=float)[index],
                                   vector(expected, PRETRAINED_FEATURES), equal_nan=True, atol=1e-5)


def test_stage2_prediction_failure_preserves_fallback():
    from unittest.mock import Mock
    model = Stage2Classifier()
    model._loaded = True
    model._model = Mock()
    model._model.predict_proba.side_effect = RuntimeError("fixture inference failure")
    assert model.score({"riskProbability": .4}, {}) is None


def test_review_outcome_is_not_acknowledged_before_persistence(monkeypatch):
    from backend.app.routes import predict as routes
    from backend.app.ml import active_learning as learning
    from fastapi import HTTPException
    queue = learning.ActiveLearningQueue()
    monkeypatch.setattr(learning, "_queue", queue)
    queue.maybe_enqueue("fixture", "org-a", .5, .5, "CLEAR", "review", {})
    save = AsyncMock(return_value=False)
    monkeypatch.setattr(routes.pg_db, "save_review_feedback", save)
    request = routes.LabelRequest(vehicleId="fixture", orgId="org-a", outcome="confirmed_normal")
    with pytest.raises(HTTPException) as failure:
        asyncio.run(routes.label_prediction(request))
    assert failure.value.status_code == 503
    assert queue.peek("fixture", "org-a") is not None
    assert queue.peek("fixture", "org-b") is None
    save.return_value = True
    result = asyncio.run(routes.label_prediction(request))
    assert result["persisted"] and not result["trainingEligible"]
    assert queue.peek("fixture", "org-a") is None


def test_oof_unknown_dates_and_unbound_conformal_are_rejected():
    from backend.app.ml.stacking_evidence import require_oof
    with pytest.raises(ValueError):
        require_oof({"provenance": {"source": "real_oof", "outerPartition": "train",
                                  "groupDisjoint": True, "fitExamplesHash": "fixture"}})
    model = ConformalPredictor()
    model.fit([.1, .9]*20, [0, 1]*20)
    model.fit([.1], [0])
    assert not model.is_fitted()
    assert not model.load()
    with pytest.raises(RuntimeError):
        model.save()


def test_temporal_pruning_cannot_remove_another_tenants_history():
    from backend.app.ml.stage3 import TemporalBuffer
    buffer = TemporalBuffer()
    first, second = json.dumps(["org-a", "fixture"]), json.dumps(["org-b", "fixture"])
    buffer.push(first, "rpm", 1, 1000)
    buffer.push(second, "rpm", 1, 1000)
    buffer.prune_old(1000, first)
    assert len(buffer.get(first, "rpm")) == 0
    assert len(buffer.get(second, "rpm")) == 1
    assert buffer.vehicle_count("org-a") == 1
    assert buffer.vehicle_count("org-c") == 0


def test_multiseed_sampling_retains_whole_vehicle_history():
    from fleet_ai.training.fleet_simulation import sample_vehicle_histories
    frame = pd.DataFrame([{"vehicle_id": vehicle, "timestamp": day}
                          for vehicle in range(10) for day in range(32)])
    sampled = sample_vehicle_histories(frame, 100, 42)
    assert len(sampled) == 96
    assert (sampled.groupby("vehicle_id").size() == 32).all()
    pd.testing.assert_frame_equal(sampled, sample_vehicle_histories(frame, 100, 42))


def test_changed_feature_semantics_block_artifact_promotion(tmp_path):
    registry = Registry(tmp_path)
    wrong = {**manifest(STAGE2_FEATURES), "version": "incompatible"}
    identifier = registry.candidate("stage2", {"features": STAGE2_FEATURES},
                                    {"trainingSource": "synthetic_fixture", "featureSchema": wrong})
    registry.evaluate(identifier, {"partition": "untouched_test", "evidenceSource": "synthetic_fixture",
                                    "metrics": metrics([0,1], [.1,.9])})
    with pytest.raises(ValueError):
        registry.promote(identifier, "fixture rejection")
    assert registry.load_active("stage2") is None


def test_independent_partition_and_unknown_labels():
    frame = pd.DataFrame([{"vehicle_id": str(v), "timestamp": f"2026-01-{d:02d}"} for v in range(10) for d in range(1, 31)])
    train, val, test = partition(frame)
    assert set(train.vehicle_id).isdisjoint(val.vehicle_id)
    assert set(train.vehicle_id).isdisjoint(test.vehicle_id)
    assert train.timestamp.max() < val.timestamp.min() < test.timestamp.min()
    assert supervised_label("no_event") is None
    assert supervised_label("normal") is None
    assert supervised_label("confirmed_normal") == 0
    assert metrics([0,0], [.1,.2])["roc_auc"] is None
    cal, meta = fit_calibration([0,1], [.1,.9], "real_confirmed", "fixture-v1")
    assert cal is None and meta["status"] == "uncalibrated"


def test_oof_refuses_seen_groups_future_and_overlapping_rows():
    frame = pd.DataFrame({"vehicle_id": ["a","b","a"], "timestamp": ["2026-01-01","2026-01-02","2026-01-03"]})
    fit = lambda rows: list(rows.index)
    score = lambda model, rows: [{"upstream": model} for _ in rows.index]
    evidence = generate_oof(frame, [([0],[1])], fit, score)
    assert evidence[0]["features"]["upstream"] == [0]
    for folds in [([0],[0]), ([0],[2]), ([2],[1])]:
        with pytest.raises(ValueError):
            generate_oof(frame, [folds], fit, score)


def test_registry_candidate_promotion_rollback_and_durable_lease(tmp_path):
    registry = Registry(tmp_path)
    metadata = {"trainingSource": "synthetic_fixture", "featureSchema": manifest()}
    first = registry.candidate("fixture", {"features": PRETRAINED_FEATURES}, metadata)
    assert registry.load_active("fixture") is None
    with pytest.raises(ValueError):
        registry.promote(first, "reviewed")
    report = {"partition": "untouched_test", "evidenceSource": "synthetic_fixture", "metrics": metrics([0,1],[.2,.8])}
    registry.evaluate(first, report)
    registry.promote(first, "fixture evaluation reviewed")
    second = registry.candidate("fixture", {}, metadata)
    registry.evaluate(second, report)
    registry.promote(second, "fixture replacement")
    registry.promote(first, "fixture rollback")
    assert Registry(tmp_path).load_active("fixture")["artifactId"] == first
    token = registry.claim("job", now=100)
    assert Registry(tmp_path).claim("job", now=101) is None
    registry.finish("job", token, "candidate", interval_seconds=10, now=102)
    assert Registry(tmp_path).claim("job", now=111) is None
    assert Registry(tmp_path).claim("job", now=112)


def test_isolation_forest_missingness_roundtrip():
    vif = VehicleIsolationForest()
    assert not vif.fit([{"rpm_current": 1}] * 49)
    assert vif.fit([{"rpm_current": 1200+i} for i in range(60)])
    value = vif.score({"rpm_current": 1250})
    restored = VehicleIsolationForest.from_state_dict(vif.to_state_dict())
    assert restored.score({"rpm_current": 1250}) == value
    assert not restored.needs_retraining()


def test_conformal_verdicts_and_no_fake_coverage():
    model = ConformalPredictor()
    assert model.predict(.9)["coverage_guarantee"] is None
    model.fit([.9,.1]*100, [1,0]*100)
    assert model.predict(.99)["verdict"] == "CONFIRMED"
    assert model.predict(.01)["verdict"] == "REJECTED"
    assert not ConformalPredictor().restore_bound(model.to_bundle(), "wrong-model")


def test_temporal_replay_does_not_add_observations():
    history = SignalHistory()
    history.push(1, 5)
    history.push(1, 8)
    history.push(.5, 10)
    assert len(history) == 1


def test_prediction_scope_and_welford_isolation(monkeypatch):
    from backend.app.routes import predict as module
    from fastapi import HTTPException
    module._welford_state.clear()
    a = module._get_welford_state("fixture", "org-a")
    a["rpm"] = module._welford_update({}, 1000)
    assert module._get_welford_state("fixture", "org-b") == {}
    with pytest.raises(HTTPException):
        asyncio.run(module.predict(module.PredictRequest(vehicleId="fixture")))
    with pytest.raises(HTTPException):
        asyncio.run(module.predict(module.PredictRequest(vehicleId="fixture", orgId="org-a", samples=[{"orgId":"org-b"}])))


def test_fleet_query_receives_tenant_and_class(monkeypatch):
    from backend.app.ml import fleet
    read = AsyncMock(return_value={})
    monkeypatch.setattr(fleet.pg_db, "get_fleet_baselines", read)
    asyncio.run(fleet.compute_fleet_normalization("fixture", {"rpm":{"h24":{"mean":1000}}}, "org-a", "passenger_car"))
    read.assert_awaited_once_with("rpm", "passenger_car", "org-a", "fixture")


@pytest.mark.parametrize("prior,forest,count", [(None,None,0),(.5,None,100),(.5,.4,500),(.5,.4,10)])
def test_stage1_weights_redistribute_without_changing_scale(prior, forest, count):
    from backend.app.ml.ensemble import _blend
    score, weights = _blend(prior, forest, .3, .2, .1, count)
    assert sum(weights.values()) == pytest.approx(1, abs=.0002)
    assert 0 <= score <= 1
    if prior is None or count >= 500:
        assert weights["pretrained"] == 0
    if forest is None:
        assert weights["isolationForest"] == 0


def test_dtc_remains_independent_evidence():
    from backend.app.ml.dtc import analyze_dtcs
    from backend.app.ml.ensemble import _dtc_score
    analysis = analyze_dtcs(["P0217"])
    assert _dtc_score(analysis) > 0
    assert _dtc_score(None) == 0


@pytest.mark.parametrize("stage1,stage2,expected2,expected3", [(.1,.5,0,0),(.8,.1,1,0),(.8,.5,1,1),(.8,.9,1,0)])
def test_pipeline_gates_lineage_and_idempotent_learning(monkeypatch, stage1, stage2, expected2, expected3):
    from backend.app.routes import predict as module
    module._welford_state.clear()
    module._welford_last_event_ts.clear()
    module._if_cache.clear()
    module._prediction_locks.clear()
    monkeypatch.setattr(module.pg_db, "get_recent_samples", AsyncMock(return_value=[]))
    monkeypatch.setattr(module.pg_db, "get_model_state", AsyncMock(return_value=None))
    monkeypatch.setattr(module.pg_db, "upsert_baseline", AsyncMock())
    monkeypatch.setattr(module.pg_db, "upsert_model_state", AsyncMock())
    monkeypatch.setattr(module.pg_db, "get_fleet_baselines", AsyncMock(return_value={}))
    monkeypatch.setattr(module, "compute_ensemble", lambda **kwargs: {"riskProbability":stage1, "confidence":.2, "components":{}, "prediction":"monitor_closely"})
    calls = {"second":0, "third":0}
    def score_second(*args):
        calls["second"] += 1
        return {"stage2_probability":stage2, "signal_agreement":.8, "confirmed":False, "confirmation_reason":"fixture"}
    def score_third(**kwargs):
        calls["third"] += 1
        assert json.loads(kwargs["vehicle_id"])[0] == "fixture-org"
        assert kwargs["timestamp"] is not None
        return None
    monkeypatch.setattr(module, "score_stage2", score_second)
    monkeypatch.setattr(module, "evaluate_stage3", score_third)
    samples = [{"ts":f"2026-01-01T00:{i:02d}:00Z", "metrics":{"rpm":1000+i,"coolantTemp":90,"batteryVoltage":14}} for i in range(12)]
    request = module.PredictRequest(vehicleId="fixture", orgId="fixture-org", samples=samples)
    result = asyncio.run(module.predict(request))
    assert calls == {"second":expected2, "third":expected3}
    before = module._welford_state[("fixture-org","fixture")]["rpm"]["count"]
    asyncio.run(module.predict(request))
    assert module._welford_state[("fixture-org","fixture")]["rpm"]["count"] == before
    assert result["lineage"]["stage1"]["riskProbability"] == stage1
    json.dumps(result, allow_nan=False)


def test_database_scopes_are_bound_parameters(monkeypatch):
    from backend.app.db import pg
    class Connection:
        def __init__(self):
            self.calls = []
        async def fetchrow(self, sql, *args):
            self.calls.append((sql,args))
            return None
        async def fetch(self, sql, *args):
            self.calls.append((sql,args))
            return []
        async def __aenter__(self):
            return self
        async def __aexit__(self, *args):
            pass
    connection = Connection()
    class Pool:
        def acquire(self):
            return connection
    monkeypatch.setattr(pg, "_pool", Pool())
    monkeypatch.setattr(pg, "_db_available", True)
    asyncio.run(pg.get_model_state("fixture", "org-a"))
    asyncio.run(pg.get_recent_samples("fixture", "org-a"))
    asyncio.run(pg.get_fleet_baselines("rpm", "passenger_car", "org-a", "fixture"))
    assert len(connection.calls) == 3
    for sql, params in connection.calls:
        assert '"orgId"' in sql and "org-a" in params
    assert 'peer."type"' in connection.calls[-1][0]
    asyncio.run(pg.get_model_state("fixture"))
    asyncio.run(pg.get_fleet_baselines("rpm"))
    assert len(connection.calls) == 3
