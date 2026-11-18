# Advisor live diagnostic analysis

## Use

Select a vehicle in Fleet Advisor and ask **Run a live diagnostic scan**. An exact
unit name or a fleet with only one vehicle also resolves the target. Ambiguous
requests ask for a vehicle instead of choosing the first one.

The authenticated server runs an analysis of received telemetry and saves an
Advisor report. This command runs independently of the language-model provider;
the response is built from actual evidence, not a generated claim that a tool ran.
Subsequent Advisor conversations can reference the last five saved diagnostic
reports, filtered to authorized vehicles.

`POST /api/diagnostics/live-analysis` provides the same operation with `vehicleId`
and optional `message`. Authorization uses the existing customer/employee session.
Customer organization IDs in requests cannot override the session's organization.
Report downloads use the existing tenant-scoped Advisor artifact routes.

## What it examines

- Catalogued sensor values and additional numeric uploaded metrics.
- Per-signal freshness, including age elapsed since the cached packet arrived.
- Available transmission and brake/wheel-speed signals, with gaps listed explicitly.
- Reported DTCs and the timestamp of their original read, not the scan request time.
- The latest persisted ML prediction, its version/source/confidence and timestamp.
  The analysis does not retrain or rerun the model or represent synthetic evidence
  as verified real-world performance.

Fresh requires recent active bus packets and explicit per-signal acquisition-age
metadata. A recent database row alone is labelled `recent_record`, not a verified
live connection. Older samples are stale; unreported signals stay missing, not zero.
An empty or absent DTC read cannot establish that the vehicle is fault-free.
The bounded historical query reads at most 120 samples. This is not a full trip
analysis and does not infer gear ratios, wheel slip, misfire, or mechanical health
from unsynchronized readings.

## No tablet update required for this command

This feature consumes the current tablet's uploads. It does not send a new ECU
scan command, enable new OEM PIDs, conduct actuator tests, clear codes, or start a
continuous watch. New polling-priority commands from the separate sensor-watch
feature still require the updated tablet. Pairing and existing upload behavior
are unchanged by this server-side command.

The Camaro profile still lacks verified enhanced transmission/ABS definitions.
The report cannot diagnose those modules simply because the vehicle has sensors.
A mechanical inspection remains necessary for jerking or suspected braking faults.

## Fluctuating signal counter

Both Android `ObdTelemetryService.kt` and `SensorViewModel.kt` currently display
the number of readings whose timestamps fall within `ECU_DATA_SILENCE_MS` (10
seconds), compared with the polling-plan size. The numerator can change as
individual PIDs age and refresh; it is not a count of Bluetooth reconnections.
It also includes derived timestamps, so it should not be interpreted as a strict
count of independently supported PIDs. No tablet polling or UI changes were made
for this request. A future UI change should separate configured, recently read,
stale, and unsupported signals without extending freshness to hide dropouts.

This explains the counter implementation, not the exact cause of any particular
road-session fluctuation. That still requires the affected session's timing/error
data. No production telemetry was inspected for this implementation.

## Deployment and checks

Deploy the backend before trying the command in production. This feature adds no
database table; it uses existing telemetry, model-run, and Advisor-artifact tables.
The separate, pending sensor-watch changes in this checkout include a migration,
so deploying the entire working tree still requires that migration.

Run `npm run test:live-diagnostics`, `npm run test:sensor-watch`, `npm run test:ai`,
`npm run test:integration`, and `npm run launch:check`. Local tests are not evidence
that an actual vehicle supplied transmission/ABS readings or that a fault was
successfully diagnosed. Nothing here certifies safety to drive.
