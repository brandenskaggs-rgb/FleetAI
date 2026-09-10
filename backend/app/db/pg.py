"""
PostgreSQL persistence layer for the Fleet AI ML service.
Uses asyncpg for async access to the same Railway PostgreSQL instance
that the Node.js server (Prisma) writes to.

Gracefully degrades to in-memory-only mode when DATABASE_URL is not set.
"""
import os
import json
import logging
from datetime import datetime, timezone
from typing import Any, Optional
from math import sqrt

import asyncpg

logger = logging.getLogger(__name__)

_pool: Optional[asyncpg.Pool] = None
_db_available = False


def _parse_database_url(url: str) -> str:
    """Convert postgresql:// to postgres:// for asyncpg compatibility."""
    if url.startswith("postgresql://"):
        return "postgres://" + url[len("postgresql://"):]
    return url


async def init_pool() -> None:
    global _pool, _db_available
    url = os.getenv("DATABASE_URL", "")
    if not url:
        logger.warning("[pg] DATABASE_URL not set — ML baselines will be in-memory only")
        return
    try:
        _pool = await asyncpg.create_pool(
            dsn=_parse_database_url(url),
            min_size=2,
            max_size=10,
            command_timeout=10,
            statement_cache_size=0,  # Railway PgBouncer compatibility
        )
        _db_available = True
        logger.info("[pg] Connection pool ready")
    except Exception as exc:
        logger.warning(f"[pg] Could not connect — running in-memory mode: {exc}")
        _pool = None
        _db_available = False


async def close_pool() -> None:
    global _pool, _db_available
    if _pool:
        await _pool.close()
        _pool = None
    _db_available = False


def is_available() -> bool:
    return _db_available and _pool is not None


# ── Welford baseline persistence ──────────────────────────────────────────────

async def upsert_baseline(
    vehicle_id: str,
    org_id: Optional[str],
    metric_key: str,
    window_days: int,
    count: int,
    mean: Optional[float],
    m2: Optional[float],  # Welford M2 accumulator
    min_val: Optional[float],
    max_val: Optional[float],
    samples_list: Optional[list] = None,  # used to compute percentiles
) -> None:
    """Persist Welford running stats for a metric to the Baseline table."""
    if not is_available() or not org_id:
        return
    std_dev = None
    if m2 is not None and count > 1:
        std_dev = sqrt(m2 / (count - 1))

    # Compute percentiles from recent samples if provided
    p10 = p50 = p90 = None
    if samples_list and len(samples_list) >= 10:
        sorted_vals = sorted(samples_list)
        n = len(sorted_vals)
        p10 = sorted_vals[int(n * 0.10)]
        p50 = sorted_vals[int(n * 0.50)]
        p90 = sorted_vals[int(n * 0.90)]

    try:
        async with _pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO "Baseline"
                    ("id","orgId","vehicleId","metricKey","windowDays",
                     "mean","stdDev","min","max","p10","p50","p90",
                     "sampleCount","lastComputedAt")
                SELECT gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now()
                WHERE EXISTS (SELECT 1 FROM "Vehicle" WHERE "vehicleId"=$2 AND "orgId"=$1)
                ON CONFLICT ("vehicleId","metricKey","windowDays") DO UPDATE SET
                    "orgId"=EXCLUDED."orgId",
                    "mean"=EXCLUDED."mean",
                    "stdDev"=EXCLUDED."stdDev",
                    "min"=EXCLUDED."min",
                    "max"=EXCLUDED."max",
                    "p10"=COALESCE(EXCLUDED."p10","Baseline"."p10"),
                    "p50"=COALESCE(EXCLUDED."p50","Baseline"."p50"),
                    "p90"=COALESCE(EXCLUDED."p90","Baseline"."p90"),
                    "sampleCount"=EXCLUDED."sampleCount",
                    "lastComputedAt"=now()
                WHERE "Baseline"."orgId"=EXCLUDED."orgId"
                """,
                org_id, vehicle_id, metric_key, window_days,
                mean, std_dev, min_val, max_val,
                p10, p50, p90, count,
            )
    except Exception as exc:
        logger.debug(f"[pg] upsert_baseline error: {exc}")


async def get_baselines_for_vehicle(vehicle_id: str, org_id: Optional[str] = None) -> list[dict]:
    """Return all persisted baselines for a vehicle."""
    if not is_available() or not org_id:
        return []
    try:
        async with _pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT "metricKey","windowDays","mean","stdDev",
                       "min","max","p10","p50","p90","sampleCount","lastComputedAt"
                FROM "Baseline"
                WHERE "vehicleId"=$1 AND "orgId"=$2
                """,
                vehicle_id, org_id,
            )
        return [dict(r) for r in rows]
    except Exception as exc:
        logger.debug(f"[pg] get_baselines error: {exc}")
        return []


