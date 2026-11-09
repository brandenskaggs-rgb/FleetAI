"""Operator worker: snapshot verified outcomes, build datasets, train candidates only.

Run as a separate Railway scheduled job with an explicit --org. No subprocess
training is launched by HTTP handlers, telemetry ingestion, or the Advisor.
"""
import asyncio
from datetime import datetime
from decimal import Decimal
import json
import os
from pathlib import Path
import subprocess
import uuid

from .artifact_registry import configured_registry
from .controlled_learning import build_dataset, train_candidate


def serialize(value):
    if isinstance(value, datetime):
        return value.isoformat() + ("Z" if value.tzinfo is None else "")
    if isinstance(value, Decimal):
        return float(value)
    raise TypeError(type(value).__name__)


async def run(args):
    import asyncpg
    registry = configured_registry()
    if registry is None:
        raise ValueError("FLEETAI_ML_ARTIFACT_DIR must point to a persistent volume")
    if not os.environ.get("DATABASE_URL"):
        raise ValueError("DATABASE_URL is required")
    scope = "tenant:" + args.org
    job = "controlled-learning:" + args.org + ":" + (args.component or "dataset")
    token = registry.claim(job, lease_seconds=6*3600)
    if not token:
        return {"status": "already_leased_or_not_due"}
    connection = None
    run_id = str(uuid.uuid4())
    summary = {}
    try:
        connection = await asyncpg.connect(os.environ["DATABASE_URL"], command_timeout=120)
        await connection.execute('''UPDATE "MlLearningRun" SET status='interrupted',"updatedAt"=now()
            WHERE "orgId"=$1 AND status='running' AND "updatedAt" < now()-interval '6 hours' ''', args.org)
        await connection.execute('''INSERT INTO "MlLearningRun"(id,"orgId",status,"updatedAt") VALUES($1,$2,'running',now())''', run_id, args.org)
        # A repeatable read snapshot prevents prediction/outcome drift during extraction.
        async with connection.transaction(isolation="repeatable_read", readonly=True):
            rows = await connection.fetch('''SELECT f.* FROM "FeedbackLog" f
                JOIN "Vehicle" v ON v."vehicleId"=f."vehicleId" AND v."orgId"=f."orgId"
                WHERE f."orgId"=$1 ORDER BY f.id LIMIT 10001''', args.org)
            if len(rows) > 10000:
                raise ValueError("Extraction exceeds 10000 outcomes; use a reviewed bounded dataset export")
            prediction_ids = list({r["predictionRunId"] for r in rows if r["predictionRunId"]})
            runs = await connection.fetch('''SELECT p.* FROM "MlPredictionRun" p
                JOIN "Vehicle" v ON v."vehicleId"=p."vehicleId" AND v."orgId"=p."orgId"
                WHERE p."orgId"=$1 AND p.id=ANY($2::text[])''', args.org, prediction_ids)
            telemetry_count = await connection.fetchval('SELECT COUNT(*) FROM "TelemetrySample" WHERE "orgId"=$1', args.org)
        def unpack(row, fields):
            result = dict(row)
            for field in fields:
                if isinstance(result.get(field), str):
                    result[field] = json.loads(result[field])
            return json.loads(json.dumps(result, default=serialize))
        outcomes = [unpack(r, ["outcomeEvidence", "features"]) for r in rows]
        predictions = [unpack(r, ["predictionJson"]) for r in runs]
        dataset_id, metadata, examples = await asyncio.to_thread(build_dataset, args.org, outcomes, predictions)
        registry.save_dataset(dataset_id, scope, metadata, examples)
        summary = {"datasetVersion": dataset_id, "telemetryRecords": telemetry_count, "dataset": metadata}
        if args.component:
            revision = os.environ.get("RAILWAY_GIT_COMMIT_SHA") or subprocess.check_output(
                ["git", "rev-parse", "HEAD"], cwd=Path(__file__).resolve().parents[3], text=True).strip()
            policy = json.loads(Path(args.gates).read_text()) if args.gates else None
            summary["training"] = await asyncio.to_thread(train_candidate, registry, dataset_id, args.org,
                args.component, git_version=revision, policy=policy)
        summary["registry"] = registry.overview(scope)
        await connection.execute('''UPDATE "MlLearningRun" SET status='completed',summary=$2::jsonb,"updatedAt"=now() WHERE id=$1 AND "orgId"=$3''',
            run_id, json.dumps(summary, allow_nan=False), args.org)
        registry.finish(job, token, "completed:" + dataset_id, interval_seconds=86400)
        return {"status": "completed", "runId": run_id, "datasetVersion": dataset_id,
                "examples": len(examples), "candidateId": summary.get("training", {}).get("candidateId"), "promoted": False}
    except Exception as error:
        # Don't persist database URLs, customer notes, or driver data in error strings.
        category = "insufficient_or_invalid_learning_evidence" if isinstance(error, ValueError) else "worker_failed"
        try:
            if connection:
                summary.update(error=category, errorType=type(error).__name__, registry=registry.overview(scope))
                await connection.execute('''UPDATE "MlLearningRun" SET status='failed',summary=$2::jsonb,"updatedAt"=now() WHERE id=$1 AND "orgId"=$3''',
                    run_id, json.dumps(summary, allow_nan=False), args.org)
        finally:
            registry.finish(job, token, category, interval_seconds=3600)
        raise
    finally:
        if connection:
            await connection.close()
