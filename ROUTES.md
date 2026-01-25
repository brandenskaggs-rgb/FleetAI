# Fleet AI Route Map

## Server Entry Points
- Primary server: `server.js` (Express, serves static UI + API)
- Legacy server: `server/server.js` (not used by `npm start`)

## UI Routes (GET)
- `/` -> `index.html` (server.js)
- `/index.html` -> `index.html` (static)
- `/product.html` -> `product.html` (static)
- `/pricing.html` -> `pricing.html` (static)
- `/pilot.html` -> `pilot.html` (static)
- `/security.html` -> `security.html` (static)
- `/about.html` -> `about.html` (static)
- `/request-demo.html` -> `request-demo.html` (static)
- `/login.html` -> `login.html` (static)
- `/customer-login.html` -> `customer-login.html` (static)
- `/signup.html` -> `signup.html` (static)
- `/employee-login.html` -> `employee-login.html` (static)
- `/employee-portal.html` -> `employee-portal.html` (server.js, employee session required)
- `/admin/setup.html` -> `admin/setup.html` (static)
- `/admin/setup` -> redirect to `/admin/setup.html`
- `/privacy.html` -> redirect to `/legal/privacy.html`
- `/terms.html` -> redirect to `/legal/terms.html`
- `/legal/privacy.html` -> `legal/privacy.html`
- `/legal/terms.html` -> `legal/terms.html`
- `/ui/fleetai-dashboard.html` -> `ui/fleetai-dashboard.html` (static)
- `/ui/driver-tablet.html` -> `ui/driver-tablet.html` (static)
- `/ui/force-reset.html` -> `ui/force-reset.html` (static)
- `/app/dashboard.html` -> `app/dashboard.html` (static)
- `/app/billing.html` -> `app/billing.html` (static)
- `/app/settings.html` -> `app/settings.html` (static)

## API Routes (prefix `/api`)
All API routes are implemented in `server.js` unless otherwise noted.

### Health + Diagnostics
- `GET /api/health` -> `{ ok, service, time, version }`
- `GET /api/diagnostics` -> `{ ok, service, time, version, baseUrl, env, modules, routes:[{method,path,available}] }`
- `GET /api/debug/routes` -> `{ cwd, dirname, port, routes:[{method,path}] }`

### Employee Auth + Session
- `POST /api/employee/login` -> `{ ok, token?, employee }`
- `POST /api/employee/logout` -> `{ ok:true }`
- `GET /api/employee/session` -> `{ employee:{ id,email,role } }`
- `GET /api/auth/session` -> `{ authenticated:true, user:{ id,email,role } }`

### Customer Auth + Session
- `POST /api/auth/login` -> `{ ok:true, user:{ id,email,role,orgId,displayName }, mustResetPassword, redirectTo }`
- `POST /api/auth/reset-password` -> `{ ok:true, redirectTo }`
- `POST /api/auth/customer/logout` -> `{ ok:true }`
- `GET /api/me` -> `{ ok:true, user:{ id,email,role,orgId,displayName }, resetRequired }`

### Admin Setup
- `GET /api/admin/setup/status` -> `{ enabled, hasSuperAdmin, reason }`
- `POST /api/admin/setup` -> `{ ok:true, user }`
- `POST /api/setup/create-super-admin` -> alias

### Organizations
- `GET /api/orgs` -> `{ ok:true, data:[Org] }`
- `POST /api/orgs` -> `{ ok:true, data:Org }`
- `GET /api/orgs/:orgId` -> `{ ok:true, data:Org }`
- `PATCH /api/orgs/:orgId` -> `{ ok:true, data:Org }`
- `POST /api/orgs/:orgId/create-customer-login` -> `{ ok:true, data:{ email, tempPassword } }`
- `POST /api/orgs/:orgId/customer/reset-password` -> `{ ok:true, data:{ email, tempPassword } }`
- `GET /api/orgs/:orgId/public-profile` -> `{ ok:true, data:{ orgId, name } }`

### Leads
- `POST /api/leads` -> `{ ok:true, data:Lead }`
- `POST /api/leads/request-demo` -> `{ ok:true, data:Lead }`
- `POST /api/leads/pilot-apply` -> `{ ok:true, data:Lead }`
- `GET /api/leads` -> `{ ok:true, data:[Lead] }`
- `GET /api/leads/:leadId` -> `{ ok:true, data:Lead }`
- `PATCH /api/leads/:leadId` -> `{ ok:true, data:Lead }`
- `POST /api/leads/:leadId/convert` -> `{ ok:true, data:{ lead, org } }`

