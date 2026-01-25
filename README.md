# Fleet AI - Local Prototype

Run the backend (FastAPI) and open the UI to view mock telemetry.

## Telemetry Standards Support
- SAE J1979 (OBD-II) for light-duty vehicles
- SAE J1939 for heavy-duty Class 7-8 trucks

All decoding is standards-only (no OEM proprietary or licensed signals). See `telemetry/README.md` for the decoder catalog, normalized schema, and replay harness.

## Run Fleet AI Locally

Create venv and install deps:
```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r backend/requirements.txt
```

Start backend (Uvicorn):
```powershell
uvicorn backend.app.main:app --reload --host 0.0.0.0 --port 8000
```

Create a local backend env file for AI insights (optional):
```powershell
Copy-Item -Path backend\.env.example -Destination backend\env.local
# Rename the copied file to the backend's default env filename after editing
```
Local env files are runtime-only and must never be committed.

Restart backend after updating env vars:
```powershell
# Stop the server, then restart:
uvicorn backend.app.main:app --reload --host 0.0.0.0 --port 8000
```

Open the UI (served by backend):
```powershell
start http://127.0.0.1:8000/
```

## Run Node static server + Admin setup

Env:
```
FLEETAI_SETUP_KEY=SkaggsFleetAI-INIT-2026
```
Save the above in the root `.env` (same folder as `package.json`).

Install and start:
```powershell
npm install
npm start
# or PowerShell direct: node .\server.js
```

Open:
- Home: http://localhost:3000/
- Dashboard: http://localhost:3000/ui/fleetai-dashboard.html
- Admin setup: http://localhost:3000/admin/setup.html
- Employee login: http://localhost:3000/employee-login.html

## Field Demo API Server (Required)

Start the shared API server (driver + dashboard):
```powershell
cd server
npm install
npm start
```

The server runs on `http://localhost:3000` and persists to `server/data.json`.

## Dashboard (Standalone)

Serve the operator dashboard with a local web server to avoid `file://` CORS errors:
```powershell
cd ui
python -m http.server 8000
```

Then open:
```powershell
start http://localhost:8000/ui/fleetai-dashboard.html
```

Set API base URL (dashboard):
- `ui/fleetai-dashboard.html` -> `API_BASE_URL`
- Laptop browser: `http://localhost:3000`
- Real tablet (hotspot/LAN): `http://<LAPTOP_LAN_IP>:3000`

## Expansion Add-Ons (Dashboard)

Open the dashboard and select **Add-Ons** in the left nav to manage optional expansion modules.

MOCK_MODE behavior:
- State is stored in LocalStorage:
  - `fleet_addons_state_v1` (enabled add-ons)
  - `fleet_trailer_count_v1` (trailer count)
- Quote requests are stored in `fleet_addons_quote_requests_v1`

API endpoints (when MOCK_MODE=false):
- `GET /fleet/addons` (current add-on state + trailer count)
- `POST /fleet/addons` (save add-on state + trailer count)
- `POST /fleet/addons/request-quote` (submit a quote request)

## Driver App API Base URL

Default emulator base URL is `http://10.0.2.2:3000/` in `driver_app/app/build.gradle`.
For a real tablet, change it to `http://<LAPTOP_LAN_IP>:3000/` and rebuild.

## Field Demo Checklist
- API server running (`server/server.js`)
- Dashboard served via `python -m http.server`
- API mode ON (`MOCK_MODE = false`)
- Telemetry shows placeholders until real data arrives
- Create driver -> capture Driver PIN (toast)
- Create vehicle
- Generate pair code
- Tablet login with Company Code + Driver PIN
- Claim pairing code -> verify assignment appears in dashboard

Smoke test (optional):
```powershell
python backend\tools\smoke_test.py
```

Generate sample telemetry (prints JSON):
```powershell
python tools\mock_telemetry\generator.py VEHICLE_001
```

Telemetry endpoint:
- `http://127.0.0.1:8000/api/telemetry?vehicle_id=VEHICLE_001`

Tire risk endpoint:
- `http://127.0.0.1:8000/api/tire-risk?vehicle_id=VEHICLE_001`

