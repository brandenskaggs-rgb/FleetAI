# Controlled Fleet Learning

## Status and Boundaries

This change connects verified repair outcomes to recorded prediction features,
versioned datasets, evaluated candidates, and explicit promotion. It is not a
claim of improved field accuracy. No production data, artifacts, credentials,
tablet settings, pairing logic, or active model pointers were changed during
implementation. No live fleet training was performed.

Groq remains the configured conversational provider, with `openai/gpt-oss-120b`
as the code default. It explains fleet evidence and learning status. It does not
train the tree models, confirm mechanical failures, manufacture labels, or have
a model-promotion tool. No new LLM account or key is required for this pipeline.

The existing physics/THEOREM, RF/HGB prior, Isolation Forest, Welford, Stage 2
LightGBM, Stage 3, and Node fallback remain intact. New supervised component HGB
models use the same canonical physics/sensor feature schema. Their results are
**separate supporting evidence**, not added to the ensemble probability. Changing
ensemble weights requires a separate validation study and implementation review.

## Data Flow

1. Existing `TelemetrySample`, `MlPredictionRun`, and lineage storage remain the
   historical source. Raw telemetry is not copied into another telemetry table.
2. Python adds an observed training-window description to prediction lineage.
   Existing `pretrained.inputFeatures` retains the exact canonical inputs,
   missingness and physics assumptions used at prediction time.
3. Authorized users record outcome evidence through the existing
   `POST /api/telemetry/feedback` endpoint. Server session identity supplies
   reviewer and tenant; a supplied prediction must belong to that vehicle/fleet.
4. The worker uses a repeatable-read PostgreSQL snapshot. It builds immutable
   datasets from those recorded features, never recomputing history using today's
   vehicle settings or later repairs. Dataset manifests include exclusion counts,
   feature/physics version, label rule, prediction/outcome references, and hashes.
5. HGB trains only on the training partition. Vehicle-disjoint, chronological
   validation selects thresholds; calibration uses a separate subset if adequate.
   Labels entered after a partition's cutoff are purged. Final test outcomes cannot
   be reused for another candidate evaluation of the same tenant/model role.
6. Candidate and active component models are evaluated on the same untouched
   holdout. Candidates remain inactive until an operator promotes them.
7. Promoted component evidence is optionally available to Python predictions,
   preserved through Node lineage, and summarized for the Advisor.

The declared target is **confirmed failure within 14 days**, not time-to-failure.
Useful lead time is reported only for correctly flagged, confirmed events. There
is no fabricated distance/time countdown.

## Recording Outcomes

Use the existing authenticated feedback endpoint. Example shape (fictional IDs):

```json
{
  "vehicleId": "YOUR_VEHICLE_ID",
  "predictionRunId": "SAVED_PREDICTION_ID",
  "outcome": "confirmed_breakdown",
  "sourceReference": "REPAIR_SYSTEM:INVOICE_ID:COMPONENT",
  "outcomeEvidence": {
    "component": "charging",
    "source": "technician",
    "observedAt": "2026-09-14T15:00:00Z",
    "maintenanceType": "Alternator repair",
    "technicianNotes": "Record actual inspection and diagnostic findings here.",
    "repairNotes": "Record work actually performed here.",
    "confirmedFailure": true,
    "inspectedNormal": false,
    "severity": "high",
    "mileage": 125000,
    "cost": 450,
    "dtcs": []
  }
}
```

Components: charging, cooling, fuel, engine, emissions, drivetrain, brakes,
tires, bearings, sensor. Sources: technician, repair_invoice, inspection,
maintenance_integration. These are classifications, not proof all components
are observable on every vehicle.

- Positive: confirmed failure, trusted source classification, reviewer identity,
  inspection notes, a linked pre-event prediction and event within 14 days.
- Negative: explicit normal inspection plus `coverageStart` covering the entire
  prediction-to-14-day interval. An isolated normal inspection is insufficient.
- Scheduled replacements, `maintenance_only`, `no_event`, missing/contradictory
  evidence, stale windows, insufficient sensors and incompatible schemas do not
  become supervised labels.
