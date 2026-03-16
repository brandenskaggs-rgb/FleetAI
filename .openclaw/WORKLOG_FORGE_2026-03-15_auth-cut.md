# Forge work log — 2026-03-15 auth cut

## Goal
Make the smallest safe browser auth cleanup tonight without overwriting unrelated in-flight UI work.

## What I changed
- Stopped customer web login clients from persisting session tokens in `localStorage`:
  - `js/customer-login.js`
  - `js/auth.js`
- Stopped employee web login client from persisting session tokens in `localStorage`:
  - `public/js/employee-login.js`
- Converted employee console browser auth usage to cookie-first:
  - removed stored bearer-token lookup/injection from `js/admin-portal.js`
  - clear legacy employee token keys on boot/reset/logout
  - keep logout request credentialed with cookies
- Converted customer dashboard browser API usage to cookie-first:
  - removed stored customer-token lookup/injection from `ui/fleetai-dashboard.html`
  - clear legacy customer token key on load
- Updated employee portal bootstrap debug UI so it no longer reports local token presence as the browser auth source:
  - `employee-portal.html`
- Documented the browser token fallback issue and cookie-first direction:
  - `docs/auth-audit.md`

## Checks run
- `node --check js/customer-login.js`
- `node --check public/js/employee-login.js`
- `node --check js/auth.js`
- `node --check js/admin-portal.js`
- `npm run check:dashboard`

## Notes
- I deliberately did **not** rewrite server auth responses tonight; server login routes may still include token fields for compatibility, but the touched browser web flows no longer persist or reuse them.
- I left unrelated pre-existing working tree changes alone.
