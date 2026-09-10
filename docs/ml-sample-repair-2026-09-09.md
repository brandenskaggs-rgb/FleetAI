# Telemetry quality and learning follow-up

Date: 2026-09-09

## Status

The stored-sample corrections below were applied to the authorized vehicle in
Railway PostgreSQL. Application changes are local, tested, and NOT deployed.
No commit, push, model promotion, or driver-tablet change was performed in this
pass. Existing unrelated working-tree changes were preserved.

## Production sample repair

| Check | Result |
| --- | ---: |
| Rows inspected | 17,210 |
| Explicit fuel-pressure unit aliases added | 6,131 |
| Invalid zero-voltage values changed to missing | 302 |
| Distinct records corrected | 6,179 |
| Records deleted | 0 |
| Records remaining | 17,210 |

Some corrections overlap on the same record. The original full records are
retained in database-local recovery tables; raw device evidence was not changed.
RPM=0 and speed=0 were preserved because these can be genuine observations.
Repeated timestamps were NOT sufficient grounds to delete anything: the apparent
duplicates had differences in raw evidence, counters, or attribution.

Fuel pressure is retained in kPa for the existing Node/dashboard contract, with
an explicit `fuelPressureKpa` alias. Python model features convert it to psi.
For example, 336 kPa is approximately 48.73 psi, not 336 psi. This corrects a unit
ambiguity; it does not prove that every earlier prediction used that sensor.
Tire pressure remains kPa, matching the simulation's actual units.

Batch: `9b059988-4628-4419-b77f-22fa46e3b9ae`

Recovery tables: `_FleetTelemetryRepairBatch`, `_FleetTelemetryRepairRow`.
These contain original telemetry and must receive the same access controls,
backups, and retention review as the source table.

Dry-run verification (no database writes):

```powershell
node scripts/repair-telemetry-quality.js --railway --unit "Chevy Camro"
```

Verified after repair: no further matching corrections were needed.

Operator rollback, only if a rollback is actually required:

```powershell
node scripts/repair-telemetry-quality.js --railway --rollback 9b059988-4628-4419-b77f-22fa46e3b9ae --apply
```

Rollback rejects records changed since the repair instead of overwriting newer
work. It does not rewind model state or historical prediction records.

## Application fixes

1. **Pressure units and missing values.** Explicit unit aliases take precedence.
   A null alias stays missing; stale raw data cannot revive it. Legacy kPa values
   are converted only when their raw provenance agrees. Historical database
   queries now retain that provenance.
2. **Frame coalescing.** Frames are merged in actual event-time order, with UTC
   handling and tenant/vehicle boundaries. Pressure units are resolved before
   raw provenance is merged. Invalid timestamps are excluded, not fabricated.
3. **Delayed-upload learning.** A versioned observation ledger replaces the
   event-time-only cursor for database-backed Welford updates. Each sensor can
   contribute once per five-second bucket. A newer correction replaces that
   contribution using inverse Welford arithmetic rather than adding a duplicate.
4. **Restart and worker safety.** Ledger contributions, running statistics, and
   checkpoints commit together under a vehicle/tenant advisory lock. Node saves
   cannot overwrite Python-owned fields from a stale combined state snapshot.
5. **Bounded history reconciliation.** Initial catch-up reads up to 3,000 arrival-
   ordered records per prediction, plus a bounded overlap. Initial partial
   history is not used as a representative Welford baseline. A durable daily
   rescan catches database commits older than the overlap. Existing pre-repair
   Welford state is archived before the new ledger starts.
6. **Stage 3 persistence.** Bounded, versioned temporal buffers now live in the
   existing ModelState record. Database-backed evaluations restore and save
   under the same tenant/vehicle lock. A persistence failure is reported as
   unavailable rather than silently clearing the temporal evidence.
7. **Human-review persistence.** Pending review candidates are database-backed.
   A human outcome and removal of its review item commit atomically. Failed or
   conflicting saves leave the review pending. Labels remain explicitly
   production-review evidence, NOT out-of-fold training evidence.
8. **Honest status.** The status endpoint reports the actual sample count and UTC
   date range instead of treating a one-row existence check as the total count.
   Learning mode, backfill state, and persistence availability are exposed.

## Files changed in this follow-up

- `server/ml.js`: explicit pressure unit provenance on newly stored samples.
- `server/db.js`: ownership of Python state fields during Node JSONB merges.
- `backend/app/ml/features.py`: units, missingness, deterministic scoped merging.
- `backend/app/ml/feature_contract.py`: corrected tire-pressure unit metadata.
- `backend/app/ml/learning_history.py`: durable Welford observation reconciliation.
- `backend/app/ml/runtime_state.py`: transactional temporal/review persistence.
- `backend/app/ml/stage3.py`: scoped temporal-history serialization/restoration.
- `backend/app/db/pg.py`: raw provenance, UTC lag lookup, count/status queries,
  learning/review/temporal database entry points.
