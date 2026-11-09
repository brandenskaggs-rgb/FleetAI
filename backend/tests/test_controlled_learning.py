"""All observations/outcomes here are fabricated fixtures, never field evidence."""
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import json

import pytest

from backend.app.ml.controlled_learning import (build_dataset, training_window, independent_parts,
    train_candidate, component_evidence)
from backend.app.ml.artifact_registry import Registry
from backend.app.ml.evaluation import metrics, promotion_gates
from backend.app.ml.feature_contract import PRETRAINED_FEATURES, manifest


def fixture():
    start = datetime(2025, 1, 1, tzinfo=timezone.utc)
    samples = [{"ts": (start+timedelta(seconds=i*10)).isoformat(), "metrics": {"rpm": 1000, "coolantTemp": 90}} for i in range(12)]
    features = dict.fromkeys(PRETRAINED_FEATURES)
    features.update(rpm=1000, engine_temp=90, battery_voltage=14)
    prediction = {"id": "run-1", "orgId": "org-a", "vehicleId": "v-1", "modelVersion": "fixture",
        "createdAt": samples[-1]["ts"], "predictionJson": {"lineage": {"python": {"evidence": {
            "pretrained": {"schema": manifest(), "inputFeatures": features}, "trainingWindow": training_window(samples)}}}}}
    outcome = {"id": "outcome-1", "orgId": "org-a", "vehicleId": "v-1", "predictionRunId": "run-1",
        "reviewedBy": "fixture-technician", "createdAt": "2025-01-03T00:00:00Z", "outcome": "confirmed_breakdown",
        "outcomeEvidence": {"version": 1, "source": "technician", "technicianNotes": "Fixture confirmed fault",
            "component": "charging", "observedAt": "2025-01-02T00:00:00Z", "confirmedFailure": True}}
    return outcome, prediction


def test_snapshot_labels_are_reproducible_and_missingness_survives():
    outcome, prediction = fixture()
    first = build_dataset("org-a", [outcome], [prediction])
    assert first == build_dataset("org-a", [outcome], [prediction])
    assert first[2][0]["features"]["fuel_pressure"] is None
    assert first[2][0]["provenance"]["predictionRunId"] == "run-1"
    assert first[2][0]["label"] == 1


@pytest.mark.parametrize("change,reason", [
    (lambda o,p: o.update(outcome="maintenance_only"), "maintenance_is_not_failure_evidence"),
    (lambda o,p: o["outcomeEvidence"].update(observedAt="2024-01-01"), "invalid_outcome_clock"),
    (lambda o,p: p["predictionJson"]["lineage"]["python"]["evidence"]["trainingWindow"].update(invalidReadings=1), "insufficient_or_invalid_telemetry"),
    (lambda o,p: p["predictionJson"]["lineage"]["python"]["evidence"]["pretrained"].update(schema={}), "missing_or_incompatible_feature_snapshot"),
    (lambda o,p: p.update(vehicleId="wrong-vehicle"), "missing_owned_prediction"),
    (lambda o,p: o["outcomeEvidence"].update(component="brakes"), "missing_target_sensor_evidence"),
])
def test_bad_or_unconfirmed_evidence_is_excluded(change, reason):
    outcome, prediction = fixture()
    change(outcome, prediction)
    _, meta, examples = build_dataset("org-a", [outcome], [prediction])
    assert not examples and meta["excluded"][reason] == 1


def test_normal_inspection_requires_mature_coverage_and_conflicts_are_excluded():
    outcome, prediction = fixture()
    outcome.update(outcome="confirmed_normal", createdAt="2025-01-20T00:00:00Z")
    outcome["outcomeEvidence"].update(confirmedFailure=False, inspectedNormal=True, observedAt="2025-01-19T00:00:00Z")
    assert not build_dataset("org-a", [outcome], [prediction])[2]
    outcome["outcomeEvidence"]["coverageStart"] = "2025-01-01T00:00:00Z"
    assert build_dataset("org-a", [outcome], [prediction])[2][0]["label"] == 0
    failure, _ = fixture()
    failure["id"] = "failure-other"
    assert not build_dataset("org-a", [outcome, failure], [prediction])[2]


