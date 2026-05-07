# Fleet AI Launch Readiness

## Web SaaS launch check

Run from the repository root on Windows:

```powershell
npm.cmd run launch:check
```

This runs the non-mutating launch guardrails:
- JSON storage validation
- API/static/UI contract preflight
- dashboard structure smoke check
- pairing UI contract check
- browser-facing hardcoded host scan
- HTML link and inline handler audit

For the HTTP smoke test, start the server first, or point the smoke script at a temporary server:

```powershell
$env:FLEETAI_BASE_URL="http://127.0.0.1:3000"
npm.cmd run smoke
```

Set `FLEETAI_SMOKE_EMAIL` and `FLEETAI_SMOKE_PASSWORD` to include credentialed customer login plus pairing generation in the smoke flow.
Set `FLEETAI_SMOKE_CREATE_FIXTURES=1` when the target store has no vehicles or drivers; this creates deterministic smoke fixtures before pairing generation.

## Production defaults

Required production environment:
- `NODE_ENV=production`
- `FLEETAI_SESSION_SECRET` set to a strong 32+ character value
- `FLEETAI_SETUP_KEY` set only during initial bootstrap, then rotated or disabled operationally
- `DEV_SETUP=false`, `DEV_SETUP_MODE=false`, `DEV_SETUP_RESET_PASSWORDS=false`
- `COOKIE_SECURE=true` when serving over HTTPS or when `COOKIE_SAMESITE=None`
- `TRUST_PROXY` configured for the deployment proxy
- `CORS_ALLOWED_ORIGINS` set when browser access is expected from a different origin

Runtime state lives under the managed server state paths. Do not commit local `.env`, session, SQLite, or JSON backup files.
