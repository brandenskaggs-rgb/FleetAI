# Pairing Spec

## Endpoints
- GET  /api/pairing/health
- GET  /api/pairings/health
- GET  /api/pairing/options
- POST /api/pairing/generate
- POST /api/pairings/generate
- POST /api/pairing/claim
- POST /api/pairings/claim
- POST /api/pairings/claim-device
- GET  /api/pairings/active

## Response Shape (minimum)
- /api/pairing/options => { ok: true, vehicles: [], drivers: [] }
- /api/pairing/generate => { ok: true, pairing: { pairingCode, driverPin, vehicleId, driverId } }