async def get_fleet_baselines(metric_key: str, vehicle_class: Optional[str] = None,
                             org_id: Optional[str] = None, vehicle_id: Optional[str] = None) -> dict:
    """
    Returns fleet-wide mean/std for a metric across all vehicles.
    Used only for same-tenant, same-known-type peer normalization.
    """
    if not is_available() or not org_id or not vehicle_id:
        return {}
    try:
        async with _pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                SELECT AVG(b."mean") as fleet_mean,
                       STDDEV(b."mean") as fleet_std,
                       COUNT(*) as vehicle_count
                FROM "Baseline" b
                JOIN "Vehicle" peer ON peer."vehicleId"=b."vehicleId" AND peer."orgId"=b."orgId"
                JOIN "Vehicle" target ON target."vehicleId"=$3 AND target."orgId"=$2
                WHERE b."metricKey"=$1 AND b."windowDays"=14 AND b."mean" IS NOT NULL
                  AND b."orgId"=$2 AND b."vehicleId"<>$3
                  AND NULLIF(LOWER(TRIM(target."type")), '') IS NOT NULL
                  AND LOWER(TRIM(peer."type"))=LOWER(TRIM(target."type"))
                  AND ($4::text IS NULL OR LOWER(TRIM(peer."type"))=LOWER($4))
                  AND b."lastComputedAt">now()-interval '14 days'
                """,
                metric_key, org_id, vehicle_id, vehicle_class or None,
            )
        if not row or row["fleet_mean"] is None or row["vehicle_count"] < 2:
            return {}
        return {
            "fleet_mean": float(row["fleet_mean"]),
            "fleet_std": float(row["fleet_std"] or 0),
            "vehicle_count": int(row["vehicle_count"]),
        }
    except Exception as exc:
        logger.debug(f"[pg] get_fleet_baselines error: {exc}")
        return {}


# ── ModelState persistence (stores IF model + Welford state) ─────────────────

async def get_model_state(vehicle_id: str, org_id: Optional[str] = None) -> Optional[dict]:
    """Fetch the persisted model state JSON for a vehicle."""
    if not is_available() or not org_id:
        return None
    try:
        async with _pool.acquire() as conn:
            row = await conn.fetchrow(
                'SELECT m."state" FROM "ModelState" m JOIN "Vehicle" v ON v."vehicleId"=m."vehicleId" AND v."orgId"=m."orgId" WHERE m."vehicleId"=$1 AND m."orgId"=$2',
                vehicle_id, org_id,
            )
        if row:
            state = row["state"]
            return state if isinstance(state, dict) else json.loads(state)
        return None
    except Exception as exc:
        logger.debug(f"[pg] get_model_state error: {exc}")
        return None


async def upsert_model_state(vehicle_id: str, org_id: Optional[str], state: dict) -> None:
    """Persist or update the model state JSON for a vehicle."""
    if not is_available() or not org_id:
        return
    try:
        async with _pool.acquire() as conn:
            # Check if Vehicle row exists first (FK constraint)
            exists = await conn.fetchval(
                'SELECT 1 FROM "Vehicle" WHERE "vehicleId"=$1 AND "orgId"=$2', vehicle_id, org_id
            )
            if not exists:
                return
            await conn.execute(
                """
                INSERT INTO "ModelState" ("vehicleId","orgId","state","updatedAt")
                VALUES ($1,$2,$3::jsonb,now())
                ON CONFLICT ("vehicleId") DO UPDATE SET
                    "orgId"=EXCLUDED."orgId",
                    "state"=COALESCE("ModelState"."state", '{}'::jsonb) || EXCLUDED."state",
                    "updatedAt"=now()
                WHERE "ModelState"."orgId"=EXCLUDED."orgId"
                """,
                vehicle_id, org_id, json.dumps(state),
            )
    except Exception as exc:
        logger.debug(f"[pg] upsert_model_state error: {exc}")


# ── Recent telemetry samples ──────────────────────────────────────────────────

async def get_recent_samples(vehicle_id: str, org_id: str | None, limit: int = 5000) -> list[dict]:
    """Fetch tenant-scoped recent TelemetrySample rows from PostgreSQL."""
    if not is_available() or not vehicle_id or not org_id:
        return []
    try:
        async with _pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT "ts","metrics","raw","orgId"
                FROM "TelemetrySample"
                WHERE "vehicleId"=$1 AND "orgId"=$2
                ORDER BY "ts" DESC
                LIMIT $3
                """,
                vehicle_id, org_id, limit,
            )
        result = []
        for r in rows:
            metrics = r["metrics"]
            if isinstance(metrics, str):
                metrics = json.loads(metrics)
            result.append({
                "vehicleId": vehicle_id,
                "ts": r["ts"].isoformat() if hasattr(r["ts"], "isoformat") else str(r["ts"]),
                "orgId": r["orgId"],
                "metrics": metrics,
                "raw": json.loads(r["raw"]) if isinstance(r.get("raw"), str) else r.get("raw"),
            })
        return list(reversed(result))  # oldest first
    except Exception as exc:
        logger.debug(f"[pg] get_recent_samples error: {exc}")
        return []


