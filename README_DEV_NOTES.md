# Fleet AI Route Map (Dev Notes)

## Frontend Pages
- / (index.html)
- /product.html
- /pricing.html
- /pilot.html
- /security.html
- /about.html
- /request-demo.html
- /customer-login.html (org admin / fleet manager login)
- /employee-login.html
- /employee-portal.html
- /admin/setup.html
- /ui/fleetai-dashboard.html
- /ui/settings/set-password.html
- /org/reset-password.html
- /ui/driver-tablet.html
- /signup.html (invite acceptance)
- /legal/privacy.html
- /legal/terms.html
- /login.html (legacy customer alias; keep only as compatibility page/redirect, do not build new auth logic here)

## Auth / Server Quarantine Markers

Canonical paths to actively use:
- Server entrypoint: `/server.js`
- Customer login page: `/customer-login.html`
- Employee login page: `/employee-login.html`
- Customer auth routes: `/api/auth/org/login` and `/api/auth/customer/login`
- Employee auth route: `/api/auth/employee/login`
- First-login password setup: `/api/auth/set-password` with `/ui/settings/set-password.html`

Quarantine / legacy paths that should not become sources of truth again:
- `/server/server.js` — deprecated hard-stop file from the old split server path
- `/login.html` + `/js/auth.js` — legacy generic login flow; treat as compatibility-only, not the canonical customer auth UI
- localStorage bearer-token patterns in frontend code (`fleetai_customer_token`, `fleetai_employee_token`) — legacy compatibility artifacts; browser auth should converge on same-origin cookie sessions

Rule of thumb:
- If auth behavior is being changed, start in `/server.js`, `server/routes/authRoutes.js`, `server/auth/authService.js`, and the dedicated login pages/scripts — not in deprecated aliases or token-era compatibility code.

## API Endpoints (Primary)
Auth
- POST /api/employee/login
- POST /api/employee/logout
- GET /api/employee/session
- POST /api/auth/org/login (alias: /api/auth/customer/login)
- POST /api/auth/org/reset-password
- POST /api/auth/password/update
- POST /api/auth/customer/logout
- GET /api/me

Organizations / Employees / Leads
- GET /api/orgs
- POST /api/orgs
- PATCH /api/orgs/:orgId
- DELETE /api/orgs/:orgId (soft delete)
- POST /api/orgs/:orgId/restore
- GET /api/orgs/:orgId/public-profile
- POST /api/orgs/:orgId/customer/create
- POST /api/orgs/:orgId/customer/reset-password
- GET /api/employees
- POST /api/employees
- GET /api/leads
- POST /api/leads
- POST /api/leads/request-demo
- POST /api/leads/pilot-apply
- PATCH /api/leads/:leadId
- POST /api/leads/:leadId/convert
- GET /api/invites
- POST /api/invites
- GET /api/invites/:token
- POST /api/invites/:token/accept
- GET /api/audit
- GET /api/overview

Fleet / Maintenance
- GET /api/vehicles
- POST /api/vehicles
- PATCH /api/vehicles/:id
- GET /api/drivers
- POST /api/drivers
- GET /api/maintenance-logs
- POST /api/maintenance-logs
- DELETE /api/maintenance-logs/:id
- GET /api/maintenance
- POST /api/maintenance

Pairing / Driver
- POST /api/pairings/generate
- POST /api/pairings/claim
- GET /api/pairings/active
- POST /auth/driverLogin

Telemetry / Alerts
- GET /api/telemetry
- POST /api/telemetry/ingest
- GET /api/telemetry/latest
- GET /api/telemetry/history
- GET /api/telemetry/window
- GET /api/telemetry/summary
- GET /api/alerts
- GET /api/vehicles/:id/metrics/history
- GET /api/vehicles/:id/dtc-history
- GET /api/fuel/events
- GET /api/ml/state
- GET /api/ml/alerts
- GET /api/predictive/recommendations

AI Advisor
- GET /api/advisor/status
- POST /api/advisor/message
- POST /api/ai/advisor
- POST /api/ai/log-maintenance
- POST /api/ai/chat (driver tablet)

Diagnostics
- GET /api/diagnostics
- GET /api/diagnostics/routes

## Frontend -> API Mapping
Public site (request-demo.html, pilot.html, index.html)
- POST /api/leads/request-demo
- POST /api/leads/pilot-apply

Customer login (customer-login.html)
- POST /api/auth/org/login (alias: /api/auth/customer/login)

Force reset / set password (/org/reset-password.html, /ui/settings/set-password.html)
- POST /api/auth/org/reset-password
- POST /api/auth/password/update
- GET /api/me

Employee portal (employee-portal.html)
- GET /api/employee/session
- GET /api/overview
- GET /api/audit
- GET /api/orgs
- POST /api/orgs
- PATCH /api/orgs/:orgId
- DELETE /api/orgs/:orgId
- POST /api/orgs/:orgId/restore
- POST /api/orgs/:orgId/customer/create
- POST /api/orgs/:orgId/customer/reset-password
- GET /api/leads
- PATCH /api/leads/:leadId
- POST /api/leads/:leadId/convert
- GET /api/invites
- POST /api/invites
- GET /api/employees
- POST /api/employees
- GET /api/diagnostics
- GET /api/health

Fleet manager dashboard (/ui/fleetai-dashboard.html)
- GET /api/me
- GET /api/orgs/:orgId/public-profile
- GET /api/vehicles
- GET /api/drivers
- GET /api/alerts
- GET /api/telemetry
- GET /api/telemetry/latest
- GET /api/telemetry/history
- GET /api/telemetry/window
- GET /api/telemetry/summary
- GET /api/vehicles/:id/metrics/history
- GET /api/vehicles/:id/dtc-history
- GET /api/fuel/events
- GET /api/maintenance-logs
- POST /api/maintenance-logs
- GET /api/ml/state
- GET /api/ml/alerts
- GET /api/predictive/recommendations
- POST /api/pairings/generate
- POST /api/pairings/claim
- GET /api/pairings/active
- POST /api/ai/advisor
- GET /api/advisor/status
- POST /api/ai/log-maintenance
- GET /api/fleet/addons
- POST /api/fleet/addons/request-quote

Driver tablet (/ui/driver-tablet.html)
- POST /auth/driverLogin
- POST /api/pairings/claim
- POST /api/ai/chat

Notes
- Full runtime route list: GET /api/diagnostics/routes
- Base API URL is centralized in /js/config.js via window.apiUrl().
