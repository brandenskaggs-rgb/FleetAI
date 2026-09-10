"""Durable, reversible Welford contributions for five-second observations.

Arrival order is not measurement order. Each metric's newest observed value
within a bucket contributes once; corrections replace, rather than duplicate,
that contribution. No supervised labels or model promotions occur here.
"""
from __future__ import annotations
import json
import math
from datetime import datetime, timezone
from .feature_contract import manifest
from .features import METRIC_KEYS, metric_value
from .engine_state import DEFAULTS

BUCKET_SECONDS = 5
PAGE_SIZE = 3000
LEARNING_VERSION = "bucket-welford-v1"


def utc(value):
    if isinstance(value, str):
        value = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def add(state, value):
    count = state.get("count", 0) + 1
    delta = value - state.get("mean", 0.0)
    mean = state.get("mean", 0.0) + delta / count
    return {"count": count, "mean": mean, "M2": max(0.0, state.get("M2", 0.0) + delta * (value - mean))}


def remove(state, value):
    count = state.get("count", 0)
    if count <= 1:
        return {"count": 0, "mean": 0.0, "M2": 0.0}
    mean = (count * state["mean"] - value) / (count - 1)
    m2 = state["M2"] - (value - state["mean"]) * (value - mean)
    return {"count": count - 1, "mean": mean, "M2": max(0.0, m2)}


def merge_observation(previous, sample, stats):
    """Pure reconciliation; stable timestamps prevent arrival-order bias."""
    merged = {key: dict(value) for key, value in previous.items()}
    event_time = utc(sample["ts"]).timestamp()
    # Same-time corrections use ingestion time/id only as a deterministic tie break.
    order = [event_time, utc(sample["createdAt"]).timestamp(), sample["id"]]
    for key in METRIC_KEYS:
        value = metric_value(sample, key)
        if value is None:
            continue  # Missing data cannot erase another real sensor observation.
        old = merged.get(key)
        if old and order <= old["order"]:
            continue
        if old and old["value"] == value:
            merged[key] = {"value": value, "order": order}
            continue
        current = stats.get(key, {})
        if old:
            current = remove(current, old["value"])
        stats[key] = add(current, value)
        merged[key] = {"value": value, "order": order}
    return merged


def decoded(value):
    return json.loads(value) if isinstance(value, str) else value


