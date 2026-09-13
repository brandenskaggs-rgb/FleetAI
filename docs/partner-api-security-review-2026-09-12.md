# Partner API Security Review

Date: 2026-09-12

## Scope and Result

Reviewed the Node partner ML API, key administration and authentication, stream
tickets, live streams, webhook delivery, embeddable widget, public API reference,
internal ML guard, and relevant session/tenant tests. Inspected the Python service
authentication and vehicle-status boundary. This is a targeted security review,
not a complete penetration test or a guarantee that every endpoint is secure.

Changes are local on clean-auth-rebuild. They are not committed, pushed or deployed
by this review. No customer records, production credentials, tablet pairing state,
training artifacts, or Android files were changed.

## Fixed Findings

1. High: outstanding partner stream tickets trusted cached identities after key
   revocation. Redemption now rechecks enabled state, organization and tier against
   the database. Missing records and database failures deny access. Tickets remain
   short-lived and single-use, and can now be restricted to a specific vehicle.
2. High: open partner streams never revalidated their keys. Streams now recheck
   every 25 seconds with a 35-second authorization lease. Revocation, authorization
   failure, a stalled check, disconnect, and backpressure close the stream. A
   15-minute maximum lifetime requires a fresh ticket. Revocation is bounded, not
   instantaneous; already-transmitted bytes cannot be recalled.
3. High: the partner widget interpolated vehicle IDs, advisory text, diagnosis and
   service guidance into HTML. Text is now escaped, numeric sensor values checked,
   and lookup tables checked for own properties. This prevents those values from
   injecting markup/scripts into a partner's page.
4. Medium: partner failures exposed raw database/service exception messages.
   Responses now return generic errors. Partner readiness returns a small allowlist
   rather than the internal model-state/debug object.
5. Medium: tickets, open streams and live snapshots were insufficiently bounded.
   Added pre-authentication IP rate limiting, 20 outstanding tickets per key,
   5 streams per key, a 500-stream process ceiling, and a 5,000-snapshot cache cap.
   Durable prediction history is unaffected by cache eviction.
6. Medium: webhook scheduling/retries did not honor revoked keys. New scheduling
   and every retry now require an enabled partner-tier key; database failure blocks
   delivery. New user-specified webhook secrets require 32-200 characters, or the
   server generates one. Existing stored secrets were not replaced.
7. Correctness: null/blank/boolean metrics could become false zero readings, and
   malformed sample/batch entries could throw. The partner input boundary now
   preserves missingness and rejects/skips malformed samples without changing the
   prediction algorithms or the tablet ingestion path.
8. Reference: corrected batch documentation from 200 to 50 vehicles, documented
   sample/body limits and ticket authorization, reduced unnecessary implementation
   detail, and clarified that model confirmation is not proof of a field failure.

## Existing Controls Verified

- Random partner API keys are hashed for database storage. Key listing omits raw
  keys and hashes; creation/revocation requires a validated SUPER_ADMIN session.
- Tenant namespaces derive from the authenticated key, not the submitted orgId or
  partner display name. Vehicle identifiers are namespaced before inference and
  storage. Keys intentionally assigned to the same organization share its data.
- Long-lived keys are accepted in headers, not URL query parameters.
- Partner prediction and batch routes have authenticated rate limits; global JSON
  bodies have a 256 KB limit.
- Webhook destinations are HTTPS-validated, private addresses rejected, and DNS
  addresses pinned for the connection. Payloads have HMAC signatures.
- Private ML access is distinct from partner access, disabled by default, requires
  a sufficiently long key, and defaults to a socket-level local-address check.
  Its powerful personal/internal key must never be given to a partner.
- Source serving uses an explicit root-file allowlist rather than publishing the
  repository root. Public API documentation is deliberately accessible; it does
  not confer API authorization or contain model artifacts.

## Verification

Passed:

- npm run test:security, including 17 new hardening cases/subcases.
- npm run test:tenant-sessions: 17 tests.
- npm run test:integration, including pairing, telemetry, customer provisioning,
  first-login, driver contracts and the security suite.
- npm run launch:check.
- npm audit --omit=dev --json: zero reported production dependency vulnerabilities.
- Headless Chromium widget injection check: zero injected image elements, literal
  attack text displayed, no script execution.
- git diff --check.

New behavior tests use isolated fixtures and a local HTTP server, not customer
telemetry or production keys. They test two organizations with identical partner
display names and vehicle IDs, forged body orgId, scoped queries, denied access
after key revocation, malformed samples and sanitized failure/status responses.

Read-only unauthenticated production checks at https://fleetaiops.com:

| Path | Status |
| --- | --- |
| /partner-docs.html | 200 |
| /api/partner/fleet | 401 |
| /api/admin/api-keys | 401 |
| /internal/ml/status | 404 |
| /server.js | 404 |
| /prisma/schema.prisma | 404 |

These results cover those paths at the time of testing, not all production routes
or successful authenticated access. No production mutations were performed.

## Deployment and Remaining Work

- No database migration or new environment variable is required. Deploy the Node
  changes and updated widget/reference together. Existing driver APK and pairing
  remain unchanged.
- Partner status is intentionally narrower. Integrators should use the documented
  readiness fields, not undocumented Python model internals.
- A partner's ticket-proxy backend must authenticate its own users and authorize
  the requested vehicle before asking Fleet AI for a ticket. Never trust an
  arbitrary browser-supplied vehicle ID without that check.
- Tickets, live snapshots and stream limits remain process-local. Multiple Node
  replicas need sticky routing for ticket issuance/redemption or a shared atomic
  ticket store. They fail closed on a different replica/restart, but can interrupt
  availability. Connection counts are per process, not a global paid quota.
- Verify deployed Redis, proxy trust and CORS settings before external onboarding.
  This review did not read or change Railway secrets/configuration.
- Key lifecycle currently uses explicit revocation, not automatic expiry or
  endpoint-specific scopes. Use a separate partner organization, rotate keys,
  restrict administrative access, and add usage/billing quotas before broad sales.
- This does not prove all tenant-sensitive queries across the entire application
  are correct. Continue independent multi-tenant testing and deployment monitoring.
- Synthetic evaluation, model confidence and service timing must not be presented
  as scientifically proven failure forecasts. The advisory timing API still needs
  a separate scientific validation review; its displayed confidence interval is
  not statistically established.
