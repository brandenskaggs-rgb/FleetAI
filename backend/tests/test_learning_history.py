"""Synthetic-only learning regressions; optional PostgreSQL uses temp tables."""
import asyncio
import json
import os
import time
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock

import pytest

from backend.app.ml.features import coalesce_samples, metric_value
from backend.app.ml.learning_history import add, remove, merge_observation, reconcile


def sample(seconds=0, **metrics):
    ts = datetime(2026, 1, 1, tzinfo=timezone.utc) + timedelta(seconds=seconds)
    return {"id": str(seconds), "ts": ts.isoformat(), "createdAt": ts,
            "vehicleId": "fixture", "orgId": "org-a", "metrics": metrics}


def test_pressure_provenance_and_stale_aliases():
    for field in ["fuelPressure", "oilPressure"]:
        assert metric_value({"metrics": {field: 689.4757293, field + "Kpa": 689.4757293}}, field) == pytest.approx(100)
        assert metric_value({"metrics": {field: 100, field + "Kpa": None}}, field) is None
    assert metric_value({"metrics": {"tirePressureKpa": 230}}, "tirePressure") == 230
    assert metric_value({"metrics": {"fuelPressure": 336}, "raw": {"fuelPressureKpa": 336}}, "fuelPressure") == pytest.approx(48.73268, rel=1e-5)
    assert metric_value({"metrics": {"fuelPressure": None}, "raw": {"fuelPressureKpa": 336}}, "fuelPressure") is None
    assert metric_value({"metrics": {"fuelPressure": 50}}, "fuelPressure") == 50


def test_coalescing_uses_event_order_units_and_tenant():
    earlier = {**sample(1, fuelPressure=336, rpm=800), "raw": {"fuelPressureKpa": 336}}
    later = sample(2, rpm=900)
    merged = coalesce_samples([later, earlier])
    assert len(merged) == 1
    assert metric_value(merged[0], "fuelPressure") == pytest.approx(336/6.894757293)
    assert merged[0]["metrics"]["rpm"] == 900
    assert len(coalesce_samples([earlier, {**earlier, "orgId": "org-b"}])) == 2
    assert coalesce_samples([{**earlier, "ts": "bad-date"}]) == []
    assert coalesce_samples([sample(0, rpm=0)])[0]["metrics"]["rpm"] == 0


def test_naive_event_time_is_utc_not_machine_timezone():
    first = sample(1, rpm=800)
    second = {**sample(2, rpm=900), "ts": "2025-12-31T18:00:02-06:00"}
    first["ts"] = "2026-01-01T00:00:01"
    merged = coalesce_samples([second, first])
    assert len(merged) == 1
    assert merged[0]["metrics"]["rpm"] == 900


def test_welford_inverse_and_replacements_do_not_double_count():
    stats = {}
    observation = merge_observation({}, sample(1, rpm=800, batteryVoltage=14), stats)
    again = merge_observation(observation, sample(1, rpm=800, batteryVoltage=14), stats)
    assert again == observation
    assert stats["rpm"]["count"] == 1
    observation = merge_observation(observation, sample(2, rpm=900, batteryVoltage=13), stats)
    assert stats["rpm"] == {"count": 1, "mean": 900, "M2": 0}
    assert merge_observation(observation, sample(0, rpm=2000), stats) == observation
    assert merge_observation(observation, sample(3, rpm=None), stats) == observation
    state = {}
    for value in [10, 20, 30]:
        state = add(state, value)
    assert remove(state, 20) == {"count": 2, "mean": 20, "M2": 200}


def test_prediction_freezes_learning_on_transaction_failure(monkeypatch):
    from backend.app.routes import predict as route
    monkeypatch.setattr(route.pg_db, "is_available", lambda: True)
    monkeypatch.setattr(route.pg_db, "reconcile_vehicle_learning", AsyncMock(side_effect=RuntimeError("fixture")))
    result = asyncio.run(route._reconcile_learning("fixture", "org-a"))
    assert result["mode"] == "learning_paused"
    assert result["durable"] is False


def test_prediction_cannot_overwrite_transaction_owned_welford(monkeypatch):
    from backend.app.routes import predict as route
    from backend.app.ml.isolation_forest import VehicleIsolationForest
    save = AsyncMock()
    monkeypatch.setattr(route.pg_db, "upsert_model_state", save)
    asyncio.run(route._persist_state("fixture", "org-a", VehicleIsolationForest(), persist_welford=False))
    payload = save.call_args.args[2]
    assert "welford" not in payload
    assert "learningHistory" not in payload
    assert "last_running_sample_ts" not in payload


