"""Transactional, tenant-scoped persistence for temporal and review evidence."""
from __future__ import annotations
import hashlib
import json
import math
import time

from .active_learning import STALENESS_SECONDS
from .feature_contract import json_safe, supervised_label
from .stage3 import evaluate_stage3, export_vehicle_history, restore_vehicle_history


def decode(value):
    return json.loads(value) if isinstance(value, str) else value


async def mutate_field(pool, vehicle_id, org_id, field, transform):
    if not org_id or not vehicle_id or field not in {"stage3History", "reviewCandidate"}:
        raise ValueError("Runtime learning scope required")
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute("SET LOCAL lock_timeout='3000'")
            await conn.execute("SET LOCAL statement_timeout='15000'")
            await conn.execute("SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))", org_id, vehicle_id)
            if not await conn.fetchval('SELECT 1 FROM "Vehicle" WHERE "vehicleId"=$1 AND "orgId"=$2', vehicle_id, org_id):
                raise ValueError("Runtime learning ownership mismatch")
            row = await conn.fetchrow('SELECT state FROM "ModelState" WHERE "vehicleId"=$1 AND "orgId"=$2 FOR UPDATE', vehicle_id, org_id)
            saved = decode(row["state"]) if row else {}
            replacement, result = await transform(conn, saved.get(field))
            updated = await conn.execute('''INSERT INTO "ModelState"("vehicleId","orgId",state,"updatedAt") VALUES($1,$2,$3::jsonb,now())
                ON CONFLICT("vehicleId") DO UPDATE SET state=COALESCE("ModelState".state,'{}'::jsonb)||EXCLUDED.state,"updatedAt"=now()
                WHERE "ModelState"."orgId"=EXCLUDED."orgId"''',
                vehicle_id, org_id, json.dumps(json_safe({field: replacement}), allow_nan=False))
            if updated != "INSERT 0 1":
                raise ValueError("Persisted runtime learning ownership mismatch")
            return result


async def temporal_evaluation(pool, vehicle_id, org_id, **kwargs):
    key = json.dumps([org_id, vehicle_id])

    async def transform(conn, saved):
        restore_vehicle_history(key, saved)
        result = evaluate_stage3(vehicle_id=key, **kwargs)
        return export_vehicle_history(key), result

    return await mutate_field(pool, vehicle_id, org_id, "stage3History", transform)


def live_review(candidate, org_id, vehicle_id=None):
    return bool(isinstance(candidate, dict) and candidate.get("orgId") == org_id
                and (vehicle_id is None or candidate.get("vehicleId") == vehicle_id)
                and isinstance(candidate.get("queuedAt"), (int, float))
                and 0 <= time.time() - candidate["queuedAt"] < STALENESS_SECONDS
                and isinstance(candidate.get("priority"), (int, float))
                and math.isfinite(candidate["priority"]))


async def persist_review(pool, vehicle_id, org_id, candidate):
    if not live_review(candidate, org_id, vehicle_id):
        raise ValueError("Review candidate scope or evidence invalid")

    async def transform(conn, saved):
        chosen = saved if live_review(saved, org_id, vehicle_id) and saved["priority"] <= candidate["priority"] else candidate
        return chosen, chosen

    return await mutate_field(pool, vehicle_id, org_id, "reviewCandidate", transform)


async def reviews(pool, org_id, vehicle_id=None, limit=20):
    if not org_id:
        raise ValueError("Review organization required")
    async with pool.acquire() as conn:
        rows = await conn.fetch('''SELECT m.state->'reviewCandidate' AS candidate FROM "ModelState" m
            JOIN "Vehicle" v ON v."vehicleId"=m."vehicleId" AND v."orgId"=m."orgId"
            WHERE m."orgId"=$1 AND ($2::text IS NULL OR m."vehicleId"=$2)
              AND m.state->'reviewCandidate' IS NOT NULL''', org_id, vehicle_id)
    candidates = [decode(row["candidate"]) for row in rows]
    return sorted([c for c in candidates if live_review(c, org_id, vehicle_id)], key=lambda c: c["priority"])[:max(1, min(limit, 100))]


async def label_review(pool, vehicle_id, org_id, outcome, candidate):
    if supervised_label(outcome) is None:
        return False

    async def transform(conn, saved):
        if not live_review(saved, org_id, vehicle_id) or saved["queuedAt"] != candidate.get("queuedAt"):
            return saved, False
        # A queued prediction has one outcome, not one row per conflicting label.
        identity = json.dumps([org_id, vehicle_id, saved["queuedAt"]])
        identifier = "review_" + hashlib.sha256(identity.encode()).hexdigest()
        evidence = json_safe({"source": "production_review_not_oof", "review": saved})
        inserted = await conn.fetchval('''INSERT INTO "FeedbackLog"(id,"orgId","vehicleId",outcome,features,"createdAt")
            VALUES($1,$2,$3,$4,$5::jsonb,now()) ON CONFLICT(id) DO NOTHING RETURNING id''',
            identifier, org_id, vehicle_id, outcome, json.dumps(evidence, allow_nan=False))
        return (None, True) if inserted else (saved, False)

    return await mutate_field(pool, vehicle_id, org_id, "reviewCandidate", transform)
