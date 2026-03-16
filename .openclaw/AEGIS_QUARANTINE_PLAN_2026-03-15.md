# Aegis Quarantine Plan — Legacy Auth / Server Paths

Date: 2026-03-15
Branch: `clean-auth-rebuild`
Repo: `/home/brandenskaggs/FleetAI`

## Executive summary

Fleet AI now has a **canonical auth/server path**, but the repo still contains several **legacy or compatibility surfaces** that can mislead future work:

- a deprecated secondary server entrypoint at `server/server.js`
- a legacy generic login page at `login.html` using `js/auth.js`
- multiple auth route aliases for both customer and employee login
- frontend remnants of an older **localStorage bearer-token** model even though the backend is now centered on **cookie-backed server sessions**
- production browser gating in `server.js` that is valid as CSRF mitigation, but easy to misunderstand as a broader "browser authenticity" control

These should be **quarantined by policy and markers**, not broadly rewritten in this pass.

---

## What is canonical right now

### Server / backend source of truth
- `server.js` — canonical application entrypoint
- `server/routes/authRoutes.js` — canonical auth route registration
- `server/auth/authService.js` — canonical auth decision logic

### Canonical login UIs
- `customer-login.html` -> `js/customer-login.js`
- `employee-login.html` -> `public/js/employee-login.js`

### Canonical auth APIs
Customer:
- `POST /api/auth/org/login`
- alias: `POST /api/auth/customer/login`

Employee:
- `POST /api/auth/employee/login`
- aliases exist, but this is the clearest target

Password setup / first login:
- `POST /api/auth/set-password`
- UI: `/ui/settings/set-password.html`

---

## Paths that should be quarantined or clearly marked

## 1) `server/server.js`

### Why it is dangerous
- It contains a **different historical server architecture**:
  - `express-session`
  - sqlite employee auth
  - separate data handling
  - old route shapes and alias logic
- If someone edits this file thinking it is live, they can "fix" auth in the wrong place and create ghost regressions.

### Current status
- Good: it already hard-fails when run directly:
  - `This server entry is deprecated. Use: npm start (node server.js) ...`

### Quarantine action
- Keep it as a **dead compatibility artifact only**.
- Add/retain explicit documentation that **all active server/auth work belongs in root `server.js` and `server/routes/authRoutes.js`**.
- Do **not** remove it in this pass if other branches still reference it historically.

### Risk level
- **High confusion risk**
- **Low runtime risk** only because it exits immediately

---

## 2) `login.html` + `js/auth.js`

### Why it is dangerous
- `server.js` already redirects `/login` and `/login.html` to `/customer-login.html`, which tells us the intended canonical entrypoint is the dedicated customer page.
- But the repo still has a full standalone `login.html` using `js/auth.js`.
- That legacy flow still posts to customer auth and stores local state (`fleetai.user`, `fleetai_customer_token`), which encourages future edits in the wrong UI.

### Specific confusion modes
- Someone may update `login.html` instead of `customer-login.html`
- Someone may update `js/auth.js` instead of `js/customer-login.js`
- Someone may re-introduce `fleetai.user` or localStorage-based gating because this page still normalizes that pattern

### Quarantine action
- Treat `login.html` and `js/auth.js` as **compatibility-only**.
- Mark them in repo docs as **non-canonical**.
- Prefer eventual removal or replacement with a static redirect page once safe.

### Risk level
- **High confusion risk**
- **Medium behavioral risk** if directly opened as a file/page or linked by mistake

---

## 3) Frontend localStorage bearer-token paths

### Where they still appear
Employee side:
- `public/js/employee-login.js` writes:
  - `fleetai_employee_token`
  - `fleetai.employeeToken`
- `js/admin-portal.js` reads those and conditionally sends `Authorization: Bearer ...`

Customer side:
- `js/customer-login.js` writes `fleetai_customer_token`
- `js/auth.js` writes `fleetai_customer_token`
- `ui/fleetai-dashboard.html` reads `fleetai_customer_token` and may send bearer auth headers
- `js/guard.js` gates on `fleetai.user`

### Why it is dangerous
- The backend is already using **opaque server-side sessions with HttpOnly cookies**.
- Keeping browser-visible token logic around creates a false picture that web auth is token-primary.
- Future bugfixes may accidentally preserve or expand this split model.

### Quarantine action
- Explicitly label all localStorage token usage as **legacy compatibility behavior**.
- Do not expand token-based browser auth.
- Future cleanup should remove token writes first, then token reads, then `fleetai.user` gating.

