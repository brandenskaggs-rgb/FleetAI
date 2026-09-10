"""Restart-safe, tenant-scoped candidate scheduling. Never promotes a model."""
import asyncio
import hashlib
from .artifact_registry import configured_registry
from .stage2 import retrain_stage2_from_feedback


async def run_due_retraining(db):
    registry = configured_registry()
    if registry is None or not db.is_available():
        return {"status": "disabled_without_persistent_registry_or_database"}
    results = []
    for org_id in await db.feedback_organizations():
        name = "stage2:" + hashlib.sha256(org_id.encode()).hexdigest()
        token = registry.claim(name)
        if token is None:
            continue
        try:
            trained = await retrain_stage2_from_feedback(db, org_id)
            result = "candidate_created" if trained else "no_eligible_oof_outcomes"
            registry.finish(name, token, result)
            results.append(result)
        except Exception:
            registry.finish(name, token, "failed_retry_pending", interval_seconds=3600)
            raise
    return {"status": "checked", "results": results}