### Employees
- `GET /api/employees` -> `{ ok:true, data:[Employee] }`
- `POST /api/employees` -> `{ ok:true, data:{ email, role, tempPassword } }`

### Invites
- `GET /api/invites` -> `{ ok:true, data:[Invite] }`
- `POST /api/invites` -> `{ ok:true, data:Invite }`
- `GET /api/invites/:token` -> `{ ok:true, data:Invite }`
- `POST /api/invites/:token/accept` -> `{ ok:true, data:{ userId, role } }`

### Billing (stub)
- `GET /api/billing/settings` -> `{ ok:true, data:BillingSettings }`
- `POST /api/billing/settings` -> `{ ok:true, data:BillingSettings }`
- `GET /api/billing/payment-method` -> `{ ok:true, data:PaymentMethod }`
- `POST /api/billing/payment-method` -> `{ ok:true, data:PaymentMethod }`

### Feature Flags
- `GET /api/orgs/:orgId/feature-flags` -> `{ ok:true, data:FeatureFlags }`
- `PATCH /api/orgs/:orgId/feature-flags` -> `{ ok:true, data:FeatureFlags }`

### Vehicles / Drivers / Pairings
- `GET /api/vehicles` -> `[Vehicle]`
- `POST /api/vehicles/create` -> `Vehicle`
- `POST /api/vehicles` -> `{ ok:true, data:Vehicle }`
- `GET /api/vehicles/:id` -> `{ ok:true, data:Vehicle }`
- `GET /api/vehicles/:id/baselines` -> `{ ok:true, data:[VehicleBaseline] }`
- `GET /api/drivers` -> `[Driver]`
- `POST /api/drivers/create` -> `{ driverId }`
- `POST /api/drivers` -> `{ ok:true, data:Driver }`
- `GET /api/drivers/:id` -> `{ ok:true, data:Driver }`
- `POST /api/pairings/generate` -> `{ pairingCode, expiresAt, driverPin, driverPinExpiresAt }`
- `POST /api/pairings/claim` -> `{ vehicleId, driverId, status }`
- `GET /api/pairings/active` -> `[Pairing]`
- `POST /api/pairing/create` -> `{ pairingId, pairingCode, driverPin, expiresAt }`
- `POST /api/pairing/activate` -> `{ ok:true, pairing }`
- `GET /api/pairing/status` -> `{ ok:true, pairing }`

### Driver App Support (stubs)
- `POST /api/auth/driverLogin` -> `{ tenantId, driverId, vehicleId, pairingCode, token, driverName }`
- `POST /api/driver/register-device` -> `{ ok:true, deviceId }`
- `POST /api/driver/trips/start` -> `{ ok:true, trip_id }`
- `POST /api/driver/trips/end` -> `{ ok:true }`
- `POST /api/driver/telemetry` -> `{ received, stored }`
- `GET /api/driver/alerts` -> `[{ id, severity, message, created_at }]`
- `POST /api/driver/alerts/:id/ack` -> `{ acknowledged:true }`
- `GET /api/driver/config` -> `{ ok:true, pairingEnabled }`
- `GET /api/drivers/me` -> `{ ok:true, driver:null }`
- `POST /api/vehicles/select` -> `{ ok:true }`
- `GET /api/logs/hos` -> `{ ok:true, logs:[] }`
- `POST /api/logs/hos` -> `{ ok:true }`
- `POST /api/telemetry/snapshot` -> `{ ok:true }`
- `POST /api/alerts` -> `{ ok:true }`
- `GET /api/vehicle/dtcs` -> `{ dtcs:[] }`

### Advisor + AI
- `GET /api/advisor/status` -> `{ ok:true, enabled, model }`
- `POST /api/advisor/message` -> `{ ok:true, reply, basedOn, nextSteps, confidence }`
- `POST /api/ai/advisor` -> `{ ok:true, reply }`
- `POST /api/ai/log-maintenance` -> `{ ok:true, data:MaintenanceLog }`
- `GET /api/ai/status` -> `{ enabled, reason? }`
- `POST /api/ai/chat` -> `{ reply }`