async def reconcile(pool, vehicle_id, org_id, page_size=PAGE_SIZE):
    """One bounded catch-up page, ledger and Welford state in one transaction.

    Row insertion-time scans include delayed old events. An overlap allows for
    transactions that commit just after a previous scan; the ledger deduplicates
    the overlap. Schema changes start a new retained, versioned ledger.
    """
    if not org_id or not vehicle_id:
        raise ValueError("Vehicle learning requires tenant scope")
    if not 1 <= page_size <= PAGE_SIZE:
        raise ValueError("Invalid learning page size")
    schema = LEARNING_VERSION + ":" + manifest()["sha256"]
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute("SET LOCAL lock_timeout='3000'")
            await conn.execute("SET LOCAL statement_timeout='15000'")
            await conn.execute("SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))", org_id, vehicle_id)
            owned = await conn.fetchval('SELECT 1 FROM "Vehicle" WHERE "vehicleId"=$1 AND "orgId"=$2', vehicle_id, org_id)
            if not owned:
                raise ValueError("Vehicle learning ownership mismatch")
            row = await conn.fetchrow('SELECT state FROM "ModelState" WHERE "vehicleId"=$1 AND "orgId"=$2 FOR UPDATE', vehicle_id, org_id)
            saved = decoded(row["state"]) if row else {}
            checkpoint = saved.get("learningHistory", {})
            continuing = checkpoint.get("schema") == schema
            stats = dict(saved.get("welford", {})) if continuing else {}
            cursor = checkpoint.get("cursor") if continuing else None
            completed = checkpoint.get("lastFullScanCompletedAt") if continuing else None
            now_utc = datetime.now(timezone.utc)
            # A periodic idempotent rescan also catches arbitrarily late database
            # commits and historical in-place corrections, not just late uploads.
            rescanning = checkpoint.get("rescanning", False) if continuing else False
            if completed and not rescanning and (now_utc - utc(completed)).total_seconds() >= 86400:
                cursor = None
                rescanning = True
            cursor_time = utc(cursor["createdAt"]).replace(tzinfo=None) if cursor else datetime(1970, 1, 1)
            cursor_id = cursor["id"] if cursor else ""
            records = await conn.fetch('''SELECT id,ts,"createdAt",metrics,raw FROM "TelemetrySample"
                WHERE "vehicleId"=$1 AND "orgId"=$2 AND ("createdAt",id)>($3,$4)
                ORDER BY "createdAt",id LIMIT $5''', vehicle_id, org_id, cursor_time, cursor_id, page_size + 1)
            pending = len(records) > page_size
            records = list(records[:page_size])
            if not pending and cursor:
                # Small arrival overlap; already-seen observations are idempotent.
                overlap = await conn.fetch('''SELECT id,ts,"createdAt",metrics,raw FROM "TelemetrySample"
                    WHERE "vehicleId"=$1 AND "orgId"=$2 AND "createdAt">=$3::timestamp-interval '5 minutes'
                    AND ("createdAt",id)<=($3,$4) ORDER BY "createdAt",id LIMIT $5''',
                    vehicle_id, org_id, cursor_time, cursor_id, page_size)
                work = list(overlap) + records
            else:
                work = records
            samples = [{**dict(row), "metrics": decoded(row["metrics"]), "raw": decoded(row["raw"]),
                        "ts": utc(row["ts"]).isoformat()} for row in work]
            now = datetime.now(timezone.utc).timestamp()
            eligible = [s for s in samples if utc(s["ts"]).timestamp() <= now + 300]
            # Learning requires RPM evidence in the frame itself. Unlike the
            # display/feature stream this policy cannot depend on page boundaries.
            eligible = [s for s in eligible if (metric_value(s, "rpm") or 0) >= DEFAULTS["running_rpm"]]
            buckets = sorted({datetime.fromtimestamp(math.floor(utc(s["ts"]).timestamp()/BUCKET_SECONDS)*BUCKET_SECONDS, timezone.utc).replace(tzinfo=None) for s in eligible})
            existing = await conn.fetch('''SELECT "bucketAt",observations FROM "MlLearningObservation"
                WHERE "vehicleId"=$1 AND "orgId"=$2 AND "schemaVersion"=$3 AND "bucketAt"=ANY($4::timestamp[])''',
                vehicle_id, org_id, schema, buckets) if buckets else []
            old = {row["bucketAt"]: decoded(row["observations"]) for row in existing}
            merged = dict(old)
            for sample in sorted(eligible, key=lambda s: (utc(s["ts"]), utc(s["createdAt"]), s["id"])):
                bucket = datetime.fromtimestamp(math.floor(utc(sample["ts"]).timestamp()/BUCKET_SECONDS)*BUCKET_SECONDS, timezone.utc).replace(tzinfo=None)
                merged[bucket] = merge_observation(merged.get(bucket, {}), sample, stats)
            changed = [{"bucket": key.isoformat(), "observations": value} for key, value in merged.items() if old.get(key) != value]
            if changed:
                await conn.execute('''INSERT INTO "MlLearningObservation"("orgId","vehicleId","schemaVersion","bucketAt",observations)
                    SELECT $1,$2,$3,x.bucket,x.observations FROM jsonb_to_recordset($4::jsonb) x(bucket timestamp,observations jsonb)
                    ON CONFLICT("orgId","vehicleId","schemaVersion","bucketAt") DO UPDATE SET observations=EXCLUDED.observations''',
                    org_id, vehicle_id, schema, json.dumps(changed, allow_nan=False))
            if records:
                last = records[-1]
                cursor = {"createdAt": utc(last["createdAt"]).isoformat(), "id": last["id"]}
            if not pending and (not completed or rescanning):
                completed = now_utc.isoformat()
                rescanning = False
            checkpoint = {"schema": schema, "cursor": cursor, "backfillPending": pending,
                          "scannedRows": (checkpoint.get("scannedRows", 0) if continuing else 0) + len(records),
                          "scope": "retained_history_five_second_observations", "engineEvidence": "frame_rpm_running",
                          "lastFullScanCompletedAt": completed, "rescanning": rescanning,
                          "updatedAt": now_utc.isoformat()}
            patch = {"welford": stats, "learningHistory": checkpoint}
            # Preserve pre-migration learning evidence instead of overwriting it irretrievably.
            if not continuing and saved.get("welford"):
                patch["learningBeforeReconciliation"] = {"welford": saved["welford"], "checkpoint": saved.get("learningHistory"), "savedAt": checkpoint["updatedAt"]}
            updated = await conn.execute('''INSERT INTO "ModelState"("vehicleId","orgId",state,"updatedAt") VALUES($1,$2,$3::jsonb,now())
                ON CONFLICT("vehicleId") DO UPDATE SET state=COALESCE("ModelState".state,'{}'::jsonb)||EXCLUDED.state,"updatedAt"=now()
                WHERE "ModelState"."orgId"=EXCLUDED."orgId"''', vehicle_id, org_id, json.dumps(patch, allow_nan=False))
            if updated != "INSERT 0 1":
                raise ValueError("Persisted learning ownership mismatch")
            return {"welford": stats, "checkpoint": checkpoint}
