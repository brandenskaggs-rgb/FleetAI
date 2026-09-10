# Fleet AI Predictive Maintenance Hardening

Date: September 9, 2026
Branch: `clean-auth-rebuild`
Status: Local implementation and regression verification. Not deployed or committed.

## Executive Summary

The existing architecture remains intact: Node orchestration and fallback scoring, Python inference, physics-derived estimates, Random Forest/HistGradientBoosting priors, per-vehicle Welford baselines and Isolation Forest, LightGBM confirmation, Stage 3 temporal analysis, and DTC evidence. No neural network or GPU framework was introduced.

This work corrects feature construction, data isolation, evaluation boundaries, feedback persistence, artifact handling, and prediction traceability. It does **not** establish field accuracy, a reliable breakdown countdown, or production deployment readiness by itself.

No live customer telemetry, database, Railway configuration, existing model file, or existing dataset was changed during this task. Existing unrelated frontend, tablet, authentication, and report edits in the working tree were preserved.

## Findings and Changes

### 1. Feature Contract and Missingness

- Added a canonical, ordered 93-feature pretrained contract and 29-feature Stage 2 contract, with units, event-time window semantics, schema hashes, implementation fingerprints, and physics version.
- Connected all ten trained `*_accel_h24` inputs to production feature extraction. Acceleration uses a quadratic fit against actual elapsed hours, not sample positions. At least six distinct observed timestamps are required.
- Added canonical training replay through the production pretrained input builder. Simulator-generated latent/proxy feature values no longer bypass that builder for the RF/HGB trainer.
- Missing measurements and unavailable temporal features remain NaN in model input and null in JSON evidence. The RF imputer is fitted on training data only and saved with missingness indicators. All-missing columns retain stable dimensions.
- Corrected explicit kPa pressure aliases to the internal psi contract. Physics assumptions remain separate from measured inputs and are reported in prediction evidence.
- New artifacts with incompatible feature definitions are rejected at loading/promotion. Existing unversioned artifacts remain explicitly labeled legacy and require revalidation; they have not been silently retrained or replaced.

**Before:** Some trained acceleration inputs were zero-filled or absent, and duplicated builders could disagree.
**After:** Active model schemas and input ordering are checked, missingness is visible, and training/inference parity is regression-tested across irregular timestamps.

### 2. Actual Time Windows

- Replaced 30-row differences with observed 30-day differences. The historical anchor must be at or before the 30-day boundary, within a 24-hour tolerance; insufficient history yields missing data.
- Replaced seven-row rolling statistics in the real-world trainer with seven-day timestamp windows and an initial seven-day history requirement.
- Added bounded, tenant-scoped historical-anchor retrieval for live inference. Older anchor samples contribute to deltas without being replayed into Welford learning.
- Added real timestamps to synthetic observations and changed multi-seed sampling to retain complete vehicle histories instead of disconnected rows.
- Canonical input construction no longer calls a recent-mean-minus-all-time-mean difference a 30-day change. Dependent battery state estimates remain missing without the needed evidence.

**Important:** The existing default daily simulation frequency cannot establish six observations within 24 hours. Such acceleration features correctly remain missing. Use `--observations-per-day 6` or higher for a separately budgeted temporal training study; inspect `trainingFeatureObservedCounts` before promotion. Increasing the frequency increases memory and training cost.

### 3. Independent Evaluation

- RF/HGB: vehicle-disjoint train, selection, calibration, and final test partitions; train-only RF imputation; no internal random HGB early stopping.
- Real-world HGB: organization-scoped, chronological and vehicle-disjoint partitions. Rows outside the assigned time/group blocks are purged. Outcomes must be confirmed and observable before their partition closes. Calibration observations cannot look beyond the calibration boundary.
- Stage 2: final test data is no longer used for early stopping. Selection, isotonic calibration, conformal calibration, and final test examples are separate. Vehicle groups remain disjoint when the source includes vehicle IDs.
- Shared reporting includes precision, recall, F1, ROC-AUC, PR-AUC, confusion matrix, false-positive rate, Brier score, log loss, and ten-bin calibration error. Undefined metrics remain null.
- Optional confirmed `failure_at` timestamps support lead-time reporting; absent confirmed event times produce no invented lead-time result. Current lead-time output is observation-level, not a validated event-level early-warning study.

