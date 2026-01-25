# TODO — Deep Rebuild Auth + Driver App

## A) Auth Store (Single Source of Truth)
- [x] Create `server/authStore.js`
- [x] Load/save `server/data.json` with strict schema validation
- [x] Normalize emails (trim + lowercase)
- [x] Log counts on startup (users, orgs)
- [x] Expose helpers:
  - [x] `findEmployeeByEmail(email)`
  - [x] `findCustomerByEmail(email)`
  - [x] `verifyPassword(hash, plain)`
  - [x] `createUser(...)`
  - [x] `createOrg(...)`
- [x] Fail fast if schema is invalid

## B) Dev Seed Logic (Deterministic)
- [x] Create `server/seed-dev.js`
- [x] Seed when `DEV_SETUP=true` and store empty:
  - [x] SUPER_ADMIN employee: `brandenwooley07@icloud.com`
  - [x] Internal admin: `admin@fleetai.local`
  - [x] 1 customer org + user
- [x] Passwords are bcrypt-hashed
- [x] If `DEV_SETUP=false` and store is empty: refuse to start or show setup flow

## C) Auth Routes (Normalize Everything)
- [ ] `POST /api/auth/employee/login`
- [ ] `POST /api/auth/customer/login`
- [ ] (Optional) `POST /api/auth/org/login`
- [ ] “User not found” only if user truly does not exist
- [ ] “Invalid credentials” only for password mismatch
- [ ] Remove or strictly define `/api/login`

## D) UI Fixes
- [ ] Update `employee-login.html` to call the correct endpoint
- [ ] Update `login.html` (customer) to call correct endpoint
- [ ] Add `/admin/setup.html` if required for first-run admin creation
- [ ] Do NOT block login flows with incorrect “first login” logic

## E) Driver App (Android / Kotlin)
- [ ] Fix `SensorsScreen.kt` compile errors
- [ ] App builds with `./gradlew :app:assembleDebug`
- [ ] Ensure API base URL is configurable
- [ ] Add TODOs for future driver features (no extras)

## F) Tooling & Scripts
- [ ] `npm run dev:reset` → clears auth store + reseeds
- [ ] `npm run dev:start` → DEV_SETUP=true
- [ ] `npm run prod:start` → DEV_SETUP=false
- [ ] `SMOKE_TEST.md` with exact verification steps

## G) Smoke Test Checklist
- [ ] `npm start` logs `[AUTH STORE] loaded users >= 3`
- [ ] No silent failures
- [ ] Employee login works
- [ ] Customer login works
- [ ] Correct error messages
- [ ] Pairing / claim routes still work
- [ ] Android app builds successfully