- `sourceReference` is idempotent per tenant (duplicate submissions return 409).
  Repeated records of the same component/event are also deduplicated in datasets.
- Existing feedback remains readable; caller-supplied feature vectors are no
  longer accepted as OOF training evidence. A future integration must produce
  upstream OOF evidence through the existing trusted Python infrastructure.

## Storage and Deployment

Additive Prisma migration:
`20260915120000_controlled_learning/migration.sql`

- Adds `FeedbackLog.outcomeEvidence`, `sourceReference` and tenant indexes.
- Adds `MlLearningRun` for scoped job status/summary. No existing rows deleted.
- Run `npx prisma generate` during build and `npx prisma migrate deploy` before
  enabling this code. The repository's normal install/start already do these.
- Registry initialization adds `learning_datasets` and `evaluation_examples` to
  the existing registry SQLite database. Existing artifact/promotions/jobs stay.

Required configuration:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Existing PostgreSQL connection; never put it in CLI arguments |
| `FLEETAI_ML_ARTIFACT_DIR` | Absolute mounted persistent-volume path |
| `FLEETAI_CONTROLLED_LEARNING_TARGETS` | Explicit tenant/target opt-in JSON, default `{}` (off) |
| `FLEETAI_LEARNING_GATES_FILE` | Optional absolute path to operator-reviewed gate JSON |
| `FLEETAI_COMPONENT_EVIDENCE` | `true` to read promoted component artifacts in predictions; default off |
| `RAILWAY_GIT_COMMIT_SHA` | Deployed source revision; local CLI falls back to Git HEAD |

Example opt-in: `{"YOUR_ORG_ID":["cooling","charging"]}`. An empty target list
builds datasets only. No implicit cross-fleet training is enabled.

The existing ML-service scheduler invokes the worker asynchronously. Dataset
construction/training run off the request event loop. Registry leases survive
restart: 24-hour successful cadence, one-hour failed retry, six-hour crash lease.
The API never launches training. Run a single ML service instance with its volume;
do not assume two Railway services can share a volume. Operator CLI commands must
run where that same registry is mounted. Back up the registry with SQLite's backup
API or a consistent volume snapshot, not a live partial file copy. Restrict volume
access: artifacts and frozen feature datasets are sensitive customer evidence.

Resource limits and sufficient volume capacity remain deployment responsibilities.
Use a reviewed concurrency/CPU budget before enabling multiple fleet targets.

## Operator Commands

Run from repository root in the deployed environment, with the existing Python
dependencies and environment configuration. Commit reviewed training code before
creating release artifacts so the recorded Git revision describes that code.

```bash
# Snapshot/build only; no model fit or promotion
python scripts/ml-learning.py --org YOUR_ORG_ID

# Build dataset and evaluate a component candidate
python scripts/ml-learning.py --org YOUR_ORG_ID --component cooling

# Inspect manifests, evaluations and promotion history for one fleet
python scripts/ml-artifacts.py inspect --scope tenant:YOUR_ORG_ID

# Explicit approval; gates are enforced again, current baseline must match
python scripts/ml-artifacts.py promote --id CANDIDATE_ID --reason "Reviewed independent evaluation"

# Restore the previous active artifact, never delete the replaced one
python scripts/ml-artifacts.py rollback --slot component:cooling --scope tenant:YOUR_ORG_ID --reason "Rollback after operational review"
```

Component evidence reloads active artifacts on prediction when enabled. Existing
pretrained/Stage 2 loaders retain their documented restart/reload behavior. A stale
candidate comparison cannot replace a newer active version. Repeating promotion
of the already-active artifact is rejected to preserve meaningful rollback history.

## Evaluation and Observability

Metrics: precision, recall, F1, ROC-AUC, PR-AUC, FPR/FNR, confusion matrix,
Brier score, log loss, ECE, and confirmed-event lead time. Vehicle breakdowns are
included only with both classes and adequate observations. No cross-fleet metrics
or identifiable telemetry are sent between customers.

