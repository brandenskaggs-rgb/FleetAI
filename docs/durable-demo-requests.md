# Durable Demo Requests

Demo and pilot submissions, employee lead edits, and lead conversions use PostgreSQL when DATABASE_URL is configured. Database failures return errors; they never fall back to the container's JSON file or report a successful save.

The additive migration `20260911000100_durable_lead_details` preserves message, fleet-size ranges, internal notes, demo date, and request type. Existing Lead columns retain contact details, status, and organization linkage. No account or pairing migration is required.

Both `/api/leads` and legacy `/api/admin/leads` routes share the store. Conversion commits the organization, lead link, and audit event in one transaction. Row and contact locks prevent concurrent conversions from creating duplicate organizations. Existing customer account ownership takes precedence; archived organizations require explicit restoration.

Surviving JSON leads are imported once per process using create-only upserts. Newer database records are never overwritten. Missing legacy organization references are retained in details. This cannot recover JSON records already lost with an earlier container.

Deploy through the normal Prisma migration workflow. DATABASE_URL must reference persistent PostgreSQL. No new Railway variables or volume are required for leads. Other JSON-backed collections are outside this fix and still require their own durability review.

## Verification

`npm run test:leads:postgres` requires an explicitly supplied LEAD_TEST_DATABASE_URL. It creates a uniquely named temporary schema, copies table definitions only, inserts synthetic test records, then removes that schema. It never copies customer rows. Coverage includes reconnect persistence, additive migration replay, legacy import, conversion concurrency, canonical account ownership, transaction rollback, access guards, and database failure responses.

Additional checks: `npm run launch:check`, customer-provisioning, org-conversion-recovery, pairing-bootstrap, and session-tenant-isolation tests.
