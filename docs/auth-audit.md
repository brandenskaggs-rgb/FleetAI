# Fleet AI Auth Audit

## Canonical employee login client

The canonical browser client for employee login is:
- `/public/js/employee-login.js`

The legacy file:
- `/js/employee.js`

has been converted into a thin compatibility wrapper so the project no longer carries two independent employee login implementations.

## Findings

### 1. Split employee login clients caused drift risk
Previously the repo had two separate employee-login frontend implementations:
- `/public/js/employee-login.js`
- `/js/employee.js`

This created a high risk of inconsistent behavior when one file changed but the active page loaded the other.

### 2. Active login page already used `/public/js/employee-login.js`
`employee-login.html` loads `/public/js/employee-login.js`, so that file is treated as the source of truth.

### 3. Auth debugging is spread across multiple layers
Employee/customer login behavior depends on:
- frontend login client
- auth route handlers
- `authService`
- session/cookie helpers
- bootstrap/dev setup behavior

That makes auth issues harder to diagnose quickly.

### 4. Preflight contract checker is brittle
The current preflight check looks for route strings inside `server.js`, which creates false positives after route modularization.

## Recommended next steps

1. Add a dedicated auth smoke test that verifies:
   - employee login success
   - customer login success
   - invalid credentials
   - user not found
   - password-setup-required flow
   - employee session endpoint
   - customer session endpoint
   - logout

2. Refactor the preflight route check so it validates runtime registration or a route manifest instead of scanning raw strings in `server.js`.

3. Eventually separate auth/session helpers from `server.js` into a dedicated auth/session module.
