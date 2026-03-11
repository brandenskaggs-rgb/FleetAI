# Fleet AI Deploy Hardening (Debian + Cloudflare Tunnel)

## Target posture

- Debian host
- Fleet AI bound locally on `127.0.0.1:3000`
- Cloudflare Tunnel publishes the app externally
- No direct public exposure of the Node port
- Production cookies enabled and dev/bootstrap helpers disabled

## Required app config

Use the root `.env.example` as the deployment template.

Minimum production settings:

```env
NODE_ENV=production
HOST=127.0.0.1
PORT=3000
FLEETAI_SESSION_SECRET=<long-random-secret>
FLEETAI_SETUP_KEY=<one-time-bootstrap-key>
FLEETAI_ALLOW_SETUP=false
DEV_SETUP=false
DEV_SETUP_MODE=false
DEV_SETUP_RESET_PASSWORDS=false
TRUST_PROXY=loopback, linklocal, uniquelocal
CORS_ALLOWED_ORIGINS=https://your-public-fleet-domain.example
COOKIE_SAMESITE=Lax
COOKIE_SECURE=true
```

## Why these matter

- `HOST=127.0.0.1` keeps the app off the public interface; Cloudflare Tunnel can still reach it locally.
- `TRUST_PROXY=loopback, linklocal, uniquelocal` trusts only local proxy hops by default instead of blindly trusting any forwarded header.
- `CORS_ALLOWED_ORIGINS` prevents credentialed browser requests from arbitrary origins.
- Unsafe browser requests now require a trusted `Origin` in production, reducing CSRF risk for cookie-authenticated flows.
- Employee session auth no longer accepts URL query tokens or auto-promotes bearer tokens into cookies, reducing session hijack risk from leaked links or headers.
- `FLEETAI_SESSION_SECRET` is mandatory in production; startup now refuses weak/missing values.
- `DEV_SETUP*` must stay off in production; startup now refuses unsafe production config.

## Cloudflare Tunnel notes

Recommended tunnel mapping:

- Public hostname -> `http://127.0.0.1:3000`

Do **not** expose Fleet AI by opening port 3000 to the internet if Cloudflare Tunnel is the chosen ingress path.

## After bootstrap

After the first real admin exists:

- remove any bootstrap/demo password env vars
- rotate `FLEETAI_SETUP_KEY` out if it is no longer needed
- keep `FLEETAI_ALLOW_SETUP=false`

## Verification

From the Debian host after deploy:

```bash
curl -I http://127.0.0.1:3000/health
curl -I https://your-public-fleet-domain.example/health
```

Expected:

- local health endpoint responds
- public endpoint responds through Cloudflare
- no direct public port 3000 exposure
- app starts without production-config refusal