### Risk level
- **High architectural confusion risk**
- **Medium security posture risk** because it preserves token-era habits in the browser

---

## 4) Auth route alias sprawl

### Current state
Customer aliases:
- `/api/auth/org/login`
- `/api/auth/customer/login`
- `/api/auth/login`
- `/api/auth/login-customer`
- `/api/customer/login`

Employee aliases:
- `/api/employee/login`
- `/api/login`
- `/api/employee-login`
- `/api/auth/employee/login`

### Why it is dangerous
- Alias sprawl makes logs, debugging, frontend code, and docs drift apart.
- It increases the chance that two clients are fixed against different aliases and appear inconsistent.

### Quarantine action
- Keep aliases only for compatibility.
- In docs and future code, consistently refer to:
  - customer: `/api/auth/org/login`
  - employee: `/api/auth/employee/login`
- Add comments/docs that other aliases are non-canonical.

### Risk level
- **Medium-to-high confusion risk**
- **Low direct runtime risk** while aliases all target same handlers

---

## 5) "Fake browser gating" / trusted-browser-origin logic in `server.js`

### What it actually is
In `server.js`:
- `isTrustedBrowserOrigin`
- `requireTrustedBrowserOrigin`
- CORS + same-origin/allowed-origin checks for unsafe methods

This is **not real browser attestation**.
It is **origin-based request gating / CSRF mitigation** for browser traffic.

### Why it is dangerous from a maintenance standpoint
- The naming can cause future maintainers to think this proves a request came from a "real browser"
- Someone may rely on it as bot/fake-browser detection, which it is not
- Someone may remove it without understanding it is doing meaningful CSRF reduction

### Quarantine action
- Keep the control, but document it as:
  - **trusted origin enforcement for unsafe browser requests**
  - **CSRF mitigation**, not browser authenticity
- Avoid language like "fake browser blocking" in future docs or code comments

### Risk level
- **Medium conceptual confusion risk**
- **Useful security control** if kept correctly framed

---

## 6) `js/guard.js` local-only auth gating

### Why it is dangerous
- It gates on `localStorage` key `fleetai.user`
- That directly conflicts with cookie-session auth as the authoritative browser state
- It can create phantom login state even if the server session is gone

### Quarantine action
- Mark as legacy and do not extend its usage
- Future removal should happen alongside token/localStorage cleanup

### Risk level
- **Medium confusion risk**
- **Medium UX bug risk**

---

## Recommended quarantine policy

## Immediate policy
1. **All live auth/server edits start in:**
   - `server.js`
   - `server/routes/authRoutes.js`
   - `server/auth/authService.js`
   - `customer-login.html` / `js/customer-login.js`
   - `employee-login.html` / `public/js/employee-login.js`

2. **Do not treat these as sources of truth:**
   - `server/server.js`
   - `login.html`
   - `js/auth.js`
   - `js/guard.js`
   - localStorage token reads/writes

3. **Use canonical route names in docs and new code:**
   - customer: `/api/auth/org/login`
   - employee: `/api/auth/employee/login`

4. **Describe origin checks correctly:**
   - CSRF / trusted-origin enforcement
   - not bot detection, not fake-browser detection, not proof of real browser

---

## Low-risk follow-up actions

These are safe future cleanups, but I did not perform them here because they are beyond a pure quarantine pass:

1. Replace `login.html` with a thin redirect-only page or remove it after confirming no direct links depend on it.
2. Add explicit top-of-file comments in:
   - `js/auth.js`
   - `js/guard.js`
   - `server/server.js`
3. Remove localStorage token writes from login scripts.
4. Remove token reads from dashboard/admin frontend code.
5. Collapse docs and tests onto the canonical route names while preserving aliases temporarily.

---

## Safe repo clarification edit made

I made one **low-risk documentation-only clarification edit** in:
- `README_DEV_NOTES.md`

Added:
- canonical auth/server paths
- explicit quarantine markers for:
  - `server/server.js`
  - `login.html` / `js/auth.js`
  - localStorage token-era compatibility code

This change reduces future mistakes without affecting runtime behavior.

---

## Final assessment

The repo’s biggest auth risk is **not** the active backend path anymore.
It is **operator error caused by legacy surfaces still sitting beside the canonical system**.

The main quarantine targets are:
1. `server/server.js`
2. `login.html` + `js/auth.js`
3. localStorage token compatibility paths
4. auth alias sprawl
5. misframed trusted-origin enforcement

If the team follows the quarantine policy above, future auth work should stop drifting into dead or misleading paths.
