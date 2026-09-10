# Authentication, Tenant Isolation, and Public Website Review

Date: September 10, 2026

## Status

Implemented and tested locally on clean-auth-rebuild. This review does not establish that these changes are deployed to Railway. No customer passwords, organizations, or telemetry were changed for this work. Existing unrelated worktree changes were preserved.

## Authentication and Company Boundaries

- Staff access now uses an explicit role allowlist rather than treating every non-customer role as an employee.
- Session issuance waits for persistence. Protected requests consult persistent session state, so another server's cached session cannot override database revocation.
- Customer sessions remain bound to their original organization. Account reassignment, removal, password changes, and invalid roles invalidate existing sessions.
- Signing into another portal retires the previous browser sessions. Simultaneous staff and customer access should use separate browser profiles.
- Shared dashboard APIs prioritize an existing customer cookie and do not fall back to staff access when that cookie is invalid.
- Dashboard requests and live streams carry an expected workspace identity. An old tab cannot silently follow a different signed-in company or user.
- Telemetry and message streams recheck authorization and stop on revocation or authorization failures. Device streams also check pairing identity and assignment.
- Advisor context requires organization scope. Historical telemetry must match both the sample's organization and the vehicle's current organization.

Primary files: server.js; server/authStore.js; server/auth/authService.js; server/pgSessionStore.js; server/routes/authRoutes.js; server/middleware/tenantScope.js; server/middleware/sessionStream.js; server/middleware/deviceAuth.js; server/routes/fleetOpsRoutes.js; server/routes/solutionRoutes.js; server/services/advisorContextService.js; ui/fleetai-dashboard.html.

## Public Website

The root index.html remains the canonical home page. Legacy content was present in linked pages rather than requiring a second home page. Existing compatibility routes were retained.

Rebuilt Platform, Pricing, Security, Company, Developers, Pilot, Demo, and invite activation pages. Updated home-page navigation, footer, and final CTA styling while retaining the highway video. Restyled API documentation and legal pages; legal text was preserved, not legally revalidated. Simplified customer/employee login and password screens without changing their form contracts.

Shared styles: css/public-site.css, css/public-docs.css, css/public-access.css. Shared navigation behavior: js/public-site.js.

Fixed the signup script's global-name collision, added invitation validation and submission states, and preserved submitted operating-region information. Removed the employee login's nonfunctional optional two-factor field; this does not implement MFA.

Public source files: index.html, product.html, pricing.html, security.html, about.html, developers.html, partner-docs.html, pilot.html, request-demo.html, signup.html, legal/privacy.html, legal/terms.html, customer-login.html, employee-login.html, org/reset-password.html, ui/force-reset.html, ui/settings/set-password.html, js/site.js, js/signup.js.

## Verification

- Security suite and integration suite passed, including existing pairing, telemetry, provisioning, and account tests.
- New session/tenant suite plus dashboard request safety: 18 passing tests.
- Dashboard browser smoke passed for all 32 routes at three viewport sizes.
- Public browser smoke passed for 17 pages at 1440, 1024, 390, and 320 pixels, including internal links, fragment targets, missing assets, script errors, horizontal overflow, mobile menus, and form success/failure states.
- Public forms and dashboard browser tests use synthetic fixtures, not live customer submissions.
- Launch checks passed: configuration validation, preflight, UI smoke, dashboard pairing contract, host policy, and link audit.
- Git whitespace check passed.

Repeatable commands:

```text
npm.cmd run test:security
npm.cmd run test:integration
node --test tests/session-tenant-isolation.test.js tests/dashboard-request-safety.test.js
node tests/dashboard-browser-smoke.js
npm.cmd run test:public:browser
npm.cmd run launch:check
npm.cmd run preview:public
```

The public preview binds to 127.0.0.1:4175 and intentionally has no live API access.

## Deployment and Remaining Limits

No new database migration or environment variable is required specifically for this authentication/public-page patch. Separate pre-existing ML changes may have their own migration and deployment requirements.

This is not an independent penetration test or a guarantee that every endpoint is secure. Fleet AI employees retain intentional broader administrative access. MFA is not implemented by these changes. Database mocks and local browser fixtures do not prove production multi-replica behavior or performance.

Before onboarding another company, deploy through the normal reviewed release process and smoke-test two isolated test organizations on the deployed service: login/logout, revoked sessions across replicas, vehicle and historical signal access, live streams, Advisor, and account switching. Confirm each company's account and assets are assigned correctly. No production deployment was performed in this review.