Default gates (engineering starting points, not validated fleet service levels):
30 test examples; at least five positives and five negatives; precision >= .50;
recall >= .60; FPR <= .20; Brier <= .30. Maximum recall and Brier regression versus
the active model: .02. Gate overrides are versioned in the evaluation report.
Missing metrics fail closed. Old evaluated artifacts without sufficient metrics or
an active-baseline comparison now require a new valid evaluation before promotion.
No requirement is relaxed to preserve a historical accuracy number.

The registry retains its existing vocabulary: candidate -> evaluated -> active ->
retired. Failed gates remain evaluated-but-ineligible, with explicit failure reasons.
Manual promotion is the only activation path; no LLM has that capability.

Employee console: **Service health -> Model learning -> Company**.
API: `GET /api/ml/learning?orgId=...` (authenticated, tenant scoped).
Advisor context includes compact worker status, dataset exclusions, outcome refs,
evaluation evidence and promoted component results. Admin registry snapshots are
explicitly labeled as of the last worker run; use the CLI for current pointers.

## Remaining Scientific and Operational Work

- A single car and unlabeled drive data are not enough for independently validated
  supervised failure models. The builder requires multiple vehicles, mature
  outcomes, both classes, and independent temporal partitions. It will refuse to fit
  when those conditions are not met.
- Existing old predictions without the new window evidence are excluded. Retained
  telemetry is not altered or retroactively relabeled. A separately reviewed replay
  process would be needed to recover eligible historical training windows.
- The component models do not replace Stage 2. Its existing actual-upstream OOF
  requirements remain; a full upstream fold-training adapter is future work.
- A human-entered confirmation is not independent mechanic adjudication. Establish
  maintenance-record review procedures and measure selection bias, missed failures
  without prior alerts, and class/hardware coverage before field performance claims.
- The first bootstrap has no active component comparator. It is not proof of
  improvement over the current multi-stage fleet ensemble.
- No Railway migration, production retraining, model promotion, or live DB smoke
  was performed in this local implementation. Verify those on an isolated staging
  fleet first. Back up persistent artifacts, test restart/retry, then enable one
  reviewed tenant. Pairing and the Android app need no update for these changes.
- Truck testing needs verified J1939 sensor mappings/units, actual maintenance
  outcomes and independent truck holdouts. Do not transfer passenger-car accuracy
  claims to semi trucks.

## Files

New: `backend/app/ml/controlled_learning.py`, `backend/app/ml/learning_worker.py`,
`scripts/ml-learning.py`, `server/services/learningEvidence.js`, the additive Prisma
migration, `backend/tests/test_controlled_learning.py`,
`tests/controlled-learning.test.js`, and this document.

Modified: registry/evaluation/retraining modules, Python prediction lineage,
`scripts/ml-artifacts.py`, Prisma schema, feedback routes, Advisor context/system
prompt/report evidence, environment template, employee console script/styles/cache version, ML hardening tests and employee
browser fixtures. No training datasets/model binaries are added to Git.

## Local Verification

- Python backend regression suite excluding the unrelated `test_ai_explain.py`:
  223 passed, one skipped. The excluded module could not collect because the local
  Python environment lacks `python-dotenv`. Local Python 3.14 tests used an isolated
  asyncpg 0.31 wheel; production's existing Python/dependency pins were not changed.
- New tests exercise confirmed labels, negative observation horizons, incompatible
  snapshots, missingness, tenant isolation, chronological partitions, holdout reuse,
  actual candidate fitting, gating/rollback, scoped inference, durable worker status,
  explicit scheduler opt-in and component failure fallback.
- Node learning/lineage/database-scope/prediction-coordinator checks: 14 passed.
  Existing security boundary checks: 18 passed. Advisor conversation/context/agent
  tests passed.
- Employee browser suite: 11 routes at 1920, 1440, 1024 and 390 pixels, including
  learning status, existing onboarding/access flows and mobile overflow checks.
- Prisma schema validation/client generation, `node --check server.js`,
  `npm run launch:check` and `git diff --check` passed.
- All training/evaluation test records are explicitly fabricated fixtures. Their
  metrics are not product accuracy or pilot performance measurements.