### 4. Stage 2 Stacking Evidence

- Added a forward, group-disjoint OOF export contract using callbacks that fit fresh actual upstream pipelines on each training fold.
- Rejects overlapping examples, seen vehicle groups, missing timestamps, and training observations at or after scored observations.
- Every exported row carries fold/time/group provenance and training-example fingerprints.
- Runtime feedback cannot train Stage 2 unless it carries the required OOF provenance, canonical features, a recognized confirmed outcome, and a single tenant scope.
- Synthetic upstream proxies remain available but are explicitly labeled `synthetic_proxy_stacking`.

**Remaining:** The complete Fleet AI upstream replay/export job and independent real-OOF evaluator are not yet integrated. Ordinary production predictions are not OOF evidence. The standalone real Stage 2 training entry point fails closed; runtime OOF candidates remain unevaluated until a separate reviewed evaluation exists. Provenance fields are an internal pipeline contract, not proof against a malicious producer.

### 5. Calibration

- Independent isotonic calibration is saved with its model version, source, sample count, data fingerprint, and artifact binding. Small calibration sets remain uncalibrated.
- Stage 2 loads and applies only matching artifact-bound probability calibration and conformal state.
- Fixed reversed conformal CONFIRMED/REJECTED interpretation. Unfitted conformal output no longer supplies invented p-values or a field coverage guarantee.
- Disabled activation of legacy unbound conformal files; preserved the files. Newly fitted insufficient conformal data clears prior fitted state.
- Final Node/Python ensemble output remains explicitly uncalibrated. Calibrating an upstream model does not establish calibration of the complete combined decision pipeline.

Legacy pretrained calibration is labeled unverified; synthetic calibration is not real-world calibration.

### 6. Tenant and Vehicle Isolation

- Scoped Python and Node telemetry, baseline, model-state, feedback, and prediction-cache access by organization and vehicle.
- Fleet references require the same organization and known compatible vehicle type/class, exclude the target vehicle, and require sufficient peer data. Unknown/incompatible classes receive no fleet comparison.
- Added ownership checks and atomic JSONB model-state merges to avoid Node overwriting Python learning state or creating unowned model stubs.
- Welford/Isolation Forest caches and locks are tenant-and-vehicle keyed. Stage 3 replay protection and pruning operate on the scoped vehicle, so another tenant's event clock cannot remove its history.
- Scoped review-queue and temporal-status metadata. Mismatched Python tenant/vehicle output is rejected before Node merges scores or lineage.

Shared synthetic priors are intentionally global. Real feedback candidates are tenant-scoped. No automatic anonymized/global real-data training was introduced.

### 7. Prediction Lineage

- Predictions retain separate Node and Python scores and confidence, merge policy, schema and physics versions, pretrained input values/missingness/assumptions, artifact metadata, Stage 1/2/3 evidence, DTC context, engine events, learning counts/cursors, and calibration state.
- Existing `MlPredictionRun` JSON prediction storage and `MlFeatureSnapshot` storage retain this evidence on the updated prediction paths.
- Debugging can inspect those existing org-scoped prediction records. No new public cross-tenant lineage endpoint was added.
- Historical predictions cannot acquire evidence that was never saved; the new lineage is forward-looking.

### 8. Durable Training and Promotion

- Added an operator-controlled SQLite artifact registry containing immutable joblib blobs, checksums, metadata, evaluation reports, active pointers, promotion history, and retraining leases/due times.
- Workflow is candidate -> independent evaluation -> explicit operator promotion -> active. Rollback restores a prior evaluated artifact. Training never automatically promotes.
- Runtime scheduling polls durable job state instead of relying only on a seven-day in-process timer. Failed training/retrieval is distinguishable from insufficient eligible data and retries sooner.
- Saved human review outcomes to the existing `FeedbackLog` before acknowledging/removing the in-memory review item. Save failures leave the item pending. These records are marked production review evidence, not OOF training data.
- Old global logistic feedback auto-training was disabled because it lacked tenant/OOF isolation. Approved synthetic logistic scoring remains available; scoped real logistic retraining needs a reviewed pipeline.

### 9. Evidence Boundary

