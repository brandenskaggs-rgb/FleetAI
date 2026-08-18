# Fleet AI ELD Test Plan

The authoritative test source is the FMCSA ELD Test Plan and Procedures and 49 CFR Part 395 Appendix A. This file is the Fleet AI execution index, not a substitute for those documents.

## Automated suites

- 'npm.cmd run test:eld': federal character mapping, event/line/file checks, filename format, output segments, motion inputs, personal-conveyance precision, federal 10/11/14 and break clocks, and California intrastate 12/16/80 base clocks.
- `npm.cmd run test:integration`: backend authentication, tenant isolation, pairing, telemetry, ELD contracts, and regression tests.
- `driver_app\gradlew.bat testDebugUnitTest assembleDebug`: Android unit tests and APK build.
- `npm.cmd run eld:readiness`: release gate for code artifacts and external provider credentials/reviews.

## Bench tests

1. Power the tablet and J1939 gateway from a controlled Class 8 bench harness.
2. Verify engine power, motion, odometer, engine hours, VIN, and GPS timestamps.
3. Verify sequence IDs remain continuous through app, tablet, and engine power cycles.
4. Exercise each malfunction and diagnostic threshold: power, engine sync, timing, positioning, recording, transfer, and unidentified driving.
5. Disconnect cellular service and verify local records remain visible and upload in original timestamp order after recovery.
6. Run generated files through FMCSA File Validator until no errors remain.
7. Replay the official HOS scenarios for 60/7, 70/8, 34-hour restart, 30-minute break, split sleeper, adverse conditions, and every enabled exception profile.

## Controlled truck validation

1. Install only on a carrier-approved vehicle with an approved listen-only J1939 gateway.
2. Compare miles, engine hours, motion, VIN, and duty transitions against a trusted reference ELD and diagnostic tool.
3. Complete at least 30 operating days across power cycles, weak GPS, cellular loss, team driving, yard moves, personal conveyance, and roadside export drills.
4. Record every discrepancy with the input capture, generated ELD event, output file, and expected result.
5. Do not replace the carrier's registered ELD during shadow validation.

## Certification exit criteria

- Every official FMCSA test case has dated evidence and reviewer approval.
- File Validator and both telematics transfer methods pass.
- Web eRODS matches the tablet roadside display and source event ledger.
- Independent compliance and security findings are closed.
- Exact released model/version is registered and publicly listed by FMCSA.
