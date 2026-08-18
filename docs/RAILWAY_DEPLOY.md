# Fleet AI — Railway.app Deployment Checklist

## Architecture on Railway

| Component | How it runs |
|-----------|-------------|
| Node.js server | Railway web service (auto-detected from `package.json`) |
| PostgreSQL | Railway Postgres plugin — provisions `DATABASE_URL` automatically |
| Python ML service | Not deployed to Railway; runs locally or on a separate host |

---

## Step 1 — Create the Railway project

1. Push this repo to GitHub.
2. In Railway: **New Project → Deploy from GitHub repo → select `Fleet AI`**.
3. Railway detects `Procfile` and uses it as the start command:
   ```
   web: npx prisma migrate deploy && node server.js
   ```
4. Add a **Postgres** plugin. Railway injects `DATABASE_URL` automatically in the format:
   ```
   postgresql://USER:PASSWORD@HOST.railway.internal:5432/railway?sslmode=require
   ```
   This is fully compatible with Prisma's `postgresql` provider — no extra config needed.

---

## Step 2 — Environment variables

Set these in **Railway → Settings → Variables**. Never commit them to the repository.

### Required

| Variable | Example / Notes |
|----------|-----------------|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | Auto-injected by Railway Postgres plugin |
| `FLEETAI_SESSION_SECRET` | 32+ random characters (use `openssl rand -hex 32`) |

### Bootstrap (first deploy only)

| Variable | Example / Notes |
|----------|-----------------|
| `FLEETAI_SETUP_KEY` | One-time key used to create the first admin account |
| `FLEETAI_ALLOW_SETUP` | `true` during initial bootstrap; set to `false` immediately after |

> **After the first admin is created:** set `FLEETAI_ALLOW_SETUP=false` and remove or rotate `FLEETAI_SETUP_KEY`.

### Security hardening

| Variable | Recommended value |
|----------|--------------------|
| `DEV_SETUP` | `false` |
| `DEV_SETUP_MODE` | `false` |
| `DEV_SETUP_RESET_PASSWORDS` | `false` |
| `COOKIE_SECURE` | `true` |
| `COOKIE_SAMESITE` | `Lax` |
| `TRUST_PROXY` | `loopback, linklocal, uniquelocal` |
| `CORS_ALLOWED_ORIGINS` | `https://your-railway-app.up.railway.app` (or custom domain) |

### Optional services

| Variable | Default | Notes |
|----------|---------|-------|
| `AI_ENABLED` | `false` | Set `true` to enable Advisor chat and AI report narratives |
| `AI_PROVIDER` | `groq` | Advisor provider; `groq` is preferred when `GROQ_API_KEY` is configured |
| `GROQ_API_KEY` | — | Required for Groq Advisor chat and AI report narratives |
| `GROQ_MODEL` | `openai/gpt-oss-120b` | Groq production model; replaces retired Llama 3.3 defaults |
| `OPENAI_API_KEY` | — | Optional when deliberately using `AI_PROVIDER=openai` |
| `OPENAI_MODEL` | `gpt-4o-mini` | OpenAI provider override |
| `OPENAI_EXPLANATIONS_ENABLED` | `false` | Enables separate OpenAI ML explanations when configured |
| `ALERTS_ENABLED` | `true` | In-app alert generation |
| `FLEETAI_PYTHON_ML_ENABLED` | `false` | Set `true` only if ML service is reachable |
| `FLEETAI_ML_SERVICE_URL` | `http://127.0.0.1:8010` | External ML service URL if enabled |

### Railway-managed (do not set manually)

| Variable | Source |
|----------|--------|
| `DATABASE_URL` | Injected by Postgres plugin |
| `PORT` | Injected by Railway (server reads `process.env.PORT`) |
| `HOST` | Set to `0.0.0.0` in `.env.example`; Railway routes to this automatically |

---

## Step 3 — Prisma schema compatibility

Railway's Postgres plugin provides a `postgresql://` connection string.

The `prisma/schema.prisma` datasource block uses:
```prisma
datasource db {
  provider = "postgresql"
}
```

The URL is read from `prisma.config.ts` via `process.env["DATABASE_URL"]` — no manual schema edits required.

The `Procfile` runs `npx prisma migrate deploy` before `node server.js` on every deploy, applying pending migrations automatically.

---

## Step 4 — First deploy verification

After Railway builds and starts the service:

```bash
# Replace with your Railway-assigned URL
curl https://your-app.up.railway.app/api/health
```

Expected response:
```json
{
  "success": true,
  "status": "ok",
  "db": "connected",
  "uptime": 12.3,
  "version": "1.0.0"
}
```

If `db` is `"error"`: check that the Postgres plugin is attached and `DATABASE_URL` is injected in Variables.

---

## Step 5 — Bootstrap the first admin

1. Ensure `FLEETAI_ALLOW_SETUP=true` and `FLEETAI_SETUP_KEY=<your-key>` are set.
2. POST to the setup endpoint with your key to create the initial admin account.
3. Log in and verify admin access.
4. Set `FLEETAI_ALLOW_SETUP=false` in Railway Variables and **redeploy** (or trigger a restart) to lock setup down.

---

## Step 6 — Post-deploy checklist

- [ ] `GET /api/health` returns `{"db":"connected"}`
- [ ] `NODE_ENV=production` confirmed in Railway Variables
- [ ] `DEV_SETUP=false` and `DEV_SETUP_MODE=false` confirmed
- [ ] `FLEETAI_ALLOW_SETUP=false` after first admin created
- [ ] `COOKIE_SECURE=true` (Railway serves over HTTPS)
- [ ] `CORS_ALLOWED_ORIGINS` set to Railway app URL or custom domain
- [ ] `FLEETAI_SESSION_SECRET` is a unique, 32+ char secret
- [ ] No `ADMIN_PASSWORD`, `EMPLOYEE_PASSWORD`, or `AUTH_DEMO_WHITELIST` variables present
- [ ] Prisma migration log shows no pending migrations (`prisma migrate status`)
- [ ] `/api/admin/api-keys` accessible only by super-admin (returns 401/403 for unauthenticated)

---

## Rollback

Railway keeps previous deployments. To rollback:
1. Railway dashboard → **Deployments** → select previous build → **Redeploy**.
2. If the Prisma migration was destructive, restore the Postgres backup from Railway's database dashboard before redeploying the old image.