def test_temporal_snapshot_roundtrip_is_scoped_and_replay_safe():
    from backend.app.ml.stage3 import _buffer, export_vehicle_history, restore_vehicle_history
    first, second = 'test-persist-a', 'test-persist-b'
    _buffer.push(first, "coolantTemp", 1, 90)
    _buffer.push(first, "coolantTemp", 2, 92)
    _buffer.push(second, "coolantTemp", 1, 99)
    saved = export_vehicle_history(first)
    restore_vehicle_history(first, None)
    assert export_vehicle_history(first)["signals"] == {}
    restore_vehicle_history(first, saved)
    _buffer.push(first, "coolantTemp", 2, 100)
    assert export_vehicle_history(first) == saved
    assert export_vehicle_history(second)["signals"]["coolantTemp"] == [[1, 99]]


def test_review_candidates_reject_other_tenants_and_expired_evidence():
    from backend.app.ml.runtime_state import live_review
    candidate = {"orgId": "a", "vehicleId": "car", "queuedAt": time.time(), "priority": .1}
    assert live_review(candidate, "a", "car")
    assert not live_review(candidate, "b", "car")
    assert not live_review(candidate, "a", "other")
    assert not live_review({**candidate, "queuedAt": 1}, "a")
    assert not live_review({**candidate, "priority": float("nan")}, "a")


def test_status_counts_all_scoped_samples_not_a_one_row_probe(monkeypatch):
    from backend.app.db import pg

    class Conn:
        async def fetchrow(self, sql, *args, **kwargs):
            assert '"vehicleId"=$1 AND "orgId"=$2' in sql
            assert args == ("fixture", "org-a")
            assert "count(*)" in sql
            return {"count": 42, "first": datetime(2026, 1, 1), "last": datetime(2026, 1, 2)}

    class Pool:
        @asynccontextmanager
        async def acquire(self):
            yield Conn()

    monkeypatch.setattr(pg, "_pool", Pool())
    monkeypatch.setattr(pg, "is_available", lambda: True)
    result = asyncio.run(pg.get_telemetry_coverage("fixture", "org-a"))
    assert result["dbSampleCount"] == 42
    assert result["lastEventUtc"] == "2026-01-02T00:00:00Z"