### Misc / Telemetry
- `GET /api/telemetry` -> `{ vehicle_id, metrics, speed, rpm, coolant_temp, fuel_level, mileage, engine_hours }`
- `POST /api/telemetry/ingest` -> `{ ok:true, stored }`
- `GET /api/telemetry/latest` -> `{ ok:true, data }`
- `GET /api/telemetry/window` -> `{ ok:true, records }`
- `GET /api/telemetry/summary` -> `{ ok:true, summary }`
- `GET /api/vehicles/:id/metrics/latest` -> `{ ok:true, data:TelemetrySnapshot|null }`
- `GET /api/vehicles/:id/metrics/history` -> `{ ok:true, data:[{ ts, value? }] }`
- `GET /api/vehicles/:id/dtc-history` -> `{ ok:true, data:[{ code, ts, protocol }] }`
- `GET /api/fuel/events` -> `{ ok:true, data:[FuelEvent] }`
- `GET /api/tire-risk` -> `204 No Content`
- `GET /api/alerts` -> `[Alert]`
- `POST /api/alerts/:id/ack` -> `{ ok:true, data:Alert }`
- `POST /api/alerts/:id/resolve` -> `{ ok:true, data:Alert }`
- `GET /api/orgs/:orgId/events` -> `{ ok:true, events:[Event] }`
- `GET /api/vehicles/:vehicleId/events` -> `{ ok:true, events:[Event] }`
- `GET /api/orgs/:orgId/notifications` -> `{ ok:true, notifications:[Notification] }`
- `POST /api/notifications/:id/read` -> `{ ok:true }`
- `GET /api/insights/latest` -> `{ insight:null }`
- `POST /api/insights/generate` -> `{ insight:null }`
- `GET /api/fleet/addons` -> `{ ok:true, enabledAddons, trailerCount }`
- `POST /api/fleet/addons` -> `{ ok:true, data:{ enabledAddons, trailerCount, updatedAt } }`
- `POST /api/fleet/addons/request-quote` -> `{ ok:true, data:AddonQuote }`

### Maintenance (Tier 2)
- `GET /api/maintenance` -> `{ ok:true, data:[MaintenanceLog] }`
- `POST /api/maintenance` -> `{ ok:true, data:MaintenanceLog }`
- `PUT /api/maintenance/:id` -> `{ ok:true, data:MaintenanceLog }`
- `DELETE /api/maintenance/:id` -> `{ ok:true }`
- `GET /api/workorders` -> `{ ok:true, data:[WorkOrder] }`
- `POST /api/workorders` -> `{ ok:true, data:WorkOrder }`
- `GET /api/workorders/:id` -> `{ ok:true, data:WorkOrder }`
- `PUT /api/workorders/:id` -> `{ ok:true, data:WorkOrder }`
- `POST /api/workorders/:id/close` -> `{ ok:true, data:WorkOrder }`

### Predictive (Tier 2)
- `GET /api/predictive/recommendations` -> `{ ok:true, data:[Recommendation] }`
- `GET /api/predictive/signals` -> `{ ok:true, data:[TrendSignal] }`
- `GET /api/predictive/baselines` -> `{ ok:true, data:[VehicleBaseline] }`
- `POST /api/predictive/recompute` -> `{ ok:true, vehicleId }`

### Placeholders
- `GET /api/safety/events` -> `{ ok:true, events:[] }`
- `GET /api/compliance/issues` -> `{ ok:true, issues:[] }`
- `GET /api/gps/latest` -> `{ ok:true, data:null }`
- `GET /api/cameras/events` -> `{ ok:true, events:[] }`

### Dev-only (non-production)
- `POST /api/dev/telemetry/simulate` -> `{ ok:true, stored, vehicleId, trend }`

## Data Shapes (summary)
- Org: `{ orgId|id, name, status, primaryContactName, primaryContactEmail, phone?, fleetSizeEstimate?, activeVehicles?, billingPlan?, notes?, createdAt, updatedAt }`
- Lead: `{ leadId|id, companyName, contactName, contactEmail, contactPhone?, fleetSize?, message?, leadType, sourcePage, status, orgId?, internalNotes?, createdAt, updatedAt }`
- Vehicle: `{ vehicleId, unitName, vin, type, createdAt }`
- Driver: `{ driverId, firstName, lastName, phone, createdAt }`
- Pairing: `{ pairingCode, vehicleId, driverId, status, expiresAt, driverPinExpiresAt, deviceId?, deviceLabel?, lastSeen? }`