# ── Maintenance logs for RF training ─────────────────────────────────────────

async def get_lag_samples(vehicle_id: str, org_id: str, reference_time) -> list[dict]:
    """Fetch an observed 30-day anchor without scanning a month of raw frames."""
    if not is_available() or not org_id or reference_time is None:
        return []
    try:
        async with _pool.acquire() as conn:
            row = await conn.fetchrow('''
                SELECT "ts","metrics","raw" FROM "TelemetrySample"
                WHERE "vehicleId"=$1 AND "orgId"=$2
                  AND "ts">=($3::timestamptz AT TIME ZONE 'UTC')-interval '31 days'
                  AND "ts"<=($3::timestamptz AT TIME ZONE 'UTC')-interval '30 days'
                ORDER BY "ts" DESC LIMIT 1
            ''', vehicle_id, org_id, reference_time, timeout=3)
        if row is None:
            return []
        values = row["metrics"] if isinstance(row["metrics"], dict) else json.loads(row["metrics"])
        raw = json.loads(row["raw"]) if isinstance(row.get("raw"), str) else row.get("raw")
        return [{"vehicleId": vehicle_id, "orgId": org_id, "ts": row["ts"].isoformat(), "metrics": values, "raw": raw}]
    except Exception as exc:
        logger.debug("[pg] lag observation unavailable: %s", type(exc).__name__)
        return []

async def reconcile_vehicle_learning(vehicle_id: str, org_id: str) -> dict:
    """Transactional learning; caller must surface failures and freeze updates."""
    if not is_available():
        raise RuntimeError("Learning database unavailable")
    from ..ml.learning_history import reconcile
    return await reconcile(_pool, vehicle_id, org_id)