- Unlabeled telemetry, `no_event`, and ambiguous `normal` outcomes do not automatically become supervised negatives.
- Real-world training requires one organization, explicit confirmed binary outcomes, valid observation times, and label observation timestamps.
- Synthetic, production review, and confirmed real-world outcomes remain separately labeled in metadata and APIs.
- No field accuracy or time-to-failure claim was established or increased by this work.

## Verification Results

### Automated Checks

| Check | Result |
| --- | --- |
| Python backend and real-world report regressions | 209 passed |
| Targeted Node tests | 8 passed |
| Telemetry-chain assertions inside Node suite | 48 passed |
| Python syntax parsing | 38 files passed |
| Node syntax checks | 11 files passed |
| `git diff --check` | Passed; line-ending warnings only |

New regression coverage includes feature ordering/parity, irregular time windows, missing sensors, pressure units, whole-history sampling, group/time splits, OOF rejection, stage weighting/gating, DTC evidence, Welford replay isolation, Isolation Forest eligibility and restoration, conformal binding/verdicts, failed feedback saves, candidate promotion/rollback, schema rejection, durable scheduling, database query scope, and Node/Python merge isolation.

The Python run excluded `backend/tests/test_ai_explain.py`: its unrelated Advisor dependency (`openai`) is not installed in the local test interpreter. A full application startup, live PostgreSQL integration, all frontend launch checks, Android tests, and Railway deployment smoke were not run in this task.

Repeatable test commands (in an environment with the Python dependencies installed):

```powershell
python -B -m pytest backend/tests tests/test_realworld_report.py --ignore=backend/tests/test_ai_explain.py -q -p no:cacheprovider
node --test tests/ml-lineage-isolation.test.js tests/ml-database-scope.test.js tests/telemetry-prediction-coordinator.test.js tests/telemetry-chain.test.js
node --check server.js
git diff --check
```

### Synthetic Replay

A 10-vehicle fixture with 32 days and six observations/day produced 1,920 observations and 93 canonical model features. Approximately 89.33% of matrix entries were observed or available estimates; the rest remained missing. Every initial insufficient-history 30-day delta was missing. There were 111 valid later coolant-delta observations after sensor availability checks.

### Isolated Stage 2 Training Evaluation

The existing 163,099-row synthetic proxy dataset was trained/evaluated in a disposable local temporary registry. A temporary active pointer was used only to verify candidate loading and scoring. Production active pointers and existing model files were unchanged.

| Partition | Rows |
| --- | ---: |
| Training | 97,859 |
| Early-stopping/selection | 13,048 |
| Isotonic calibration | 9,786 |
| Conformal calibration | 9,786 |
| Final test | 32,620 |

| Synthetic test metric | Result |
| --- | ---: |
| Precision | 1.000000 |
| Recall | 0.979275 |
| F1 | 0.989529 |
| ROC-AUC | 0.989637 |
| PR-AUC | 0.979397 |
| False-positive rate | 0.000000 |
| Brier score | 0.000123 |
| ECE, 10 bins | 0.000123 |
| Log loss | 0.004420 |
| TP / FN / TN / FP | 189 / 4 / 32,427 / 0 |
| Useful real failure lead time | Not assessed |

**Do not market these numbers as field performance.** This legacy synthetic dataset has no vehicle IDs, so this evaluation uses explicitly labeled row-level splits and does not establish unseen-vehicle generalization. Proxy-generated upstream scores make the task different from real Fleet AI operation. High synthetic scores cannot establish a low real-world false-alarm rate. No comparable corrected pre-change baseline was run; no accuracy improvement is claimed.

The existing legacy RF/HGB and Stage 2 artifacts also loaded and scored under the local compatibility checks. The complete corrected RF/HGB training campaign has **not** been run, and no full-size new pretrained artifact has been promoted.

## Runtime and Dependency Notes

Testing used local Python 3.14.2, scikit-learn 1.8.0, NumPy 2.4.2 and pandas 3.0.1. Temporary test-only dependencies were installed outside the repository. Local asyncpg 0.31 and pyarrow 23 supplied Python 3.14 wheels; the deployment requirements still specify their existing versions. Repeat compatibility checks in the actual production Linux/Python image.

