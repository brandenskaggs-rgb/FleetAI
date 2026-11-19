# Security and diagnostic hardening - 2026-11-19

## Scope

Incremental fixes to the ten findings from the source review. No redesign, model
replacement, customer-data cleanup, password reset, or pairing migration.

## Fixes

1. Mutation queue: register disconnect handlers before waiting; cancelled requests
   retain queue ordering without blocking successors. Active disconnected
   requests retain the lock until returned handler promises settle, including
   token refresh/disconnect and invitation acceptance. All three PostgreSQL
   telemetry ingest aliases bypass unrelated legacy JSON mutation requests.
2. Android replay: HOS, DVIR, notifications and telemetry carry an immutable
   authenticated-session tag. The HTTP interceptor validates that exact session
   and uses its credentials. Changed-session records remain queued; failed
   acknowledgments do not mark them uploaded.
3. Deleted organizations: customer login, password setup, session validation,
   invitations and paired-device authentication reject unavailable organizations.
   Existing active/pilot organizations retain their credentials and sessions.
4. Motive isolation: integration vehicle/VIN and driver lookups require the
   configured organization. Updates include that scope; globally unique ID
   conflicts fail closed. Other organizations cannot see integration purchases
   merely by registering a matching VIN. Backfill is organization filtered.
5. Android fault reads: preserve ECU packet and ELM numbered-frame boundaries
   through response cleanup, including multiple ECU fault-code responses.
6. Prediction parity: normal prediction and explicit recompute use the same
   fault-evidence selector, including persisted diagnostic-only uploads. Missing,
   partial and historical evidence is reported, not represented as a clean scan.
   Permanent-only codes are not treated as current confirmed/pending faults.
7. Live diagnostics: read persisted, tenant-scoped diagnostic scans after a
   restart even when no sensor sample or live cache exists. Acquisition time, not
   recent upload time, determines whether fault evidence is recent.
8. Motive OAuth: session-bound hashed state is durable, expires after at most ten
   minutes and is consumed atomically once. Cross-session and replay callbacks
   fail closed.
9. Viewer accounts: a narrowly scoped self-password-change guard retains session,
   tenant and current-password checks without granting fleet mutation access.
10. Admin provisioning: omitting an optional password generates a usable
    temporary password, returned only in the authorized creation response and
    stored hashed. First-use password setup remains required.

## Main changed areas

- `server/middleware/mutationQueue.js`, `server.js`
- `server/auth/tenantAccess.js`, `authService.js`, device/auth/admin/org routes
- `server/pgSessionStore.js`, `server/routes/motiveOAuthRoutes.js`
- `server/db.js`, `server/services/motiveSync.js`, Motive data/webhook routes
- `server/services/faultEvidence.js`, `liveDiagnosticService.js`, `mlRoutes.js`
- Android `AuthenticatedSession`, `ApiClient`, `ApiService`, repository and outbox
- Android `ObdResponseCleaner` and `ObdConnectionManager`

## Tests

New regressions cover queue cancellation and ordering, two-organization Motive
matching, fault-input parity, persisted diagnostics, deleted-organization access,
viewer password changes, temporary credentials, OAuth reload/replay/expiry,
Android account-switch races and multiline ECU responses. `npm run test:hardening`
runs the new Node regressions and related session tests. Android tests exercise
actual Retrofit tags and the production authentication helper without sockets.

Existing integration, security, pilot-data, storage, Advisor/PDF, ELD primitives,
password setup, launch checks and browser workflows are also checked for release.
Browser checks use isolated synthetic fixtures, not customer accounts. ELD unit
tests do not establish regulatory certification. Dependency audit is separate
from source review; the managed security scan timed out in the preceding audit.

Release verification: 46 hardening tests and 89 Android debug unit tests passed.
The release-variant Android unit suite also passed 89 tests. Full integration,
security, pilot-data, audit, Advisor/PDF, ELD, password setup, release publishing
and launch suites passed. Dashboard checks covered 32 routes at three widths;
employee checks covered 11 routes at four widths. Public checks passed on retry
after one navigation timeout. `npm audit` reported zero known vulnerabilities.

## Deployment and compatibility

- Migration `20261119090000_session_oauth_state` adds two nullable Session columns.
  No session rows or existing expiry values are changed. Railway must run the
  committed `prisma migrate deploy` before starting the new server.
- No new environment variables. Motive remains a single configured integration
  scoped by `MOTIVE_ORG_ID` (legacy default `ORG_DEFAULT`), not a new multi-account
  Motive connector.
- Pilot Android 1.10.9 / versionCode 21 uses `com.fleetai.driver` and the existing
  pilot signing certificate. It is not the Google Play build.
- Install as an update while parked; do not uninstall or clear app data.
  DataStore names/keys, Room schema and persisted pairing/token format are unchanged.
- Prior APKs remain available in repository history. Publish APK and checksum
  metadata together, then verify the downloaded production artifact.

## Remaining limits

No physical vehicle/tablet upgrade was performed during this work. Generic OBD
fault reads do not establish ABS/TPMS coverage. Missing or mismatched identity on
old queued records is not guessed or reassigned; those records stay queued.
The legacy JSON mutation queue is still process-local; this patch does not make
legacy file writes safe across multiple replicas. Mutation completion is
tracked only when handlers return their asynchronous work; new mutation handlers
must not detach writes into unreturned promises or callbacks. OAuth database semantics are
unit-tested with mocks; deployment must separately verify migration success.
These fixes reduce known risks but do not guarantee the absence of other bugs.

Railway's current documentation says existing config-as-code files take precedence
over dashboard settings but are deprecated with a 2026-12-01 cutoff. Plan a separate
infrastructure-configuration migration before that deadline; this release does not
apply the unrelated staged dashboard patch. Source:
https://docs.railway.com/config-as-code
