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
    if not is_available():
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
                VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())
                ON CONFLICT ("vehicleId","metricKey","windowDays") DO UPDATE SET
                    "orgId"=EXCLUDED."orgId",
                    "mean"=EXCLUDED."mean",
                    "stdDev"=EXCLUDED."stdDev",
                    "min"=LEAST("Baseline"."min", EXCLUDED."min"),
                    "max"=GREATEST("Baseline"."max", EXCLUDED."max"),
                    "p10"=COALESCE(EXCLUDED."p10","Baseline"."p10"),
                    "p50"=COALESCE(EXCLUDED."p50","Baseline"."p50"),
                    "p90"=COALESCE(EXCLUDED."p90","Baseline"."p90"),
                    "sampleCount"=EXCLUDED."sampleCount",
                    "lastComputedAt"=now()
                """,
                org_id, vehicle_id, metric_key, window_days,
                mean, std_dev, min_val, max_val,
                p10, p50, p90, count,
            )
    except Exception as exc:
        logger.debug(f"[pg] upsert_baseline error: {exc}")


async def get_baselines_for_vehicle(vehicle_id: str) -> list[dict]:
    """Return all persisted baselines for a vehicle."""
    if not is_available():
        return []
    try:
        async with _pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT "metricKey","windowDays","mean","stdDev",
                       "min","max","p10","p50","p90","sampleCount","lastComputedAt"
                FROM "Baseline"
                WHERE "vehicleId"=$1
                """,
                vehicle_id,
            )
        return [dict(r) for r in rows]
    except Exception as exc:
        logger.debug(f"[pg] get_baselines error: {exc}")
        return []


async def get_fleet_baselines(metric_key: str, vehicle_class: Optional[str] = None) -> dict:
    """
    Returns fleet-wide mean/std for a metric across all vehicles.
    Used for cross-fleet normalization.
    """
    if not is_available():
        return {}
    try:
        async with _pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                SELECT AVG("mean") as fleet_mean,
                       STDDEV("mean") as fleet_std,
                       COUNT(*) as vehicle_count
                FROM "Baseline"
                WHERE "metricKey"=$1 AND "windowDays"=14 AND "mean" IS NOT NULL
                """,
                metric_key,
            )
        if not row or not row["fleet_mean"]:
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

async def get_model_state(vehicle_id: str) -> Optional[dict]:
    """Fetch the persisted model state JSON for a vehicle."""
    if not is_available():
        return None
    try:
        async with _pool.acquire() as conn:
            row = await conn.fetchrow(
                'SELECT "state" FROM "ModelState" WHERE "vehicleId"=$1',
                vehicle_id,
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
    if not is_available():
        return
    try:
        async with _pool.acquire() as conn:
            # Check if Vehicle row exists first (FK constraint)
            exists = await conn.fetchval(
                'SELECT 1 FROM "Vehicle" WHERE "vehicleId"=$1', vehicle_id
            )
            if not exists:
                return
            await conn.execute(
                """
                INSERT INTO "ModelState" ("vehicleId","orgId","state","updatedAt")
                VALUES ($1,$2,$3::jsonb,now())
                ON CONFLICT ("vehicleId") DO UPDATE SET
                    "orgId"=EXCLUDED."orgId",
                    "state"=EXCLUDED."state",
                    "updatedAt"=now()
                """,
                vehicle_id, org_id, json.dumps(state),
            )
    except Exception as exc:
        logger.debug(f"[pg] upsert_model_state error: {exc}")


# ── Recent telemetry samples ──────────────────────────────────────────────────

async def get_recent_samples(vehicle_id: str, limit: int = 5000) -> list[dict]:
    """Fetch recent TelemetrySample rows from PostgreSQL."""
    if not is_available():
        return []
    try:
        async with _pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT "ts","metrics","orgId"
                FROM "TelemetrySample"
                WHERE "vehicleId"=$1
                ORDER BY "ts" DESC
                LIMIT $2
                """,
                vehicle_id, limit,
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
            })
        return list(reversed(result))  # oldest first
    except Exception as exc:
        logger.debug(f"[pg] get_recent_samples error: {exc}")
        return []


# ── Maintenance logs for RF training ─────────────────────────────────────────

async def get_maintenance_logs(vehicle_id: str) -> list[dict]:
    """Fetch maintenance logs for training label extraction."""
    if not is_available():
        return []
    try:
        async with _pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT "serviceType","maintenanceType","performedAt","odometerMiles","notes"
                FROM "MaintenanceLog"
                WHERE "vehicleId"=$1 AND "performedAt" IS NOT NULL
                ORDER BY "performedAt" ASC
                """,
                vehicle_id,
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


async def get_all_baselines() -> dict:
    """Return all Welford baseline stats grouped by vehicleId and metricKey."""
    if not is_available():
        return {}
    try:
        async with _pool.acquire() as conn:
            rows = await conn.fetch(
                'SELECT "vehicleId","metricKey","mean","stdDev","sampleCount" FROM "Baseline"'
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
    if not is_available():
        return
    try:
        patch = json.dumps({"_activation": {"activated_at": activated_at, "learning_days": learning_days}})
        async with _pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO "ModelState" ("vehicleId","orgId","state","updatedAt")
                VALUES ($1,$2,$3::jsonb,now())
                ON CONFLICT ("vehicleId") DO UPDATE SET
                    "orgId"=EXCLUDED."orgId",
                    "state"="ModelState"."state" || $3::jsonb,
                    "updatedAt"=now()
                """,
                vehicle_id, org_id, patch,
            )
    except Exception as exc:
        logger.debug(f"[pg] upsert_vehicle_activation error: {exc}")


async def get_all_vehicle_activations() -> dict:
    """Load vehicle activations from ModelState._activation."""
    if not is_available():
        return {}
    try:
        async with _pool.acquire() as conn:
            rows = await conn.fetch(
                """SELECT "vehicleId","state" FROM "ModelState" WHERE "state" ? '_activation'"""
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


async def get_feedback_for_training(limit: int = 10000) -> list[dict]:
    """Return FeedbackLog rows with features for Stage 2 retraining."""
    if not is_available():
        return []
    try:
        async with _pool.acquire() as conn:
            rows = await conn.fetch(
                """SELECT "vehicleId", "outcome", "features", "stage1Score", "stage2Score", "signalAgreement"
                   FROM "FeedbackLog"
                   WHERE "outcome" IN ('confirmed_breakdown','false_positive','no_event')
                   ORDER BY "createdAt" DESC
                   LIMIT $1""",
                limit,
            )
        result = []
        for row in rows:
            feats = row["features"]
            if isinstance(feats, str):
                feats = json.loads(feats)
            result.append({
                "vehicleId": row["vehicleId"],
                "outcome": row["outcome"],
                "features": feats or {},
                "stage1Score": float(row["stage1Score"]) if row["stage1Score"] is not None else None,
                "stage2Score": float(row["stage2Score"]) if row["stage2Score"] is not None else None,
                "signalAgreement": float(row["signalAgreement"]) if row["signalAgreement"] is not None else None,
            })
        return result
    except Exception as exc:
        logger.debug(f"[pg] get_feedback_for_training error: {exc}")
        return []
