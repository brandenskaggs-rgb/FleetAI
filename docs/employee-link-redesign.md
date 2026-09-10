# Employee workspace: Link branding

The internal portal now shares the customer dashboard's graphite, white and
neutral-green palette, local Archivo/Source Sans 3/IBM Plex Mono fonts, Link mark,
Lucide icons, small corner radii, and borderless controls.

All 11 route identifiers remain. Company creation, conversion, access issuance,
password reset, invites, billing, feature flags, API keys and employee permissions
retain their existing endpoint and payload contracts. No backend, storage,
session or Android changes are required for this visual pass.

The shared stylesheet covers tables, responsive detail forms, modals, one-time
credentials, error messages and keyboard focus. Search is labeled for its actual
company-search behavior. Duplicate refresh controls were removed. Switch account
is the existing sign-in shortcut, not an account reassignment operation.

The old theme selector was removed because the shared site script already locks
the site to light mode. Compact table density remains available and persistent.

## Verification

Run `npm run test:employee:browser` for isolated browser tests. Coverage includes
11 routes at 1920, 1440, 1024 and 390 pixels, company creation and access issuance,
company save, lead conversion, invitations, employee credentials, restricted
roles, failed access requests, session redirect, logout, density and mobile nav.
Screenshots are written under the ignored `artifacts/ui/employee-link` directory.

Run `npm run launch:check` for the existing launch contracts.

`npm run preview:employee` starts a loopback-only preview on port 4177 with
clearly labeled synthetic records. It never reads .env or a database. Preview
writes affect only its in-memory fixtures and are discarded when it stops.
Production startup does not import or start this test file.

This work does not enable unfinished product capabilities or certify production
account workflows. Browser tests use fixtures; backend provisioning, recovery
and tenant-session tests should also be run before deployment.