## Learning / Optimization Mode (Backend Only)

Fleet AI learns a per-vehicle baseline over a 90-day learning period. During learning:
- Alerts can still be created, but confidence is labeled "low" unless hard safety thresholds are exceeded.
- A learning status endpoint reports days remaining and mode.

After learning:
- Alerts are labeled "medium" or "high" based on deviation from baseline and repetition.

## Two-Layer Intelligence (Backend Only)

Layer 1: Manufacturer / Safety Thresholds (deterministic)
- Immediate alerts for hard safety limits (coolant temp, oil pressure, battery voltage, transmission temp, DPF soot, DEF).
- Always HIGH confidence and does not depend on baseline learning or AI.

Layer 2: Learned Baseline Deviation (proactive)
- Rolling baselines per vehicle metric (mean/variance).
- Alerts require persistence (deviation in multiple points) and use z-score thresholds.
- During learning: confidence stays LOW unless extreme.
- After learning: confidence escalates to MEDIUM/HIGH based on magnitude and persistence.

AI explanations (OpenAI) are explanation-only:
- Detection happens before any AI call.
- AI is called only on explicit request or high-severity alerts with cooldown.
- If AI is disabled/unavailable, a deterministic explanation template is returned.

Activate a vehicle (starts 90-day learning period):
```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8000/api/vehicles/VEHICLE_001/activate -ContentType application/json -Body '{}'
```

Check learning status:
```powershell
Invoke-RestMethod -Method Get -Uri http://127.0.0.1:8000/api/vehicles/VEHICLE_001/learning-status
```

Latest alert:
```powershell
Invoke-RestMethod -Method Get -Uri http://127.0.0.1:8000/api/alerts/latest?vehicle_id=VEHICLE_001
```

Recent alerts (limit 20):
```powershell
Invoke-RestMethod -Method Get -Uri http://127.0.0.1:8000/api/alerts?vehicle_id=VEHICLE_001&limit=20
```

Explain an alert (backend-only):
```powershell
Invoke-RestMethod -Method Get -Uri http://127.0.0.1:8000/api/alerts/ALERT_000001/explain
```

Generate AI insight (backend-only):
```powershell
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8000/api/insights/generate?vehicle_id=VEHICLE_001" -ContentType application/json -Body "{}"
```

Latest AI insight:
```powershell
Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:8000/api/insights/latest?vehicle_id=VEHICLE_001"
```

## Tier Plan (Predictive Maintenance Readiness)

Tier 1 (Now — Demo Ready)
- Get data flowing:
  - vehicles and drivers created
  - pairing works
  - telemetry ingestion works
  - alerts show up
  - AI advisor answers using data
- Basic rules-based alerts (coolant temp high, DTC codes, battery voltage low)

Tier 2 (Next — Training-Ready)
- Add maintenance logs and work orders
- Require fleet managers to record:
  - oil changes
  - repairs
  - part replacements
  - inspections
  - odometer miles / engine hours at time of service
- Link logs to telemetry windows (before vs after repair)
- Enable AI advisor to log maintenance events automatically from chat

Tier 3 (Later — Better Predictions)
- Use telemetry + maintenance logs to train predictive models
- Estimate time to failure and recommended service window
- Add cost modeling and ROI reporting

If you have zero maintenance history right now, that's okay:
1) Start logging maintenance going forward.
2) Backfill only the last 3-6 months if available (optional).
3) Make odometer + engine hours mandatory for every log to improve predictions.

AI status (no secrets):
```powershell
Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:8000/ai/status"
```

Server-side AI only:
- Baseline learning, anomaly detection, and alert confidence are computed in the backend.
- No keys or prompts live in the UI.

Generate a pairing code (field demo server):
```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:3000/pairings/generate -ContentType application/json -Body '{"vehicleId":"VEHICLE_001","driverId":"DRIVER_00001"}'
```

Claim a pairing code (driver tablet):
```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:3000/pairings/claim -ContentType application/json -Body '{"pairingCode":"123456","deviceId":"DEVICE_001","deviceLabel":"Tablet 01"}'
```

Simulate learning and alert generation:
```powershell
python backend\tools\simulate_learning.py
```

