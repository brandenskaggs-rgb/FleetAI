Copilot / AI Agent Instructions — Fleet AI (FastAPI + React)

Purpose
This repo targets a Python FastAPI backend and a React frontend. Agents should make small, testable changes that map directly to the Fleet AI spec.

Core principles
- Preserve an enterprise-style architecture that can scale.
- Never mention competitors or third-party brands in UI, docs, or comments.
- Keep dependencies minimal and justified.

Expected layout (recommended)
- `backend/` — FastAPI app, ingestion, inference stubs, routes, tests
- `ui/` or `frontend/` — React (TypeScript) dashboard
- `tools/mock_telemetry/` — telemetry generator and sample dataset
- `db/schema/` — schema outlines and migration helpers (Alembic)

Quick local setup (Windows)
- Create and activate virtualenv:
```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
```
- Install backend deps:
```powershell
pip install -r backend/requirements.txt
```
- Run backend (dev):
```powershell
uvicorn backend.main:app --reload --port 8000
```
- Frontend (from `ui/`):
```bash
cd ui
npm install
npm run dev
```

API docs
- With backend running, interactive OpenAPI docs should be at `http://127.0.0.1:8000/docs`.

Database & migrations
- Keep schema files under `db/schema/` and use Alembic for migrations (add migrations when models change).

Mock telemetry
- Use `tools/mock_telemetry/generator.py` to produce sample payloads. Post to `http://127.0.0.1:8000/telemetry` to exercise ingestion and websockets.

Testing
- Run backend tests:
```bash
pytest tests/unit
```
- Run frontend tests:
```bash
cd ui && npm test
```

API & code conventions (fast checks)
- API-first: update `api/openapi.yaml` when adding endpoints. Include `tenant_id` and RBAC scopes.
- Real-time: provide websocket/SSE at `/ws/telemetry` or `api/ws/telemetry` for live updates.
- Telemetry model: accept `vehicle_id`, `ts`, `lat`, `lon`, `speed` and optional `engine_hours`, `fuel_level`, `fault_codes` — code must tolerate missing fields.
- Reference spec sections in code comments: `# spec: 2.1 Fleet Overview` or `// spec: 2.8 Predictive Maintenance`.

PR checklist for agents
- Small, focused commits and branch names `feat/<module>-desc`.
- Update `api/openapi.yaml` and backend tests for any API change.
- Add a mock dataset entry under `tools/mock_telemetry/` for integration tests.
- Include brief note in PR linking spec sections and listing assumptions.

When information is missing
- Open an ISSUE with precise questions (DB columns, expected schemas, auth flow) and reference it in the PR.

Maintenance
- Keep this file updated with concrete local commands and CI steps.

— End
Copilot / AI Agent Instructions — Fleet AI

Purpose
This repository contains Fleet AI, an enterprise-grade fleet intelligence platform. The goal is to produce a runnable local prototype with a Python FastAPI backend and a simple web frontend dashboard. AI agents must make safe, minimal, testable changes and keep the codebase structured.

Core Principles
All changes must preserve a professional, enterprise architecture and be suitable for future scale.
Never reference or name competitors or third-party providers in code, comments, UI text, or documentation.
Prefer clarity and correctness over “clever” code.
Do not introduce unnecessary frameworks. Keep dependencies minimal.

Repository Layout (expected)
backend/        Python FastAPI service (API, ingestion, telemetry, alerts)
frontend/       Static web dashboard (HTML/CSS/JS)
docs/           Optional documentation
scripts/        Optional utilities (mock telemetry, seed data)

Runtime Targets
Backend: Python 3.x + FastAPI served via Uvicorn on localhost:8000
Frontend: Static content served via a local HTTP server on localhost:5500
The frontend must call the backend API using fetch() over HTTP.

Commands (local development)
Create venv:
python -m venv .venv

Activate venv (Windows):
.venv\Scripts\activate

Install dependencies:
pip install -r requirements.txt

Run backend (preferred):
uvicorn backend.app.main:app --reload --port 8000

If backend module path differs, update instructions and ensure it runs.

Run frontend (from project root):
python -m http.server 5500

Open:
http://127.0.0.1:5500/

API Documentation
When backend is running, Swagger should be available at:
http://127.0.0.1:8000/docs

Data Model and Telemetry
Telemetry should be accepted as JSON over HTTP and stored or cached for the dashboard.
Mock telemetry generators must be kept separate from production ingestion.
All telemetry fields may be missing; APIs and UI must degrade gracefully.

Security and Secrets
Never hardcode API keys, passwords, or tokens.
Use environment variables for configuration.
Do not commit secrets to the repo.

Change Rules for AI Agents
Before changing code:
- Identify the file and responsibility (backend vs frontend).
- Make the smallest change that achieves the goal.
- Ensure the backend starts and /docs loads.
- Ensure the frontend loads via http.server.

When adding endpoints:
- Update OpenAPI/route docs.
- Return clear JSON responses and appropriate HTTP status codes.
- Add minimal validation to avoid crashes.

When modifying UI:
- Keep UI enterprise clean and minimal.
- No competitor references.
- Ensure API calls match backend endpoints.

Output Expectations
Prefer:
- Working code changes
- Clear file diffs
- Short implementation notes
Avoid:
- Large refactors
- New frameworks without strong justification
- Unused code and placeholder fluff
