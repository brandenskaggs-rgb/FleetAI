# Watchdog Spec

## Purpose
Non-invasive health checks to detect regressions early. Never blocks or mutates data.

## Checks
- GET /health
- GET /api/health
- GET /api/pairing/health
- GET /api/telemetry/health
- GET /api/system/telemetry/status (if present)
- GET /api/system/pairing/status (if present)

## Behavior
- Runs every 10s (default)
- 2s timeout per check
- Writes to /server/logs/watchdog.log
- Maintains in-memory state

## Must NOT do
- No auth changes
- No data writes
- No retries that block server startup
- No throwing uncaught exceptions
