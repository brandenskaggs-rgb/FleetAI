# Fleet AI ELD Hardware Validation Tracks

Status: engineering preparation, September 11, 2026. Neither configuration below
has been established as a complete compliant Fleet AI ELD by this review. Leave
production ELD authorization gates disabled until the evidence supports enabling them.

## Track A: Veepeak OBDCheck BLE+ and passenger car

The owner reports existing successful telemetry collection. Source inspection finds
an ELM-style BLE profile and Classic Bluetooth transport in
`driver_app/app/src/main/java/com/fleetai/driver/obd/ObdConnectionManager.kt`.
That is source evidence, not a new physical test or certification result.

Use this setup for common app behavior: retained pairing after update/reboot,
Bluetooth disconnect/recovery, engine-off versus adapter-disconnected states,
missing readings, offline backlog recovery, timestamps, device location permission,
and synthetic ELD export/transfer tests. Record exact app version, Android version,
adapter firmware and supported PID inventory without committing vehicle identifiers.

Do not infer ELD engine synchronization from RPM alone. Verify the actual source and
availability of VIN, engine power status, vehicle motion, accumulated engine hours
and vehicle miles. Runtime since the last engine start is not lifetime engine hours;
distance calculated from GPS is not automatically an acceptable substitute for ECM
vehicle miles. Record unavailable inputs as unavailable and keep the configuration
out of ELD production authorization until requirements are met.

## Track B: McLane Samsung Galaxy Tab A7 Lite SM-T220 / Motive LBB-3.6CA

These model names come from the owner's photos. The RAM mount and green 9-pin
connector do not establish an Android-accessible engine-data interface.

The current wired transport in
`driver_app/app/src/main/java/com/fleetai/driver/j1939/UsbJ1939Transport.kt`
expects a USB-serial SLCAN/Lawicel interface. It configures 250/500 kbit/s and requests
listen-only mode; it is not an implementation of a Motive-specific local SDK.
USB serial enumeration identifies candidates, not approved CAN devices. Do not
send configuration commands to an unidentified Motive gateway or use its presence
in an enumeration list as proof of support.

The decoder in `j1939/J1939Decoder.kt` has branches for RPM, speed, engine hours,
odometer, VIN and other broadcast PGNs. Decode support does not mean a gateway
exposes those broadcasts or that a truck broadcasts all of them without requests.
The existing code deliberately does not transmit diagnostic CAN requests in this path.

Before connecting, obtain written interface information from the gateway provider:
local third-party API/SDK availability, transport, authentication, supported signals,
update frequency and simultaneous operation with the incumbent ELD. Fleet permission
to install an app does not itself provide access to a proprietary gateway interface.
If no supported local interface exists, use a separately approved interface/harness
with the fleet's maintenance team; do not unplug or modify the active ELD as a test.

## Evidence to retain per configuration

Record pass/fail/not-tested, build identifier, hardware/firmware versions, timestamp,
test operator and a redacted evidence reference for each item:

- Required engine inputs are real, correctly scaled and timestamped, with missingness preserved.
- Shutdown, stopped-idle, loss of connection and loss of network remain distinguishable.
- Reboot/app update preserve authorized pairing; expired/revoked credentials remain rejected.
- Offline and restored-network behavior retains ordered records without duplicates or silent loss.
- Driver assignment, unidentified driving and tenant isolation behave correctly.
- Location and engine synchronization failures produce appropriate diagnostics.
- Duty events, editing history, certification and roadside display match actual records.
- Output authentication and official file validation pass on synthetic test records first.
- Both selected FMCSA transfer methods produce documented test responses.
- Existing ELD operation remains unaffected during approved coexistence testing.

No physical tests were performed and no Android sources were modified in this follow-up.
Shared server tests cannot replace either hardware test track or the complete official
FMCSA test plan.