A real compatibility failure was reproduced with LightGBM 4.5 and scikit-learn 1.8 (`force_all_finite`). LightGBM was pinned to 4.6 in the relevant requirements and the training/load smoke passed. Its updated sklearn validation implementation is documented in the [official LightGBM 4.6 source](https://lightgbm.readthedocs.io/en/v4.6.0/_modules/lightgbm/sklearn.html). Legacy model prediction emits a feature-name warning in the local evaluation; scoring completed, but this should be cleaned up in a future artifact refresh rather than suppressed globally.

Training remains CPU/tree-model based. No CUDA, DirectML, Intel Arc, OpenVINO, PyTorch or neural-network migration occurred. Artifact metadata records package versions; a complete platform lockfile/container reproduction is still required for release reproducibility.

## Files Changed for This Task

Existing files can also contain unrelated edits that predate this task. This list identifies the hardening work, not ownership of every working-tree diff.

- `backend/app/ml/feature_contract.py` (new): canonical schemas, transforms, units and fingerprints.
- `backend/app/ml/evaluation.py` (new): partitioning, metrics and calibration.
- `backend/app/ml/stacking_evidence.py` (new): forward/group-disjoint OOF contract.
- `backend/app/ml/artifact_registry.py` (new): immutable artifacts, evaluation, promotion, rollback and leases.
- `backend/app/ml/retraining.py` (new): restart-safe tenant candidate scheduling.
- `backend/app/ml/features.py`: observed-time features, missingness and units.
- `backend/app/ml/pretrained.py`: canonical inference, prior discovery and evidence.
- `backend/app/ml/stage2.py`: feature handling, bound calibration, scoped candidate training and inference fallback.
- `backend/app/ml/stage3.py`: event deduplication and scoped history/pruning.
- `backend/app/ml/isolation_forest.py`: persisted imputation/schema and missing-input restoration.
- `backend/app/ml/conformal.py`: verdict correction and model-bound calibration.
- `backend/app/ml/stack.py`: corrected artifact restoration and blocked unsafe global feedback training.
- `backend/app/ml/active_learning.py`: scoped queues and persist-before-acknowledge support.
- `backend/app/ml/fleet.py`: tenant/class-scoped fleet references.
- `backend/app/ml/diagnosis.py`: explicit legacy diagnostic slope compatibility.
- `backend/app/db/pg.py`: scoped reads/writes, historical anchors, durable review outcomes.
- `backend/app/routes/predict.py`: scoped stage integration, learning locks, lineage and review persistence.
- `backend/app/main.py`: durable scheduler polling.
- `backend/fleet_ai/__init__.py`, `fleet_ai/__init__.py` (new): shared-package resolution.
- `backend/fleet_ai/physics/vehicle_physics.py`, `fleet_ai/physics/vehicle_physics.py`: consistent all-missing RF imputer dimensions; physics equations retained.
- `fleet_ai/training/canonical_inputs.py` (new): simulator observation replay through production inputs.
- `fleet_ai/training/fleet_simulation.py`: independent partitions, canonical replay, complete-history sampling and candidate exports.
- `fleet_ai/training/train_stage2.py`: independent LightGBM candidate training/evaluation.
- `fleet_ai/training/train_real_world.py`: real timestamp windows, confirmed labels, independent selection/calibration/test.
- `fleet_ai/api/ml_service.py`: alternate service canonical inference, artifact/profile consistency and honest prior confidence.
- `backend/requirements.txt`, `fleet_ai/requirements.txt`: tree-library compatibility pins.
- `server/db.js`: scoped database queries and atomic ownership-checked model-state merging.
- `server/lib/mlMerge.js`: explicit Node/Python lineage and tenant mismatch rejection.
- `server/services/telemetryPredictionCoordinator.js`: tenant-aware prediction caching.
- `server/services/aiReportService.js`, `server/routes/mlRoutes.js`, `server/routes/solutionRoutes.js`, `server/routes/fleetOpsRoutes.js`, `server.js`: resolved organization propagation and lineage persistence.
- `scripts/ml-artifacts.py` (new): operator inventory/promotion/rollback CLI.
- `backend/tests/test_ml_hardening.py` (new), `tests/ml-lineage-isolation.test.js` (new), `tests/ml-database-scope.test.js` (new): regression fixtures.
- `tests/telemetry-prediction-coordinator.test.js`, `tests/test_realworld_report.py`: updated scoped/confirmed-outcome fixture expectations.
- `docs/ml-hardening-2026-09-09.md` (new): this report.

## Database and Railway Requirements

1. No new Prisma/PostgreSQL migration is introduced. Existing `FeedbackLog`, `ModelState`, `Baseline`, `MlPredictionRun` and `MlFeatureSnapshot` structures are used. Verify those existing migrations are present in staging.
2. The artifact registry creates its own SQLite tables in its configured directory. Set `FLEETAI_ML_ARTIFACT_DIR` to an absolute path on a **persistent volume mounted to the Python ML service**, for example `/data/ml-artifacts`. Do not point it at an ephemeral build directory.
3. Without that variable, production scheduled candidate training is disabled; legacy static inference remains available. Offline training uses a local candidate directory unless an explicit registry directory is set.
4. Back up the registry database consistently. It includes model blobs, promotion history and job state; copying an arbitrary live database file is not a backup strategy. Use SQLite backup tooling or a stopped-service backup, then verify restoration.
5. Keep the current internal ML service authentication and private-service boundary. No credential values or public training/promotion routes were added.
6. Use one Python inference worker/replica for the present Welford read/update/write design. Local per-vehicle locks and atomic JSONB field merging do **not** constitute a distributed Welford transaction. Multiple replicas require a DB advisory lock or compare-and-swap design before enabling concurrent writers.
7. Deploy compatible Python dependencies, verify legacy artifact loading, and smoke-test Node -> Python -> database prediction persistence in staging before Railway production rollout.
8. Explicit promotion/rollback requires restarting the ML service so its cached active model is reloaded. Verify model status and one tenant-scoped prediction after restart.

Operator commands, from the repository root with the persistent registry variable already configured:

```powershell
python scripts/ml-artifacts.py list
python scripts/ml-artifacts.py promote --id <evaluated-candidate-id> --reason "Reviewed independent evaluation and staging smoke"
python scripts/ml-artifacts.py rollback --slot stage2 --scope global_synthetic --reason "Rollback after validation failure"
```

Do not promote the disposable synthetic validation fixture as a production model.

## Remaining Limitations and Required Evidence

- Run and independently review a full canonical RF/HGB retraining campaign. Existing legacy artifacts were not trained under the corrected feature semantics; compatibility labeling is not scientific revalidation.
- Integrate actual upstream OOF replay and an independent real Stage 2 evaluator before training/promoting from customer failure outcomes.
- The separate 18-feature real-world HGB trainer saves tenant candidates, but its model is not silently substituted into the active 93-feature ensemble. A reviewed, schema-compatible serving integration remains necessary before that slot can affect production.
- Diagnostic heuristic cutoffs still use an explicitly named legacy sample-index slope to preserve existing warning behavior. The new canonical ML temporal features use elapsed time. Converting those remaining diagnostic cutoffs to hourly rates requires a separately validated threshold change.
- Stage 3 temporal buffers and unreviewed active-learning queues remain process-local; restarts reset them. Reviewed outcomes and retraining due times are durable. Welford/IF state persistence still needs live DB restart/recovery testing and distributed transaction work before scaling writers.
- Legacy historical rows with missing or conflicting organization ownership are not automatically reattached. They now fail closed and need an operator-reviewed ownership reconciliation.
- Some physics outputs depend on estimated vehicle/load conditions or unavailable sensors. Their assumptions are reported; an estimate is not proof that the vehicle has that sensor or fault.
- A reliable event-level evaluation needs confirmed failure/service outcomes, non-failure follow-up horizons, repair findings, vehicle class, event timestamps, and enough independent vehicles. Assess false alerts per vehicle-day, missed failures, first useful warning per event, and prospective calibration separately by class/subsystem.
- No verified real-world breakdown-detection percentage, guaranteed warning interval, causal diagnosis, or fleet-wide calibration was established. Lower corrected scores would be reported honestly rather than tuned back toward earlier synthetic numbers.

## Recommended Release Sequence

1. Review only the hardening diffs; preserve unrelated working-tree work.
2. Run the same regressions in the production Linux/Python image and add a real PostgreSQL two-tenant integration/restart test.
3. Configure and restore-test the persistent artifact volume in staging.
4. Replay representative historical inputs with old/new lineage side by side without promoting new models or changing driver behavior.
5. Run the canonical training/evaluation campaign, inspect missing-feature coverage, and review candidate metrics without treating synthetic scores as field validation.
6. Promote only after explicit operator review, with a documented rollback and post-deployment scoped prediction smoke.