def test_tenant_boundary_and_duplicate_inspections(tmp_path):
    outcome, prediction = fixture()
    with pytest.raises(ValueError, match="Cross-tenant"):
        build_dataset("org-b", [outcome], [prediction])
    duplicate = {**outcome, "id": "other-entry"}
    identifier, meta, examples = build_dataset("org-a", [outcome, duplicate], [prediction])
    assert len(examples) == 1
    registry = Registry(tmp_path)
    registry.save_dataset(identifier, "tenant:org-a", meta, examples)
    assert registry.dataset(identifier, "tenant:org-a")[1] == examples
    with pytest.raises(ValueError, match="tenant"):
        registry.dataset(identifier, "tenant:org-b")
    assert not registry.overview("tenant:org-b")["datasets"]


def test_invalid_sensor_timestamp_and_sparse_history_are_visible():
    quality = training_window([{"ts": "broken", "metrics": {"rpm": -1}}, {"ts": "2025-01-01", "metrics": {"batteryVoltage": 999}}])
    assert quality["invalidReadings"] == 3
    with pytest.raises(ValueError):
        independent_parts([{"vehicle_id": "one", "timestamp": "2025-01-01"}])


def test_gate_failure_and_current_baseline_lock(tmp_path):
    registry = Registry(tmp_path)
    poor = metrics([0, 1]*30, [.9, .1]*30)
    good = metrics([0, 1]*30, [.1, .9]*30)
    assert not promotion_gates(poor)["passed"]
    assert promotion_gates(good)["passed"]
    assert good["false_negative_rate"] == 0
    def candidate(result, baseline_id=None):
        identifier = registry.candidate("fixture", {}, {"trainingSource": "synthetic_fixture", "featureSchema": manifest()})
        registry.evaluate(identifier, {"partition": "untouched_test", "evidenceSource": "synthetic_fixture", "metrics": result,
            "baselineArtifactId": baseline_id, "baselineMetrics": good if baseline_id else None})
        return identifier
    rejected = candidate(poor)
    with pytest.raises(ValueError, match="gates failed"):
        registry.promote(rejected, "test rejects bad results")
    first = candidate(good)
    registry.promote(first, "fixture bootstrap")
    stale = candidate(good)
    with pytest.raises(ValueError, match="current active"):
        registry.promote(stale, "missing comparison")
    second = candidate(good, first)
    registry.promote(second, "fixture comparison")
    registry.rollback("fixture", "global_synthetic", "fixture restore")
    assert registry.load_active("fixture")["artifactId"] == first


def examples_fixture():
    start = datetime(2024, 1, 1, tzinfo=timezone.utc)
    examples = []
    for vehicle in range(10):
        for day in range(120):
            t = start + timedelta(days=day*3)
            features = dict.fromkeys(PRETRAINED_FEATURES)
            features.update(rpm=1000, engine_temp=95 if day % 2 else 70)
            examples.append({"id": f"v{vehicle}-d{day}", "org_id": "org-a", "vehicle_id": str(vehicle),
                "timestamp": t.isoformat(), "observed_at": (t+timedelta(days=14)).isoformat(),
                "label_known_at": (t+timedelta(days=15)).isoformat(), "label": day % 2,
                "component": "cooling", "features": features, "lead_hours": 336 if day % 2 else None})
    return examples