async def get_telemetry_coverage(vehicle_id: str, org_id: str):
    if not is_available() or not org_id or not vehicle_id:
        return None
    try:
        async with _pool.acquire() as conn:
            row = await conn.fetchrow('''SELECT count(*) AS count, min(ts) AS first, max(ts) AS last
                FROM "TelemetrySample" WHERE "vehicleId"=$1 AND "orgId"=$2''', vehicle_id, org_id, timeout=3)
        return {"dbSampleCount": row["count"],
                "firstEventUtc": row["first"].isoformat() + "Z" if row["first"] else None,
                "lastEventUtc": row["last"].isoformat() + "Z" if row["last"] else None}
    except Exception as exc:
        logger.warning("[pg] telemetry coverage unavailable (%s)", type(exc).__name__)
        return None

async def get_maintenance_logs(vehicle_id: str, org_id: Optional[str] = None) -> list[dict]:
    """Fetch maintenance logs for training label extraction."""
    if not is_available() or not org_id:
        return []
    try:
        async with _pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT "serviceType","maintenanceType","performedAt","odometerMiles","notes"
                FROM "MaintenanceLog"
                WHERE "vehicleId"=$1 AND "orgId"=$2 AND "performedAt" IS NOT NULL
                ORDER BY "performedAt" ASC
                """,
                vehicle_id, org_id,
            )
        return [dict(r) for r in rows]
    except Exception as exc:
        logger.debug(f"[pg] get_maintenance_logs error: {exc}")
        return []


# ── MlBaselineProfile (pretrained fleet priors) ───────────────────────────────

async def get_baseline_profile(profile_key: str) -> Optional[dict]:
    if not is_available():
        return None
    try:
        async with _pool.acquire() as conn:
            row = await conn.fetchrow(
                'SELECT "profileJson","modelVersion","trainingSource" FROM "MlBaselineProfile" WHERE "profileKey"=$1',
                profile_key,
            )
        if row:
            profile_json = row["profileJson"]
            if isinstance(profile_json, str):
                profile_json = json.loads(profile_json)
            return {
                "profileKey": profile_key,
                "profileJson": profile_json,
                "modelVersion": row["modelVersion"],
                "trainingSource": row["trainingSource"],
            }
        return None
    except Exception as exc:
        logger.debug(f"[pg] get_baseline_profile error: {exc}")
        return None


async def get_all_baselines(org_id: Optional[str] = None) -> dict:
    """Return all Welford baseline stats grouped by vehicleId and metricKey."""
    if not is_available() or not org_id:
        return {}
    try:
        async with _pool.acquire() as conn:
            rows = await conn.fetch(
                'SELECT "vehicleId","metricKey","mean","stdDev","sampleCount" FROM "Baseline" WHERE "orgId"=$1 AND "windowDays"=14', org_id
            )
        result: dict = {}
        for r in rows:
            vid = r["vehicleId"]
            metric = r["metricKey"]
            count = int(r["sampleCount"])
            mean = float(r["mean"]) if r["mean"] is not None else 0.0
            std_dev = float(r["stdDev"]) if r["stdDev"] is not None else 0.0
            # Reconstruct Welford M2 from std_dev and count
            m2 = (std_dev ** 2) * (count - 1) if count > 1 else 0.0
            result.setdefault(vid, {})[metric] = {"count": count, "mean": mean, "m2": m2}
        return result
    except Exception as exc:
        logger.debug(f"[pg] get_all_baselines error: {exc}")
        return {}


async def upsert_vehicle_activation(vehicle_id: str, org_id: Optional[str], activated_at: str, learning_days: int) -> None:
    """Persist vehicle activation state in ModelState._activation JSONB."""
    if not is_available() or not org_id:
        return
    try:
        patch = json.dumps({"_activation": {"activated_at": activated_at, "learning_days": learning_days}})
        async with _pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO "ModelState" ("vehicleId","orgId","state","updatedAt")
                SELECT $1,$2,$3::jsonb,now()
                WHERE EXISTS (SELECT 1 FROM "Vehicle" WHERE "vehicleId"=$1 AND "orgId"=$2)
                ON CONFLICT ("vehicleId") DO UPDATE SET
                    "orgId"=EXCLUDED."orgId",
                    "state"="ModelState"."state" || $3::jsonb,
                    "updatedAt"=now()
                WHERE "ModelState"."orgId"=EXCLUDED."orgId"
                """,
                vehicle_id, org_id, patch,
            )
    except Exception as exc:
        logger.debug(f"[pg] upsert_vehicle_activation error: {exc}")


