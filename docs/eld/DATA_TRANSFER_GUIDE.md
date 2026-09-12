# Fleet AI ELD Roadside Data Transfer Guide

Fleet AI targets the telematics option: FMCSA web services and email. Both methods
must be implemented and validated before claiming that this transfer option is ready.

## Planned driver workflow (not yet available end to end)

1. Open Logbook and select Roadside Inspection.
2. Review the current day and previous seven days.
3. Select Transfer ELD Records.
4. Enter the output-file comment supplied by the safety official, if any.
5. Choose Web Services. If instructed or the first method fails, choose Email.
6. Keep the result screen open and provide the transfer confirmation or error to the official.

## Provider dependencies

The endpoint, WSDL, FMCSA public key, email address, client-certificate requirements, and test flags are distributed through the FMCSA ELD Provider Portal. They must not be guessed or copied from another provider.

Planned production configuration (listing variables here does not implement transfer):

- `FMCSA_ELD_AUTH_PRIVATE_KEY`
- `FMCSA_ELD_CLIENT_CERT`
- `FMCSA_ELD_CLIENT_KEY`
- `FMCSA_ELD_WEBSERVICE_URL`
- `FMCSA_ELD_EMAIL_ADDRESS`

Fleet AI generates an ELD output file and integrity checks. The local test-only
web-service client has submitted a small synthetic file with no FMCSA validation
errors or warnings; see `FMCSA_TEST_RESULTS_2026-09-11.md`. This is not a complete
production transfer implementation. Email, driver UI, durable production result
tracking, credentials and the full hardware/record test matrix remain outstanding.

## Current safeguards

`POST /api/eld/output-file` reports `status: GENERATED_NOT_SENT` and
`sentToFmcsa: false`. It records a `FILE_GENERATION` attempt, not a transmission.
The default range starts at the carrier's reporting-day boundary seven days before
the current reporting day, accounting for its home-terminal timezone and day start.
An absent carrier timezone fails explicitly instead of guessing.

Exports exceeding 5,000 records fail with `ELD_OUTPUT_RECORD_LIMIT_EXCEEDED` rather
than returning a silently truncated signed file. A bounded, complete large-history
export still needs implementation; do not shrink the roadside reporting period to
work around this error. Ordinary record-list limits remain unchanged.

Device record reads require both organization and assigned driver. Caller-selected
other drivers and unassigned devices cannot query company-wide records. The separate
operator audit route retains organization-scoped fleet access.

Email packaging has 13 passing offline checks and a verified Gmail draft round trip;
the owner-approved synthetic test email has now been sent, but FMCSA acceptance
is not yet confirmed. See `EMAIL_TRANSFER_VALIDATION.md`.

The Android Daily Log is not yet the planned roadside workflow. Its API mapping
currently displays duty events rather than the complete ELD inspection record and
falls back to local log entries without a dedicated inspection freshness/error state.
The next Android slice must preserve pairing and existing offline queues while adding
the full eight-day display, required identity/header information, grid and event
details, certification/edit/diagnostic visibility, unavailable-data states and both
transfer methods. These cannot be replaced with a transfer-success message or a
generic CSV download.
