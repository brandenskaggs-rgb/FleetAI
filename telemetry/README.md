# Fleet AI Telemetry (Standards Only)

This telemetry stack supports **SAE J1979 (OBD-II)** and **SAE J1939 (heavy-duty)** decoding using open standards only. It is dongle-agnostic and does **not** include OEM-proprietary or licensed data.

## Supported Standards
- **SAE J1979 (OBD-II)**: Mode 01 (live PIDs), Mode 03 (stored DTCs), Mode 07 (pending DTCs), Mode 09 (VIN)
- **SAE J1939**: 29-bit CAN, PGN/SPN decoding, TP.CM/TP.DT multi-packet support

## What Fleet AI Does Decode
The system decodes a **minimum pilot-critical set** of J1939 PGNs and SPNs:
- PGN 61444 (EEC1): SPN 190, 512, 513
- PGN 65262 (Engine Temp 1): SPN 110, 174
- PGN 65263 (Engine Fluid Level/Pressure): SPN 94, 100, 101
- PGN 65265 (Vehicle Speed): SPN 84
- PGN 65269 (Ambient Conditions): SPN 171, 108
- PGN 65266 (Fuel Economy): SPN 183, 184
- PGN 65257 (Electrical Power): SPN 168
- PGN 65270 (Exhaust Temp): SPN 173
- PGN 65259 (Engine Hours): SPN 247
- PGN 65260 (Vehicle Distance): SPN 245
- PGN 65226 (Active DTCs), PGN 65227 (Previously Active DTCs)

## What Fleet AI Does NOT Decode
- OEM proprietary PGNs/SPNs
- Licensed or paywalled manufacturer data
- Brand-specific ECU signals outside SAE standards

## Normalized Telemetry Schema
Fleet AI consumes **only** the normalized schema:
```
telemetry = {
  vehicleId,
  deviceId,
  vehicleClass: "light" | "heavy",
  timestamp,
  engine: {
    rpm,
    torqueDemandPct,
    torqueActualPct,
    coolantTempC,
    oilPressureKpa,
    oilTempC,
    exhaustTempC,
    engineHours
  },
  vehicle: {
    speedKph,
    distanceKm
  },
  fuel: {
    rateLph,
    economyKmpl,
    fuelTempC
  },
  electrical: {
    batteryVoltage
  },
  environment: {
    ambientTempC,
    barometricPressureKpa
  },
  diagnostics: {
    activeDTCs,
    previousDTCs
  },
  meta: {
    supportedStandards: ["J1939"],
    busHealth,
    confidenceScore
  }
}
```

## Replay Harness
Capture raw frames to JSON and replay them for decoding verification:
```
node telemetry/replayHarness.js ./frames.json ./decoded.json
```
Each frame is expected to be:
```
{ "id": 419364343, "data": [8, 0, 255, 20, 0, 0, 0, 0], "ts": "2026-01-01T00:00:00Z" }
```

## Adding New PGNs/SPNs
1) Add entries in `standards/j1939/pgnCatalog.js` and `spnCatalog.js`.
2) Ensure scaling, offset, and unit are correct.
3) Map new SPNs to the normalized schema inside `adapters/J1939Adapter.js`.

## Legal Boundary
All decoding in this repository is **standards-based only**. No OEM proprietary data, licensed databases, or protected signals are used.
