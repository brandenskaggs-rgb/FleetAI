# Auth Spec

## Canonical Auth Routes
- POST /api/auth/customer/login
- POST /api/auth/employee/login
- GET  /api/auth/whoami
- GET  /api/auth/customer/session
- POST /api/auth/reset-password
- POST /api/auth/password/update
- GET  /api/employee/session
- POST /api/employee/logout

## Rules
- bcrypt only (no plaintext)
- no auth bypasses
- no user deletion without explicit admin action