async def get_all_vehicle_activations(org_id: Optional[str] = None) -> dict:
    """Load vehicle activations from ModelState._activation."""
    if not is_available() or not org_id:
        return {}
    try:
        async with _pool.acquire() as conn:
            rows = await conn.fetch(
                """SELECT "vehicleId","state" FROM "ModelState" WHERE "orgId"=$1 AND "state" ? '_activation'""", org_id
            )
        result: dict = {}
        for r in rows:
            state = r["state"]
            if isinstance(state, str):
                state = json.loads(state)
            act = (state or {}).get("_activation", {})
            if act and act.get("activated_at"):
                result[r["vehicleId"]] = {
                    "vehicle_id": r["vehicleId"],
                    "activated_at": act["activated_at"],
                    "learning_days": act.get("learning_days", 14),
                }
        return result
    except Exception as exc:
        logger.debug(f"[pg] get_all_vehicle_activations error: {exc}")
        return {}


async def feedback_organizations() -> list[str]:
    if not is_available():
        return []
    async with _pool.acquire() as conn:
        rows = await conn.fetch('SELECT DISTINCT "orgId" FROM "FeedbackLog" WHERE "orgId" IS NOT NULL')
    return [r["orgId"] for r in rows]


async def get_feedback_for_training(limit: int = 10000, org_id: Optional[str] = None) -> list[dict]:
    """Return FeedbackLog rows with features for Stage 2 retraining."""
    if not is_available() or not org_id:
        return []

    try:
        async with _pool.acquire() as conn:
            rows = await conn.fetch(
                """SELECT "vehicleId", "orgId", "outcome", "features", "stage1Score", "stage2Score", "signalAgreement"
                   FROM "FeedbackLog"
                   WHERE "orgId"=$2 AND "outcome" IN ('confirmed_breakdown','false_positive','confirmed_normal')
                   ORDER BY "createdAt" DESC
                   LIMIT $1""",
                limit, org_id,
            )
        result = []
        for row in rows:
            feats = row["features"]
            if isinstance(feats, str):
                feats = json.loads(feats)
            result.append({
                "orgId": row["orgId"],
                "vehicleId": row["vehicleId"],
                "outcome": row["outcome"],
                "features": feats or {},
                "stage1Score": float(row["stage1Score"]) if row["stage1Score"] is not None else None,
                "stage2Score": float(row["stage2Score"]) if row["stage2Score"] is not None else None,
                "signalAgreement": float(row["signalAgreement"]) if row["signalAgreement"] is not None else None,
            })
        return result
    except Exception as exc:
        logger.warning("[pg] Feedback retrieval failed; candidate scheduling must retry")
        raise


async def save_review_feedback(vehicle_id: str, org_id: str, outcome: str, candidate: dict) -> bool:
    """Outcome insert and removal from the durable queue commit together."""
    if not is_available() or not org_id:
        return False
    from ..ml.runtime_state import label_review
    return await label_review(_pool, vehicle_id, org_id, outcome, candidate)


async def evaluate_temporal_history(vehicle_id: str, org_id: str, **kwargs):
    from ..ml.runtime_state import temporal_evaluation
    if not is_available():
        raise RuntimeError("Temporal database unavailable")
    return await temporal_evaluation(_pool, vehicle_id, org_id, **kwargs)


async def persist_review_candidate(vehicle_id: str, org_id: str, candidate: dict):
    from ..ml.runtime_state import persist_review
    if not is_available():
        raise RuntimeError("Review database unavailable")
    return await persist_review(_pool, vehicle_id, org_id, candidate)


async def get_review_candidates(org_id: str, vehicle_id=None, limit=20):
    from ..ml.runtime_state import reviews
    if not is_available():
        raise RuntimeError("Review database unavailable")
    return await reviews(_pool, org_id, vehicle_id, limit)