- `backend/app/routes/predict.py`: persistence wiring, safe degraded states,
  authoritative database review endpoints, and prediction lineage.
- `prisma/schema.prisma`: observation ledger model and arrival-order index.
- `prisma/migrations/20260909195000_ml_learning_observations/migration.sql`:
  additive ledger table and telemetry index.
- `scripts/repair-telemetry-quality.js`: scoped dry-run/apply/rollback utility.
- `tests/telemetry-quality-repair.test.js`: safe repair and unit regressions.
- `tests/ml-database-scope.test.js`: Node/Python state ownership regression.
- `backend/tests/test_learning_history.py`: units, ordering, replay, transactions,
  tenant boundaries, restart recovery, review atomicity, and status counts.

The earlier architecture hardening is documented separately in
`docs/ml-hardening-2026-09-09.md`; those changes are not all new in this pass.

## Verification

- Python: 220 passed, with the opt-in PostgreSQL integration test skipped in the
  offline suite. That integration test was then run explicitly and passed
  (10 tests passed in its targeted file, including overlapping offline tests).
- Installed the repository-pinned OpenAI test dependency in a temporary,
  out-of-repository directory so the Advisor fallback tests could run too.
  No project requirements or runtime dependency versions were changed here.
- PostgreSQL integration used ONLY temporary tables with synthetic fixtures and
  rolled back the outer transaction. It did not read customer samples, alter
  production model records, or apply the new migration.
- Covered: late uploads, overlapping pages, repeated frames, revised readings,
  daily reconciliation, cross-tenant rejection, transactional rollback,
  Stage 3 restoration, review retrieval, conflicting labels, and failed labels.
- Node: 16 top-level targeted tests passed, including the telemetry-chain
  script's 48 assertions plus charging, shutdown, J1939, ingestion, coordinator,
  lineage, state-ownership, and repair checks.
- `npm.cmd run launch:check` passed.
- `node --check server.js` and repair-script syntax check passed.
- Prisma schema validation passed. `git diff --check` passed, with existing
  LF/CRLF conversion warnings only.

## Deployment requirements

1. Review the existing dirty branch and unrelated staged Railway changes first.
   This task did not publish any of them.
2. Deploy the Node changes and the additive Prisma migration first. The existing
   `npm start` includes `prisma migrate deploy`. The new migration has NOT been
   applied to production by this task. Review index-build lock impact for the
   deployment window.
3. Deploy THEOREM afterward, using the same existing PostgreSQL connection.
   No new API key or database credential is required. Deploying Python before
   the ledger exists pauses Welford learning and reports the migration/database
   issue; other ensemble signals remain available.
4. Verify `learningHistory.mode=durable_observation_ledger`, allow the bounded
   backfill to finish, and inspect per-sensor counts and units before interpreting
   a changed baseline as a mechanical finding.
5. Verify Stage 3/review persistence and tenant isolation on the deployed version.
   The observation ledger is PostgreSQL-backed, not an ephemeral Railway file.
6. Do not promote an old-schema candidate blindly. Tire-pressure metadata changes
   the schema fingerprint; canonical candidates require evaluation against the
   corrected schema. Existing model files and datasets were not deleted.

## Remaining limitations and evidence requirements

- No new supervised model was trained or promoted in this follow-up. Full
  RF/HGB evaluation and real upstream out-of-fold Stage 2 training remain
  separate candidate workflows. The car's unlabeled telemetry cannot establish
  failure precision, recall, calibrated breakdown probabilities, or lead time.
- Model features and Isolation Forest training still use bounded recent raw
  history. The durable Welford ledger covers retained history, but it does not
  magically make every inference window a fully populated 7/30-day window.
  Missing temporal evidence must remain missing.
- Ledger learning conservatively requires running-RPM evidence in the frame
  itself. Complementary RPM-missing frames may be used in feature extraction
  when neighboring evidence supports them, but are not used to inflate durable
  baseline counts. This makes learning independent of page boundaries.
- An arbitrarily late database transaction older than the overlap is recovered
  by the next full rescan, not necessarily the very next prediction. Catch-up
  advances on prediction calls; an inactive vehicle does not run a background
  backfill on its own.
- Null corrections do not erase another previously valid bucket observation.
  Bulk invalidation of earlier evidence requires a reviewed ledger-version
  rebuild, not arbitrary subtraction or deletion of historical rows.
- Isolation Forest caches remain worker-local; independently trained per-vehicle
  IF models are not synchronized live between workers. Persisted loading and
  eligibility checks remain intact.
- The new ledger and recovery copies add storage. Monitor PostgreSQL size and
  plan retention without discarding evidence needed for validation.
- Temp-table tests prove transaction behavior, not fleet-scale performance or
  multi-process load capacity. A controlled deployed smoke is still required.
- No claim of improved field accuracy, guaranteed breakdown prediction, or
  mechanical safety is made from these repairs.
