# Smoke Test Log

## Phase 0-1
- Ran `npm start` (10s timeout). Server started and printed routes/health URLs.
- Data integrity report logged: users/orgs counts present.
- NAV/overlay click fix not exercised in this phase (no UI changes).

## Phase 2
- Ran `npm start` (10s timeout). Server started with new auth routes.
- Auth endpoints now include `/api/auth/org/login` and `/api/auth/employee/login`.
- Login flows not exercised yet (needs credentials).

## Phase 3
- Ran `npm start` (10s timeout). Server started after login UI changes.
- UI changes not manually exercised (no credentials provided).

## Phase 4-6
- Ran `npm start` (10s timeout). Server started after seed/repair scripts and auth cleanup.
- Driver app build not re-run in this phase (JAVA_HOME missing earlier).
- `/api/dev/reset-auth` route registered in non-production mode.
