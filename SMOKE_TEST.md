# Smoke Test Checklist (Deep Rebuild)

## Server startup
1. `npm run dev:reset`
2. `npm run dev:start`
3. Confirm log shows: `[AUTH STORE] loaded users >= 3`

## Auth flows
1. Employee login: `POST /api/auth/employee/login`
2. Customer login: `POST /api/auth/customer/login`
3. Ensure correct error codes:
   - `USER_NOT_FOUND` only when missing
   - `INVALID_CREDENTIALS` on wrong password

## Routes
1. Pairing/claim routes respond:
   - `POST /api/pairings/claim`
   - `POST /api/pairing/claim`

## Driver app
1. `cd driver_app`
2. `./gradlew :app:assembleDebug`
