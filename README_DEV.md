# Fleet AI Dev Connectivity Guide

## Quick LAN checklist (must pass)
1) Start backend: `node server.js`
2) Confirm LAN IP printed in console ("LAN access hint")
3) From tablet Chrome, open: `http://<laptop_ipv4>:3000/health`
   - If this fails, do NOT proceed to app/web routes.

## Windows firewall (required for LAN access)
Run PowerShell as Administrator:
```
Set-ExecutionPolicy Bypass -Scope Process
.\scripts\windows-allow-port-3000.ps1
```
Manual alternative:
- Windows Defender Firewall > Advanced Settings > Inbound Rules > New Rule
- Port > TCP > 3000 > Allow

## Network debug script
```
.\scripts\network-debug.ps1
```
This prints IPv4 addresses and confirms a listener on port 3000.

## Driver app connectivity (no guessing)
1) Ensure tablet is on the same hotspot/Wi-Fi as the laptop.
2) In tablet Chrome, open `http://<laptop_ipv4>:3000/health`.
3) In the driver app, enter base URL (example: `http://172.20.10.8:3000`).
4) Tap "Test Connection" and confirm:
   - Host reachable: yes
   - Port open: yes
   - HTTP /health: yes
5) Only then load the WebView.

## Notes
- Never use 0.0.0.0, localhost, or 127.0.0.1 on the tablet.
- The driver app loads `{baseUrl}/driver_app/`.

## Auth Runbook (dev)
1) Start server: `npm start` or `node server.js`
2) Verify health: `http://<laptop_ipv4>:3000/health` and `http://<laptop_ipv4>:3000/api/active`
   - Optional dev setup: set `DEV_SETUP_MODE=true` (non-production only)
3) List users (dev-only): `node scripts/dev/list-users.js`
4) Reset demo auth (dev-only):
   - `curl -X POST http://localhost:3000/api/dev/reset-auth`
5) Seed demo users (dev-only): `node scripts/seed-demo-users.js`
6) Repair password (dev-only): `node scripts/repair-password.js user@example.com NewPassword123`
7) Verify logins (dev-only):
```
$env:FLEETAI_TEST_CUSTOMER_EMAIL="customer@example.com"
$env:FLEETAI_TEST_CUSTOMER_PASSWORD="Password123"
$env:FLEETAI_TEST_EMPLOYEE_EMAIL="employee@example.com"
$env:FLEETAI_TEST_EMPLOYEE_PASSWORD="Password123"
node scripts/verify-auth.js
```