def test_candidate_training_evaluation_and_scoped_inference(tmp_path, monkeypatch):
    examples = examples_fixture()
    train, validation, test = independent_parts(examples)
    assert set(train.vehicle_id).isdisjoint(validation.vehicle_id)
    assert set(validation.vehicle_id).isdisjoint(test.vehicle_id)
    assert train.timestamp.max() < validation.timestamp.min() < test.timestamp.min()
    registry = Registry(tmp_path)
    registry.save_dataset("fixture", "tenant:org-a", {"featureSchema": manifest()}, examples)
    result = train_candidate(registry, "fixture", "org-a", "cooling", git_version="fixture-only")
    assert result["promoted"] is False and result["report"]["partition"] == "untouched_test"
    assert registry.load_active("component:cooling", "tenant:org-a") is None
    registry.promote(result["candidateId"], "Automated test fixture only")
    monkeypatch.setenv("FLEETAI_ML_ARTIFACT_DIR", str(tmp_path))
    evidence = component_evidence("org-a", examples[0]["features"])
    assert evidence["results"][0]["artifactId"] == result["candidateId"]
    assert component_evidence("org-b", examples[0]["features"])["results"] == []
    with pytest.raises(ValueError, match="holdout"):
        train_candidate(registry, "fixture", "org-a", "cooling", git_version="fixture-only")
    json.dumps(registry.overview("tenant:org-a"), allow_nan=False)


def test_worker_snapshot_is_scoped_durable_and_does_not_promote(tmp_path, monkeypatch):
    import asyncio
    import asyncpg
    from types import SimpleNamespace
    from backend.app.ml.learning_worker import run
    outcome, prediction = fixture()
    class Transaction:
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
    class Connection:
        calls = []
        closed = False
        def transaction(self, **kwargs):
            assert kwargs == {"isolation": "repeatable_read", "readonly": True}
            return Transaction()
        async def execute(self, sql, *args):
            self.calls.append((sql, args))
        async def fetch(self, sql, *args):
            assert args[0] == "org-a" and '"orgId"=$1' in sql
            return [outcome] if '"FeedbackLog"' in sql else [prediction]
        async def fetchval(self, sql, *args):
            assert args == ("org-a",) and '"orgId"=$1' in sql
            return 12
        async def close(self): self.closed = True
    connection = Connection()
    async def connect(*args, **kwargs): return connection
    monkeypatch.setattr(asyncpg, "connect", connect)
    monkeypatch.setenv("DATABASE_URL", "unused-fixture")
    monkeypatch.setenv("FLEETAI_ML_ARTIFACT_DIR", str(tmp_path))
    monkeypatch.setenv("RAILWAY_GIT_COMMIT_SHA", "fixture-source")
    args = SimpleNamespace(org="org-a", component=None, gates=None)
    result = asyncio.run(run(args))
    assert result["examples"] == 1 and not result["promoted"] and connection.closed
    assert asyncio.run(run(args))["status"] == "already_leased_or_not_due"
    assert Registry(tmp_path).inventory() == []
    args.component = "charging"
    with pytest.raises(ValueError):
        asyncio.run(run(args))
    failed = [params for sql,params in connection.calls if "status='failed'" in sql]
    assert failed and json.loads(failed[-1][1])["dataset"]["examples"] == 1
    assert "fixture-technician" not in failed[-1][1]


def test_scheduler_requires_explicit_tenant_opt_in(tmp_path, monkeypatch):
    import asyncio
    from types import SimpleNamespace
    from unittest.mock import AsyncMock
    from backend.app.ml import retraining, learning_worker
    monkeypatch.setenv("FLEETAI_ML_ARTIFACT_DIR", str(tmp_path))
    monkeypatch.delenv("FLEETAI_CONTROLLED_LEARNING_TARGETS", raising=False)
    worker = AsyncMock(return_value={"status": "completed"})
    monkeypatch.setattr(learning_worker, "run", worker)
    db = SimpleNamespace(is_available=lambda: True, feedback_organizations=AsyncMock(return_value=[]))
    asyncio.run(retraining.run_due_retraining(db))
    worker.assert_not_awaited()
    monkeypatch.setenv("FLEETAI_CONTROLLED_LEARNING_TARGETS", '{"org-a":["cooling"]}')
    asyncio.run(retraining.run_due_retraining(db))
    assert worker.call_args.args[0].org == "org-a"
    assert worker.call_args.args[0].component == "cooling"
