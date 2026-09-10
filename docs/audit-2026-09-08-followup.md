# Storage, dashboard and tablet follow-up

September 8, 2026. Branch: `clean-auth-rebuild`. This extends the first audit; it is not a complete security certification.

## Additional bugs fixed

1. **P1: JSON shape validation.** A parseable root array, null, or wrongly typed users/orgs collection could be normalized into empty records. Storage now validates before normalization, including through the server data-store wrapper. Invalid writes do not replace the current file.
2. **P1: Recovery concurrency.** Initialization and recovery previously ran outside the write queue, and recovered objects lacked revision protection. Reads, initialization, recovery and writes now share the single-process queue; recovered snapshots receive the same stale-write checks as ordinary reads.
3. **P2: Backup recovery.** A corrupt newest backup prevented trying older valid backups. Recovery checks candidates newest-first, validates their structure, and reports the selected backup. Repeated reads of the same damaged primary no longer create an unlimited series of identical bad snapshots within that process.
4. **P2: Misleading dashboard health.** A failed model request appeared as no elevated risks. Unavailable data now stays unassessed. Unknown, offline and calibrating pills are neutral rather than green; a numeric zero score remains high risk. Older overlapping overview requests cannot overwrite a newer overview response.
5. **P2: Invalid ML report JSON.** The historical real-world report contained NaN, rejected by standard JSON readers. Undefined AUC values now use null and the report is explicitly marked insufficient evidence: three total rows and one test row are not validation. Training checks binary labels, timestamps and class presence in both splits, rejects unsupported splits before model export, and serializes reports with non-finite values forbidden. No model weights were replaced and no training job was run.
6. **P2: Tablet readability and layout.** Sign-in and pairing no longer compress two columns on narrow displays. Home status and HOS fields switch from four to two columns. Status-bar icon contrast follows the app theme, and pairing respects safe drawing areas and the keyboard. Static pre-drive guidance no longer uses green completed-check icons.

## Design and interaction changes

- Dashboard: unboxed summary metrics, quieter service rail, flatter tables/forms, fewer active-outline effects, and a fixed brand above a separately scrolling sidebar. Daily work remains available while other navigation groups collapse as the operator changes sections.
- Summary metrics link to their underlying views. Priority-queue vehicle names select the vehicle and open telemetry. Existing route IDs and API contracts are preserved.
- Android: bundled Source Sans 3 with license, larger type and line height, neutral charcoal/white surfaces, borderless shared panels, restrained 8px buttons, and simpler pairing copy. The app's light/dark preference is preserved.
- No edits to Bluetooth/J1939 transport, telemetry upload, offline queue, pairing API, or HOS calculations. MainActivity changes only system-bar appearance. These tablet UI changes need an updated APK to appear on a physical tablet.

## Verification

- `npm run test:integration`: passed, including tenant, pairing, telemetry and security regressions.
- `npm run test:audit`: passed; includes strict parsing of all 35 tracked JSON files and new malformed-store/recovered-snapshot tests.
- `npm run test:ui:browser`: all 32 routes at 1440, 1024 and 390px; form submissions use local fixtures, not production records. Vehicle drill-down and failed model request cases pass.
- `npm run launch:check` and server syntax checks: passed.
- `backend/.venv/Scripts/python -m pytest backend/tests tests/test_realworld_report.py -q`: 180 passed.
- Android `assembleDebug lintRelease testDebugUnitTest`: passed. Debug APK at `driver_app/app/build/outputs/apk/debug/app-debug.apk`; not signed for Play Store distribution.
- Visual inspection used the local tablet emulator in training-demo mode with Wi-Fi disabled. Landscape and narrow portrait layouts were checked, including scrolling to duty actions and settings. This does not replace a test on the connected vehicle hardware.

## Still needs separate validation

The first audit's cross-store account consistency and multi-replica JSON risks remain. The queue is not a distributed lock. Backup recovery can restore older data and must be investigated; a successful restore is not proof that no records were lost. ML evaluation still needs independent calibration, representative real outcomes and sampling-unit review. UI screenshots and test counts do not establish predictive accuracy, regulatory certification, or production-scale reliability.

No production account resets, model promotion, commit, push, or deployment were performed in this follow-up. Existing local changes were preserved.