@pytest.mark.skipif(not os.environ.get("FLEETAI_TEST_DATABASE_URL"), reason="Explicit PostgreSQL temp-table test connection required")
def test_postgres_learning_replay_late_uploads_scope_and_rollback():
    async def scenario():
        import asyncpg
        conn = await asyncpg.connect(os.environ["FLEETAI_TEST_DATABASE_URL"], timeout=15,
                                     server_settings={"application_name": "fleetai-synthetic-learning-test"})
        outer = conn.transaction()
        await outer.start()
        try:
            # No persistent schema, production telemetry, or model rows touched.
            await conn.execute('''SET LOCAL search_path=pg_temp;
                CREATE TEMP TABLE "Vehicle"("vehicleId" text PRIMARY KEY,"orgId" text);
                CREATE TEMP TABLE "ModelState"("vehicleId" text PRIMARY KEY,"orgId" text,state jsonb,"updatedAt" timestamp);
                CREATE TEMP TABLE "TelemetrySample"(id text PRIMARY KEY,"vehicleId" text,"orgId" text,ts timestamp,"createdAt" timestamp,metrics jsonb,raw jsonb);
                CREATE TEMP TABLE "MlLearningObservation"("orgId" text,"vehicleId" text,"schemaVersion" text,"bucketAt" timestamp,observations jsonb,PRIMARY KEY("orgId","vehicleId","schemaVersion","bucketAt"));
                CREATE TEMP TABLE "FeedbackLog"(id text PRIMARY KEY,"orgId" text,"vehicleId" text,outcome text,features jsonb,"createdAt" timestamp);
                INSERT INTO "Vehicle" VALUES('fixture-a','org-a'),('fixture-b','org-b'),('mismatch','org-a');
                INSERT INTO "ModelState" VALUES('fixture-a','org-a','{"welford":{"rpm":{"count":999,"mean":42,"M2":0}}}',now()),
                  ('fixture-b','org-b','{"untouched":true}',now()),('mismatch','org-b','{}',now());''')

            class Pool:
                @asynccontextmanager
                async def acquire(self):
                    yield conn

            async def insert(identifier, event, arrival, rpm, vehicle="fixture-a", org="org-a"):
                at = datetime(2026, 1, 1)
                await conn.execute('INSERT INTO "TelemetrySample" VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)',
                                   identifier, vehicle, org, at + timedelta(seconds=event),
                                   at + timedelta(seconds=arrival), json.dumps({"rpm": rpm}), '{}')

            pool = Pool()
            for i in range(5):
                await insert(str(i), i*10, i, 800+i*100)
            await insert("off", 50, 5, 0)
            await insert("other", 10, 6, 6000, "fixture-b", "org-b")
            first = await reconcile(pool, "fixture-a", "org-a", page_size=2)
            assert first["checkpoint"]["backfillPending"]
            assert first["welford"]["rpm"]["count"] == 2
            await reconcile(pool, "fixture-a", "org-a", page_size=2)
            full = await reconcile(pool, "fixture-a", "org-a", page_size=2)
            assert not full["checkpoint"]["backfillPending"]
            assert full["welford"]["rpm"] == {"count": 5, "mean": 1000, "M2": 100000}
            replay = await reconcile(pool, "fixture-a", "org-a")
            assert replay["welford"] == full["welford"]
            await insert("late", -10, 20, 1500)
            await insert("repeat", 40, 21, 1200)
            await insert("corrected", 41, 22, 1300)
            late = await reconcile(pool, "fixture-a", "org-a")
            assert late["welford"]["rpm"]["count"] == 6
            assert late["welford"]["rpm"]["mean"] == pytest.approx(1100)
            assert late["welford"]["rpm"]["M2"] == pytest.approx(340000)
            # A transaction with an older insertion timestamp can commit after
            # the five-minute overlap. The durable daily rescan must find it.
            await insert("late-commit", -20, -600, 1100)
            await conn.execute('''UPDATE "ModelState" SET state=jsonb_set(state,
                '{learningHistory,lastFullScanCompletedAt}', '"2020-01-01T00:00:00+00:00"'::jsonb)
                WHERE "vehicleId"='fixture-a' ''')
            rescanned = await reconcile(pool, "fixture-a", "org-a")
            assert rescanned["welford"]["rpm"]["count"] == 7
            assert rescanned["welford"]["rpm"]["mean"] == pytest.approx(1100)
            assert rescanned["welford"]["rpm"]["M2"] == pytest.approx(340000)
            saved = json.loads(await conn.fetchval('SELECT state FROM "ModelState" WHERE "vehicleId"=$1', "fixture-a"))
            assert saved["learningBeforeReconciliation"]["welford"]["rpm"]["count"] == 999
            assert json.loads(await conn.fetchval('SELECT state FROM "ModelState" WHERE "vehicleId"=$1', "fixture-b")) == {"untouched": True}
            with pytest.raises(ValueError, match="ownership"):
                await reconcile(pool, "fixture-a", "org-b")
            await insert("mismatch-sample", 0, 0, 900, "mismatch", "org-a")
            with pytest.raises(ValueError, match="ownership"):
                await reconcile(pool, "mismatch", "org-a")
            assert await conn.fetchval('SELECT count(*) FROM "MlLearningObservation" WHERE "vehicleId"=$1', "mismatch") == 0
            from backend.app.ml.runtime_state import temporal_evaluation, persist_review, reviews, label_review
            from backend.app.ml.stage3 import restore_vehicle_history
            temporal_key = json.dumps(["org-a", "fixture-a"])
            for day in range(4):
                # Erase process memory before each prediction to simulate restart.
                restore_vehicle_history(temporal_key, None)
                await temporal_evaluation(pool, "fixture-a", "org-a", stage2_score=.5,
                                          current_metrics={"coolantTemp": 85+day},
                                          timestamp=1767225600+day*86400)
            temporal_saved = json.loads(await conn.fetchval('SELECT state FROM "ModelState" WHERE "vehicleId"=$1', "fixture-a"))
            assert len(temporal_saved["stage3History"]["signals"]["coolantTemp"]) == 4
            assert temporal_saved["welford"]["rpm"]["count"] == 7
            candidate = {"orgId": "org-a", "vehicleId": "fixture-a", "queuedAt": time.time(), "priority": .1,
                         "features": {"synthetic_test": 1}}
            await persist_review(pool, "fixture-a", "org-a", candidate)
            assert len(await reviews(pool, "org-a")) == 1
            assert await reviews(pool, "org-b") == []
            assert not await label_review(pool, "fixture-a", "org-a", "normal", candidate)
            assert not await label_review(pool, "fixture-a", "org-a", "confirmed_normal", {**candidate, "queuedAt": 1})
            assert await label_review(pool, "fixture-a", "org-a", "confirmed_normal", candidate)
            assert await reviews(pool, "org-a") == []
            assert not await label_review(pool, "fixture-a", "org-a", "confirmed_breakdown", candidate)
            assert await conn.fetchval('SELECT count(*) FROM "FeedbackLog"') == 1
            # A feedback insert failure must leave the review pending.
            await persist_review(pool, "fixture-a", "org-a", {**candidate, "queuedAt": time.time()})
            current = (await reviews(pool, "org-a"))[0]
            await conn.execute('ALTER TABLE "FeedbackLog" ADD CONSTRAINT test_reject CHECK (outcome<>\'confirmed_breakdown\')')
            with pytest.raises(asyncpg.CheckViolationError):
                await label_review(pool, "fixture-a", "org-a", "confirmed_breakdown", current)
            assert len(await reviews(pool, "org-a")) == 1
        finally:
            await outer.rollback()
            await conn.close()

    asyncio.run(scenario())
