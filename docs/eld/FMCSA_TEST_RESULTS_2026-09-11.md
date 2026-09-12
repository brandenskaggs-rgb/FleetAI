# FMCSA Web-Service Test Results

## Scope

Fleet AI submitted generated fictional records to the official FMCSA ELD web service
with `Test=true`, using FMCSA's downloaded test identity and certificate. No customer
records, pilot telemetry, real driver records or production identity were used.
No device registration or certification statement was submitted.

This demonstrates a working local test-mode SOAP submission and validation of one
small synthetic file. It does not establish complete ELD compliance or compatibility
with either physical hardware configuration.

## Observed results

| Step | Service status | Errors | Warnings |
| --- | --- | ---: | ---: |
| Diagnostic Ping | InvalidRegistrationData | N/A | N/A |
| Initial test file | Error | 4 | 1 |
| Corrected test file | Information | 0 | 0 |

Final recorded submission: `62be3cfd-ff04-4e36-8b92-e8010be47d6c`,
September 11, 2026 at 11:37:10 UTC. Informational notices were "Test Information"
and "File Received". The returned status was **Information**, not **Valid**.
The local `valid` boolean means no validation errors or warnings in this test
response; it does not mean a registered/compliant device.

The service field named `ErrorCount` counts all validation messages, including
information. It returned 7 initially and 2 after correction. The client now exposes
`reportedMessageCount`, `validationErrorCount` and `warningCount` separately, rather
than incorrectly treating both final informational notices as errors.

Local raw result summaries are in ignored `artifacts/eld/fmcsa-submit-*.json`.
Earlier summaries preserve the original parser's field naming and classification;
they were not overwritten to make results look better.

## Bugs corrected

- Stored dates are YYMMDD; exporting them unchanged caused FMCSA Invalid Date errors.
  Conversion to MMDDYY now occurs only when generating the export. Internal event
  dates and certification dates are not migrated or rewritten. Tests cover leap
  dates, invalid dates, date digit checksum preservation and unchanged input records.
- CRLF line separators caused an Invalid Line Delimiter warning. Exports now use
  CR separators and a final CR. Authentication signs that exact representation.
- SOAP XML carries CR as a character reference so XML newline normalization cannot
  silently alter the uploaded file's separators.
- Informational responses were initially misclassified by treating ErrorCount as a
  count of errors. Classification now uses the returned per-message severities.

## Client and credentials

- `server/eld/fmcsaTestClient.js`: fixed official destination, SOAP 1.2, WS-Addressing,
  client TLS certificate, bounded responses, deadline, no redirects or automatic
  retries, XML entity-declaration rejection, namespace checking and response correlation.
- `Submit` refuses an omitted/false test flag. No production transfer HTTP route or
  automatic background sender was added. A timeout does not prove rejection by the
  remote service; inspect submission history before any deliberate retry.
- `scripts/eld-fmcsa-test-package.py` reads the downloaded ZIP and converts its test
  key/certificate to PEM in memory, passing them to Node on stdin. No extracted key
  file is created. Node's direct PFX-loading path failed locally; PEM succeeded with
  TLS certificate verification enabled. No TLS trust settings were weakened.
- Test certificate validity was checked: August 31, 2022 through August 28, 2032.
  These certificates must not be registered as Fleet AI's production identity.
- The downloaded public WSDL is retained at `contracts/ELDSubmissionService.wsdl`.
  SHA-256: `3289496d5ce7c0cfbbd0fc7c8d36149cfbde52f92f08743df7bfda08c09542c0`.
  Its source is the WSDL/XSD link in the authenticated FMCSA provider portal.

## Repeatable checks

```powershell
npm run test:eld
npm run launch:check
npm run test:pairing-bootstrap
python -m pip install -r scripts/requirements-eld-tools.txt
python scripts/eld-fmcsa-test-package.py "path/to/Test_ELD_Info_2022.zip"
python scripts/eld-fmcsa-test-package.py "path/to/Test_ELD_Info_2022.zip" --submit-synthetic
```

The final two commands contact FMCSA. The first is a Ping; the second submits a
new synthetic test file. Do not run a retry loop. The local Python helper requires
Node on PATH. Keep the ZIP and keys outside the repository. The test helper reads
neither `.env` nor a database. Its successful exit is a test result, not certification.

## Remaining release blockers

Local verification after implementation passed: `test:eld`, `launch:check`, all 10
pairing bootstrap tests, `test:security`, JavaScript/Python syntax checks and
`git diff --check`. `npm audit --omit=dev` reported no known vulnerabilities at the
time of this run. Those checks are not a guarantee of security or ELD compliance.

- Implement and validate the second telematics method: signed/encrypted email,
  receipt handling and verified recipient certificate.
- Integrate approved production credentials and durable, tenant-scoped transfer
  attempts/reconciliation, without automatically promoting test mode.
- Build and test the driver's roadside inspection and transfer workflow.
- Expand record tests beyond the three generated events: multiple days, driver
  changes, unidentified driving, edits, certification, diagnostics and missing data.
- Review output semantics not established by a clean file-format response, including
  generation-time header values, CMV/user cross-references and non-ASCII handling.
- Execute separate Veepeak/car and Samsung/Motive/truck physical test plans. There
  is still no proven third-party Motive gateway interface in the inspected app.
- Complete Fleet AI's original manual, malfunction instructions, production public
  certificate and evidence review before signing the registration declaration.

No Railway configuration, database schema, Android build, pairing session or running
pilot was changed. These changes have not been committed, pushed or deployed.

## Subsequent local hardening

The signed email package now passes 13 offline cryptographic and input-validation
tests, and a Gmail draft round trip preserved its CMS bytes and valid signature.
The owner subsequently approved sending it; Gmail confirmed SENT. FMCSA's email
validation response remains pending; see `EMAIL_TRANSFER_VALIDATION.md`.

Fourteen new Node tests cover driver/organization isolation, missing-driver rejection,
invalid date/limit rejection, bounded record reads, complete-export overflow,
carrier-calendar/DST reporting windows, explicit generation-not-transmission status
and missing-organization rejection on device enable. Device record requests no longer
accept another driver's ID or fall back to every driver in the organization.

Output generation now fails rather than signing an export truncated at 5,000 events.
No existing event, pairing, credential, schema or production flag was rewritten.
Large exports, multi-vehicle references, complete unidentified-driver output and
generation-time header semantics still need review before production ELD use.
