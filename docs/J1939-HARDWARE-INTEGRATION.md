# Fleet AI J1939 Hardware Integration

## Supported software contract

Fleet AI's Android acquisition service supports a USB serial CAN interface that implements the documented Lawicel/SLCAN ASCII protocol. The interface must provide:

- CAN 2.0B extended 29-bit frame reception
- 250 and 500 kbit/s bus speeds
- SLCAN `S5` and `S6` bitrate selection
- SLCAN `L` listen-only open mode
- SLCAN `T` extended-frame records
- Android USB host compatibility through FTDI, CP210x, CH34x, PL2303, or CDC-ACM

Fleet AI refuses to capture if the adapter rejects listen-only mode. The launch implementation does not transmit J1939 request messages or control traffic onto the vehicle network.

The tablet defaults to passive bus-speed detection. It listens at 250 kbit/s and then 500 kbit/s, and accepts a speed only after observing valid extended CAN traffic. A technician can force either speed for a known vehicle configuration. An open USB serial port without valid CAN traffic is not reported as a live truck connection.

## Required physical architecture

```text
SAE J1939 diagnostic connector
        |
Vehicle-rated J1939 harness
        |
Isolated, protected CAN/J1939 interface running SLCAN
        |
USB host connection
        |
Managed Android tablet running Fleet AI Driver
        |
TLS cellular or Wi-Fi connection
        |
Fleet AI telemetry ingest and prediction pipeline
```

A passive 9-pin-to-USB cable is not supported. The harness must include a CAN controller and transceiver. Production hardware should also provide galvanic isolation, reverse-polarity and load-dump protection, an automotive operating-temperature rating, secure strain relief, and a connector arrangement approved by the fleet.

The Lawicel CANUSB is useful as a documented bench reference for the SLCAN protocol. Fleet AI should use a rugged, vehicle-rated SLCAN-compatible gateway for road deployment rather than treating a desktop diagnostic adapter as installed fleet hardware.

## Data currently decoded

The tablet and backend decode the following standard broadcast data when the truck publishes it:

| Area | Standard data |
| --- | --- |
| Engine | speed, driver demand torque, actual torque, coolant temperature, oil temperature, oil pressure, oil level |
| Fuel | fuel rate, fuel level, fuel delivery pressure, instantaneous fuel economy |
| Vehicle | wheel-based speed, total distance, trip distance, engine hours |
| Electrical | battery voltage, alternator voltage |
| Environment | ambient temperature, barometric pressure, exhaust temperature |
| Diagnostics | DM1 active SPN/FMI faults, occurrence counts, multi-packet transport |
| Identity | VIN when broadcast through the standard vehicle-identification PGN |

J1939 uses PGNs and SPNs rather than passenger-vehicle PID polling. Availability varies by engine, chassis, body controller, model year, and vehicle configuration. Proprietary OEM PGNs are retained as bounded raw-frame samples but are not assigned engineering units until an authorized definition is added and validated.

## Reliability behavior

- J1939 capture runs in an Android foreground service and is independent of the currently visible screen.
- The service reconnects after USB detach/read failure and rechecks the configured bus speed when valid frames stop for more than seven seconds.
- The tablet displays detected bitrate, connector profile, bytes received, rejected adapter records, reconnect count, upload time, and durable queue depth.
- Raw frames are decoded on the tablet for immediate display and again on the server for verification.
- The server derives PGN, priority, source address, and destination address from the CAN identifier instead of trusting client-supplied labels.
- Repeated high-rate frames are coalesced by CAN identifier between two-second uploads; transport-protocol packets are preserved separately.
- Uploads use unique batch IDs. The server ignores duplicate retries.
- Failed uploads remain in a Room outbox with exponential retry for up to seven days.
- The server validates CAN identifiers, byte lengths, tenant ownership, paired-device ownership, and batch limits before persistence.
- Raw frame retention is bounded to prevent the JSON store from growing without limit.

## Commissioning procedure

1. Confirm the tablet supports Android USB host mode and receives stable power while the interface is attached.
2. Confirm the selected interface implements SLCAN listen-only mode at both required fleet speeds. Record whether the truck uses a black 9-pin, green Type-II 9-pin, or RP1226 connection.
3. Pair the Fleet AI tablet to the correct organization, driver, and vehicle before connecting the truck interface.
4. Connect the approved harness with the ignition off, secure all cabling, then turn the ignition on.
5. Open **Live Telemetry**, select **Connect J1939 interface**, and grant the Android USB permission.
6. Confirm the app reports `J1939 live - listen only` and the CAN-frame counter increases.
7. Compare RPM, coolant temperature, road speed, fuel rate, engine hours, and active faults against an approved diagnostic tool.
8. Verify data continues uploading while navigating away from Live Telemetry and after cellular service is interrupted and restored.
9. Run a controlled drive and compare timestamps and values in the Fleet AI dashboard.
10. Repeat the validation for every engine/chassis family before authorizing fleet-wide installation.

Recorded captures can be replayed through the server decoder with:

```text
npm run test:j1939:replay
```

Replace the fixture path with an approved JSON capture to validate a new truck family without uploading it or requiring a live backend:

```text
node scripts/replay-j1939-capture.js path/to/approved-capture.json
```

## Release boundary

Passing automated tests proves parsing, persistence, ownership enforcement, retry behavior, and APK compilation. It does not prove electrical compatibility with a particular truck or tablet. Road deployment requires one approved hardware model, its exact harness, and validation on representative Freightliner, Volvo, Peterbilt, Kenworth, and International vehicles used by the fleet.

This telemetry path is not, by itself, an FMCSA-registered ELD. Fleet AI must not replace a carrier's legal HOS/ELD system until engine-synchronization diagnostics, malfunction handling, driver records, roadside transfer, certification, and registration have been implemented and independently reviewed.
