# Advisor PDF reports and OBD fault-read evidence

## Report action

Ask Fleet Advisor: `Generate a PDF report for Car-01` or `Build a risk report for all vehicles`.
The server executes `generate_report` without depending on an LLM response. The full Advisor
page, dock, and Recent reports list expose Open PDF and Download PDF controls. No fabricated
link or report receipt is returned when generation or persistence fails.

`server/services/advisorReportPdf.js` owns template `fleet-evidence-v1`: summary, coverage,
health/model evidence, faults, service/activity, optional sensor appendix, and limitations.
It uses the existing Link mark, fixed columns, wrapped rows, repeated headers, and page numbers.
The template displays recorded values, not invented readings or forecasts. Queries are bounded;
this is not a complete lifetime data export. Synthetic prior scores are not field validation.

The PDF bytes, SHA-256 and template version are stored in the existing AdvisorArtifact JSON
alongside the evidence snapshot. Downloads return those same bytes. Maximum size is 4 MiB;
base64 storage adds about one third overhead. Legacy artifacts render from their saved evidence.
Authenticated downloads scope lookup by the current organization and disable caching.
No public download bucket, filesystem persistence, new secrets, or database migration is required.

## Read-only diagnostics

Android requests monitor status (`0101`), confirmed codes (`03`), pending codes (`07`) and
permanent codes (`0A`). Commands use the existing read-only policy and adapter mutex.
Automatic diagnostic reads run at most once per minute alongside normal polling; the child
job is cancelled before reconnecting. No code clearing, actuator control or pairing change.

The additive `meta.obdFaultRead` payload preserves nullable mode results, read time, MIL
command status and maximum stored-code count reported by an ECU. Headers-off replies cannot
be reliably summed by module. `null` means no valid read, whereas `[]` means a valid empty
response for that mode. `partial` and `inconsistent` are not clean scans. An illuminated MIL
with empty confirmed codes, or more reported codes than decoded codes, is inconsistent.

Confirmed codes alone feed the existing active-DTC ML input. Pending and permanent records
are retained separately for display and reports; permanent codes can persist after repair.
Diagnostic-only uploads are saved without creating artificial sensor observations for ML.
Replay uses a deterministic scan identity. Old tablet payloads remain supported but cannot
retroactively provide the new monitor/mode evidence.

Generic emissions OBD is NOT an all-module TPMS/ABS scan. These changes do not implement a
manufacturer-specific TPMS gateway. Warning lights require investigation even if no codes
are returned. Current field hardware must be checked against an independent scan tool.

## Rollout

- Deploy Node dependencies, the dashboard/CSS, services and existing brand asset together.
- No tenant/account, pairing credential, package identity or local login storage is changed.
- Android code must be released under a new version code using the existing pilot signing key.
  Do not overwrite the already published version 19 / 1.10.7 APK.
- After the tablet update, verify MIL and mode status with the ignition/adapter connected,
  including a known fault, unsupported mode, reconnect and offline upload/replay.
- Until that release is installed, only backend report/wording changes are available; new
  read modes cannot be enabled by deploying the backend alone.

## Verification

Pilot release 1.10.8 / versionCode 20 retains `com.fleetai.driver` and the original
pilot certificate (SHA-256 `68a54f1c5447ac1bcb07263c9ffeb9293e950694ab7619e6835d215cf3d70ac0`).
Install as an update, never uninstall or clear storage. No pairing preferences, tokens,
database schema or account migration changes are part of this release.

The release also updates body-parser, proxy-addr, qs, ip-address, fast-uri,
fast-xml-parser and zod within their existing major versions. The lockfile preserves
the resolved patched versions. Full npm audit and production-only npm audit report
zero known advisories at verification time; this is not a claim of complete security.
Security/integration, ELD XML, Advisor/PDF, diagnostic coverage, release publishing,
launch checks and 32-route/three-viewport browser tests pass. Android has 73 passing
unit tests; physical vehicle testing remains required for actual adapter coverage.

- `node --test tests/advisor-pdf.test.js tests/obd-dtc-persistence.test.js tests/live-diagnostic.test.js`
- `npm run test:integration` and `npm run launch:check`
- `npm run test:ui:browser` (isolated fixtures, including PDF cards and diagnostic coverage)
- `driver_app/gradlew.bat :app:testDebugUnitTest` with a configured Android SDK/JDK

The report test writes an explicitly synthetic PDF under ignored `artifacts/reports/` for
visual inspection. No real customer data is used by these tests.
