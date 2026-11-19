# Camaro transmission compatibility test

## Scope

Android 1.10.10 (22) adds a manually initiated test under Diagnostics. It is
for the user's 2010 Chevrolet Camaro 3.6L LLT automatic, RS package, with the
Veepeak OBDCheck BLE+. This is a compatibility experiment, not a transmission
health assessment or validated ongoing transmission monitoring.

No changes to pairing endpoints, stored credentials, device tokens, preferences,
telemetry queues, normal sensor profiles, normal polling schedules or ML inputs.
No backend changes or database migrations. The APK must replace the existing
installation with the same package/signing key. Do not uninstall or clear data.

## Test procedure

1. Install the test APK over the existing Fleet AI Driver installation.
2. Connect the Veepeak to the Camaro and connect the app as usual. Keep the
   vehicle stationary in Park with the parking brake set. Ignition must be on;
   run the engine only outdoors if needed to establish ECU communication.
3. Open Diagnostics, find Camaro transmission test, confirm the parked automatic
   vehicle checkbox and press Test transmission temperature.
4. Capture the resulting address, response bytes and temperature for each row.
   The results are local, one-time samples. They are not uploaded or logged to
   telemetry and do not automatically enable any new sensors.
5. Check that ordinary RPM/coolant/battery readings resume. The serial adapter
   command lock briefly pauses competing reads during each address transaction.
6. Compare any candidate temperature with a known-capable GM scan tool, including
   plausibility when cold and after warming, before approving continuous polling.

A missing or rejected response does not mean the transmission is faulty or that
the adapter can never read it. A plausible number alone does not establish the
correct ECU, physical sensor or accuracy. The test is temperature-only, not gear,
shaft speed, torque-converter slip, ABS, TPMS or brake-pressure coverage.

## Request provenance and safeguards

ScanGauge's published GM CANSF definitions list ReadDataByIdentifier 22 19 40 at
request address 7E2 and alternate 7E0. Expected positive payload is 62 19 40 A.
Their Fahrenheit scaling is A * 9 / 5 - 40; converted to Celsius, A - 40.
Source: https://www.scangauge.com/support/x-gauge-commands/gm/

These generic GM definitions are candidates, not proof of support on this Camaro.
The app requires a freshly read matching Camaro LLT/year VIN, identified 11-bit
500 kbit/s CAN, explicit parked/automatic confirmation and an exact fresh
zero-speed response before each candidate. The VIN check does not identify the
transmission; automatic transmission is confirmed by the operator.

The two fixed headers are tried once each. No scans of arbitrary addresses or
identifier ranges, writes, code clearing, actuator commands, security access or
session changes are used. Multiple, truncated, mismatched and negative packets
never become a temperature. No response becomes zero. Temperatures are labeled
candidate test samples and displayed in Fahrenheit and Celsius.

Header selection, speed check, read and restoration are serialized with the same
command mutex used by engine polling. Restoration to 7DF runs even on coroutine
cancellation. A failed restoration closes the adapter transport so normal reads
cannot resume with the wrong destination. This does not revoke Fleet AI pairing.

## ABS research, 2026-11-19

The OBDb Camaro catalog includes experimental wheel-speed definitions at 760 and
another extended-address family. Its default catalog spans model years and uses
debug/year filters. Neither source inspection nor the presence of a definition
proves compatibility with this particular 2010 EBCM. No OBDb definitions have
been copied into the production profile or enabled by this change.
Research lead: https://github.com/OBDb/Chevrolet-Camaro/blob/main/signalsets/v3/default.json

GM bulletin 17-NA-047 includes 2010-2015 Camaro and describes wheel-speed-related
ABS/traction symptoms; some listed symptoms may occur without recorded DTCs.
It is not a wire-protocol reference and does not establish the cause of this car's
pulling/jerking. It must not be used to infer that no generic codes means healthy
brakes. Primary GM bulletin hosted by NHTSA:
https://static.nhtsa.gov/odi/tsbs/2017/MC-10116633-9999.pdf

Next evidence needed: a licensed/documented EBCM request/response definition for
the exact controller, or an authorized read-only capture from a known-capable
tool, with response ECU identity, payload layout, units and reference values.
Keep ABS reads disabled until that evidence is available. Any mechanical pulling
or unintended braking needs inspection independently of software experiments.

## Verification boundary

Unit tests cover VIN/protocol gates, speed gating, response decoding, restricted
commands, negative/malformed replies, transport exceptions, cancellation and
restoration failures. Hardware support and physical measurements still require
the parked-car test. Building an APK does not publish it to Railway or Google Play.

Local verification: 99 Android unit tests (10 new transmission-test tests), 73
driver API contract assertions and 10 pairing-bootstrap tests passed. APK package
is com.fleetai.driver, versionCode 22; signing certificate SHA-256 matches the
existing pilot (68a54f1c5447ac1bcb07263c9ffeb9293e950694ab7619e6835d215cf3d70ac0).
No physical tablet installation or vehicle response has been verified yet.
