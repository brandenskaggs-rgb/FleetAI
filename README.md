# Fleet AI

Predictive fleet maintenance SaaS. Node.js + FastAPI + Android driver app, multi-tenant, Railway-deployed.

## Stack

| Layer | Tech |
|---|---|
| Server | Node.js + Express (`server.js`) |
| Database | PostgreSQL via Prisma 7 + `@prisma/adapter-pg` |
| ML service | Python FastAPI (`backend/`) |
| Driver app | Android / Kotlin (`driver_app/`) |
| Hosting | Railway.app |

The Node.js server serves both the static frontend and all API routes from a single process.

## Run locally

```bash
npm install
npx prisma generate
cp .env.example .env        # fill in DATABASE_URL and session secret
npm start
```

Open: http://localhost:3000

## Environment variables

See [.env.example](.env.example) for the full list. Minimum required:

```
DATABASE_URL=postgresql://...   # Railway Postgres public URL for local dev
FLEETAI_SESSION_SECRET=         # 32+ random chars
NODE_ENV=development
DEV_SETUP=true                  # seeds admin user on first start
```

## Database

```bash
npx prisma migrate deploy       # apply migrations
npx prisma studio               # browse data
```

Schema: [prisma/schema.prisma](prisma/schema.prisma)

## Partner API

External partners (e.g. Motive) authenticate via `X-API-Key` header with a `partner_ml` tier key.

**Provision a partner key:**
```bash
node scripts/provision-partner.js --partner "Motive" --tier partner_ml
```

**Integration docs:** [partner-docs.html](partner-docs.html)

**Test the full webhook flow:**
```bash
node scripts/test-partner-webhooks.js
```

## Python ML service

```bash
cd backend
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8010
```

Set `FLEETAI_PYTHON_ML_ENABLED=true` and `FLEETAI_ML_SERVICE_URL=http://127.0.0.1:8010` to enable.
Falls back to Node.js EWMA model when unavailable.

## Deploy to Railway

See [docs/RAILWAY_DEPLOY.md](docs/RAILWAY_DEPLOY.md) for the full checklist.

Quick version:
1. Push to GitHub — Railway auto-deploys
2. Add Postgres plugin — `DATABASE_URL` is injected automatically
3. Set `FLEETAI_SESSION_SECRET`, `NODE_ENV=production`, `DEV_SETUP=false`
4. Procfile runs `npx prisma migrate deploy && node server.js`

## Key scripts

| Script | Purpose |
|---|---|
| `node scripts/provision-partner.js` | Generate / revoke partner API keys |
| `node scripts/test-partner-webhooks.js` | End-to-end webhook smoke test |
| `node scripts/seed-demo-users.js` | Seed dev users |
| `node scripts/repair-password.js` | Reset a user's password |
| `node scripts/verify-auth.js` | Verify login flows work |

## Project structure

```
server.js                  — Main Express app (routes, middleware, static serving)
server/
  routes/                  — Auth, admin, partner, ML, fleet ops, org management
  services/                — Webhook delivery, AI reports, ML client, OEM ingestion
  middleware/              — API key auth, rate limiting, request logging
  auth/                    — Auth service, Prisma adapter, session management
  db.js                    — Prisma client (pg adapter)
backend/                   — Python FastAPI ML service
  app/ml/                  — Ensemble, stage2, diagnosis, DTC, features
driver_app/                — Android Kotlin OBD driver app
prisma/schema.prisma       — Full database schema
fleet_ai/training/         — ML training and evaluation scripts
docs/                      — Deployment and production readiness docs
scripts/                   — Dev tooling and provisioning
```
