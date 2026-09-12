# FMCSA Provider Portal Review

Historical review. For the subsequent downloaded contract, test-only client and
actual synthetic FMCSA responses, see `FMCSA_TEST_RESULTS_2026-09-11.md`. The original
download blocker described below was resolved by the owner's manual downloads.

Reviewed September 10, 2026 (America/Chicago). This is an engineering readiness note, not a certification or legal opinion.

## Account and registration

- Provider account approval email is dated August 31, 2026.
- Authenticated Chrome access to the ELD Provider Portal works.
- Manage Your Devices shows no ELDs.
- Registration requires a product name, model number, software version, six-character identifier, device image, user manual, public certificate, complete transfer option, transfer instructions, malfunction summary, authentication-validation procedure, and testing statement.
- The agreement is a sworn statement of completed technical testing. Nothing was submitted or certified during this review.

## Official portal resources observed

- Provider portal: https://eld.fmcsa.dot.gov/Home/Portal
- Development/testing: https://eld.fmcsa.dot.gov/Home/DevelopAndTest
- Registration: https://eld.fmcsa.dot.gov/Device/Create
- Web-service base endpoint displayed: https://eldws.fmcsa.dot.gov
- Transfer email displayed: fmcsaeldsub@dot.gov
- Handbook link: /File/Index/ca3647f7-9d0b-4048-a5c3-466e49cb0946 (portal labels it updated June 11, 2020).
- WSDL/XSD link: /File/Index/964ceb5b-f12c-714d-e053-0100007fac06.
- Test certificates/identifiers link: /File/Index/964ceb5b-f22c-714d-e053-0100007fac06.
- FMCSA email-encryption certificate is labeled as expiring July 8, 2027; a November 2025 web-service CA download is also listed. Certificate files were not installed or fingerprint-verified in this review.

The portal specifies complete options: web services plus email, or USB plus Bluetooth. This is not a generic webhook or automatic continuous upload of all fleet HOS records. Use the actual WSDL and test resources before implementing requests. Do not invent service paths, identities, credentials, or test acceptance results.

## Confirmed implementation gaps

1. `server/routes/eldRoutes.js` generates output at `/api/eld/output-file` and records `FILE_GENERATION` / `GENERATED`. That route does not transmit to FMCSA. No SOAP or S/MIME transfer implementation was found in the inspected server/driver sources.
2. `server/eld/outputFile.js` produced a Base64 RSA signature, then truncated it to 240 characters. An isolated synthetic reproduction with a 2048-bit key produced 344 signature characters but exported only 240. A local fix now exports the full signature in alphanumeric hexadecimal and limits the output comment to 60 characters. New tests verify signatures with 2048- and 3072-bit keys, tamper rejection, and line/file checksums. The overall authentication-validation procedure still needs review: its current payload includes internal sequence epoch information not directly represented in the exported file. This is not yet an FMCSA-validated implementation.
3. The inspected `LogbookScreen.kt` provides daily log entries and certification, but does not implement the documented roadside inspection/transfer screen. Verify the full required multi-day display and transfer UX on physical hardware.
4. `C:/Users/minsh/Downloads/ELD Manual PDF.pdf` is a KeepTruckin driver manual, not a Fleet AI manual. It is reference material only, not an appropriate Fleet AI submission attachment.
5. A specific tested tablet/adapter/gateway configuration and completed hardware test evidence are still needed. Do not infer truck compatibility from passenger-car telemetry or a connector photograph.

## Tests and limits

`npm run test:eld` passed the existing output/checksum primitives, HOS examples, readiness-gate tests, and the new signature regression test. The original reproduction failed signature preservation before the fix; the new regression verifies complete signatures after the fix. `node tests/pairing-bootstrap.test.js` also passed all 10 tests. These tests are not an official validator result or evidence of all required behaviors.

The readiness script was run without loading deployment environment variables; its WAIT results are not an audit of Railway secret configuration. No readiness flags were enabled. No customer records were uploaded to FMCSA. The local authentication export fix does not touch pairing, sessions, live telemetry, production configuration, or model data. It has not been deployed by this review.

## Next work

September 11 follow-up: the internal-field authentication dependency in item 2 was
replaced locally by the file-only, versioned procedure documented in
`AUTHENTICATION_VALIDATION.md`. Numeric export helpers now preserve missing values
instead of coercing them to zero. The extended ELD suite passed. These changes are
not deployed or FMCSA-validated. The owner restored Chrome's authenticated portal
session. Clicking the official WSDL/XSD link produced Chrome's
`ERR_BLOCKED_BY_CLIENT` page. The browser was returned to the portal; no browser
security controls were changed or bypassed. The owner was asked to try the download
manually or obtain assistance from FMCSA if it remains blocked. No official transfer
package, certificate, or acceptance result has been assumed. `launch:check` and all
10 pairing bootstrap tests passed after the changes. The verification CLI was tested
on synthetic files only. See `HARDWARE_VALIDATION_TRACKS.md` for the two separate
hardware test tracks and their unverified interfaces.

1. The owner requested evaluation of both the Veepeak and McLane/Motive configurations. Maintain separate compatibility results; neither is established as a complete Fleet AI ELD by this review. Confirm exact models and usable engine-data interfaces before physical certification testing.
2. Obtain the portal's actual WSDL, current certificates, and test identity package securely; keep private test and production keys outside Git and separate.
3. Fix and independently verify output formatting/authentication, then implement both telematics transfer paths with explicit test mode and durable result tracking.
4. Build and test the driver roadside workflow and offline/restart behavior.
5. Run official file-validator and transfer tests using synthetic test records first; retain results and complete the applicable physical-device test procedures.
6. Prepare original Fleet AI documentation and review all evidence before the owner signs and submits the registration statement.
