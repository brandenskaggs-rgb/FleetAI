# Fleet AI Predictive Maintenance Notes

Summary
- Added universal telemetry storage (time-series records) with retention.
- Implemented deterministic event engine for cooling, charging, and fuel efficiency anomalies.
- Added notification pipeline for fleet managers + drivers with read/ack endpoints.
- Added dev telemetry simulator endpoint to create trend data for demos.
- Dashboard alerts now support detail view and click-through from overview.

Files changed
- server.js
- ui/fleetai-dashboard.html
- ROUTES.md

Manual test checklist
1) npm start
2) Create a vehicle if none exists:
   - POST http://localhost:3000/api/vehicles/create
3) Simulate telemetry to trigger a cooling anomaly:
   - POST http://localhost:3000/api/dev/telemetry/simulate
     Body: { "vehicleId": "VEHICLE_ID", "trend": "coolant_hot", "count": 40 }
4) Open the dashboard and verify alerts + detail panel:
   - http://localhost:3000/ui/fleetai-dashboard.html
5) Check driver alerts (after pairing or with vehicle_id):
   - GET http://localhost:3000/api/driver/alerts?vehicle_id=VEHICLE_ID
6) Acknowledge a driver alert:
   - POST http://localhost:3000/api/driver/alerts/:id/ack
7) Verify events + notifications endpoints:
   - GET http://localhost:3000/api/vehicles/VEHICLE_ID/events
   - GET http://localhost:3000/api/orgs/ORG_ID/notifications
