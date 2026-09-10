# Fleet AI Link dashboard

## Scope

Customer dashboard visual redesign, aligned with the black Link website identity.
All 32 existing route IDs remain. Shared navigation, typography, tables, controls,
status displays, Advisor conversation surfaces, and responsive layouts have been
replaced. The initial redesign made no backend changes. The pre-push review below
adds one read-only sensor catalog entry. Model, database, Android, and Railway
configuration remain unchanged.

## Files

- `ui/fleetai-dashboard.html`: dashboard structure, route labels, overview,
  vehicle context, pairing presentation, forms, Advisor, and telemetry presentation.
- `css/dashboard-link.css`: shared dashboard visual system and responsive layouts.
- `ui/js/dashboard-display.js`: pure unit conversion, engine-output estimates,
  timestamped chart series and Chart.js rendering.
- `assets/vendor/chartjs/`: pinned Chart.js 4.5.1 and license.
- `assets/vendor/lucide/`: pinned Lucide 0.468.0 and license. Familiar controls use
  standard icons; the Fleet AI brand artwork is custom.
- `tools/render-dashboard-connection.py`: reproducible Blender connection artwork.
- `assets/brand/fleetai-connection.webp`: optimized Blender render for pairing.
- `tests/dashboard-display.test.js`: eight unit and missing-data tests.
- `tests/dashboard-fixtures.js`: isolated, synthetic in-memory test records.
- `tests/dashboard-browser-smoke.js`: browser regression and loopback preview.

The source Blender scene was saved outside the application repository under the
Codex visualizations folder, in `dashboard-connection/Fleet-AI-Connection.blend`.
Blender is used for brand assets, not for rasterized text or interactive controls.
The application remains accessible HTML, CSS, and JavaScript.

## Data display

- Coolant and Celsius sensor values display in Fahrenheit. History exports use
  the displayed units and identify them. Raw storage and ML inputs remain SI.
- Speed retains the existing canonical km/h-to-mph conversion. Missing speed no
  longer becomes a displayed zero through JavaScript's `Number(null)` coercion.
- Torque requires actual ECU torque percentage and positive reference torque:
  `Nm = actualTorquePct / 100 * referenceTorqueNm`.
- Power additionally requires RPM: `hp = Nm * RPM * 2*pi / 60 / 745.6998715822702`.
- Torque is displayed in lb-ft using `Nm / 1.3558179483314004`.
- These are ECU-derived mechanical estimates, not wheel power, rated horsepower,
  or dynamometer measurements. Throttle position and load never substitute for
  torque. Not all adapters or vehicles supply the required signals.
- Known sensor ages above 30 seconds are rejected. Power is withheld when known
  torque and RPM ages differ by over five seconds. Older payloads without metric
  age metadata still depend on the existing packet-level freshness gate.
- Live charts contain at most 600 selected-vehicle samples from this page session.
  They do not write telemetry or replace persisted history. History charts query
  the existing APIs. Missing values and long gaps are not interpolated.
- Stream frames for another vehicle cannot overwrite the selected unit's live
  readings. Vehicle switching clears chart/readout state; late sensor/history
  responses are discarded when their selection no longer matches.

## Pairing and account boundary

Code generation, PIN payloads, API fallback behavior, authentication, tenant/user
headers, cookie handling, and server authorization remain unchanged. Pairing
failures are now visible outside the diagnostic drawer. Successful revoke or
replacement clears old errors, and the replacement code updates the small status
readout. No pairing protocol or claim validation changes were made.

The original `generatePairingPacket`, `loadPairingTables`, API helpers, `authInit`,
DVIR submission, and Advisor request/action functions were compared with the
pre-redesign snapshot and remained unchanged. The pairing action handler has
display-state updates only; its requests and payloads are unchanged.

## Verification

```powershell
node --check server.js
node --check ui/js/dashboard-display.js
node --test tests/dashboard-display.test.js
node --test tests/dashboard-request-safety.test.js
node --test tests/session-tenant-isolation.test.js
node tests/pairing-bootstrap.test.js
npm.cmd run test:ui:browser
npm.cmd run launch:check
git diff --check
```

Browser coverage includes 32 routes at 1440, 1024, and 390 pixels; page overflow;
navigation; fonts; pairing creation/conflict/revoke/replacement; vehicle/driver
creation; DVIR, dispatch and parts submission; Fahrenheit and engine-output
values; selected-vehicle isolation; nonblank chart pixels; logout failure and
unauthenticated redirect. Browser writes use synthetic in-memory fixtures only.

## Local preview

```powershell
node tests/dashboard-browser-smoke.js --serve
```

Open `http://127.0.0.1:4176/ui/fleetai-dashboard.html`. Override the port with
`DASHBOARD_PREVIEW_PORT` if necessary. This server binds to loopback only. Its
header explicitly identifies sample data. Telemetry is simulated, created
records disappear when it stops, and Advisor has no connected AI service.
It never reads `.env`, connects to Railway, or writes production records.

## Limits

No physical tablet was available for an end-to-end pairing or ECU test. Regression
tests do not replace that check. Existing backend availability and feature limits
are unchanged; redesigned pages do not enable unimplemented integrations, camera
streams, settings APIs, or certification. No deployment or commit was performed.

## Pre-push pilot review

- Production startup is still `prisma migrate deploy && node server.js`; it does
  not start or import the isolated browser fixture server. The preview refuses
  `NODE_ENV=production`, binds to loopback, and test source paths remain blocked
  by the application's static-source policy.
- Removed hardcoded Coaching zero counts and fabricated Extension statuses.
  Extensions now read actual organization entitlements from `/api/fleet/addons`.
  Coaching explicitly reports its missing data source; it is not a completed
  feature. Existing incomplete settings and provider integrations remain limits.
- Signal desk has an All sensors shortcut, search by name/key/PID/SPN/system,
  and filters for all, reporting, stale, or unsupported sensor entries.
  All returned groups are rendered, including groups added later by the backend.
- The current backend catalog contains 71 entries. This is not a claim that any
  particular vehicle supports 71 readings. Unsupported and stale readings remain
  explicitly identified. No new PID polling or tablet changes were introduced.
- Sensor inventory refreshes while the Signal desk is open, even if the live
  stream goes quiet. Failed requests clear displayed values; selection and
  request guards prevent late replies from showing another selected vehicle.
- Added `tests/dashboard-pilot-readiness.test.js`: production/preview separation,
  direct sensor handler organization isolation, device pairing scope, complete
  catalog return, retained Celsius API values, and stale-value suppression.
- Checked telemetry chain (48), pairing bootstrap (10), security boundary (18),
  tenant sessions (17), display helpers (8), request safety, source exposure,
  readiness tests (3), browser routes/forms/filters, and launch guardrails.
- No live pilot vehicle, account, token, stored sample, model, or pairing was
  edited or reset. No production deployment or physical ECU test was performed.
- One read-only backend catalog correction followed the frontend-only redesign:
  added the existing normalized `engine.actualTorquePct` field (PID 0162 / SPN
  513), which was missing even though ingestion already received it. The older
  `torquePct` field remains unchanged. Tests cover both visibility and stale-value
  suppression. No ingestion, inference, schema, or account changes were needed.
