# Fleet AI System Spec (Baseline Snapshot)

Date: 2026-01-27
Scope: Documentation-only guardrails. No runtime behavior changes.

## Backend Entrypoint
- server.js (Express app)

## Health Endpoints
- GET /health
- GET /api/health

## Telemetry Endpoints (Observed)
- POST /api/telemetry/ingest
- GET /api/telemetry
- GET /api/telemetry/latest
- GET /api/telemetry/stream (SSE)
- GET /api/telemetry/active
- GET /api/telemetry/health

## Pairing Endpoints (Observed)
- GET /api/pairing/health
- GET /api/pairings/health
- GET /api/pairing/options
- POST /api/pairing/generate
- POST /api/pairings/generate
- POST /api/pairing/claim
- POST /api/pairings/claim
- POST /api/pairings/claim-device
- GET /api/pairings/active

## Auth Endpoints (Observed)
- POST /api/auth/customer/login
- POST /api/auth/employee/login
- GET  /api/auth/whoami
- GET  /api/auth/customer/session
- POST /api/auth/reset-password
- POST /api/auth/password/update
- GET  /api/employee/session
- POST /api/employee/logout

## UI Entry Points
- /index.html
- /login.html
- /customer-login.html
- /employee-login.html
- /employee-portal.html
- /ui/fleetai-dashboard.html
- /ui/driver-tablet.html
- /ui/settings/set-password.html
- /ui/force-reset.html
- /admin/setup.html
- /org/reset-password.html
- /app/dashboard.html
- /app/settings.html
- /app/billing.html
- /about.html /product.html /pricing.html /request-demo.html /pilot.html /signup.html /security.html /privacy.html /terms.html
- /legal/privacy.html /legal/terms.html

## Static Asset Roots
- /ui
- /js
- /css
- /assets
- /public
- /admin
- /app
- /legal
- /org

## Guardrails (Never regress)
- Login must not break for employee or customer.
- NAV must remain clickable; no overlay blocks clicks.
- Pairing dropdowns must populate without requiring a create action.
- Telemetry must never be mocked or fabricated.
