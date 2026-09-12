# ELD Output Authentication Validation

Implementation: `FLEETAI-ELD-RSA-SHA256-V1`, added September 11, 2026.
This is Fleet AI's proposed authentication procedure, not a claim of FMCSA acceptance,
registration, full output-file conformance, or validated hardware compatibility.

## Purpose and scope

Verify that a Fleet AI export was signed by the holder of the corresponding RSA
private key and that its signed contents have not changed. Verification needs only
the exported file and a trusted public key/certificate. No database, customer
account, internal sequence epoch, or private key is needed.

The public certificate must be obtained through a trusted provider identity process;
an arbitrary key supplied alongside a file does not establish its provenance.
Certificate-chain, expiry, revocation, FMCSA registration, transfer authorization,
record correctness, and hardware compliance are separate checks, not implemented
by this file-signature verifier.

## Procedure

1. Read the file as printable ASCII lines separated by CR (ASCII 13), including its
   final CR. This version rejects LF/CRLF instead of silently normalizing.
2. Check the expected section ordering, seven header data lines, every line data
   check and the final file data check. Reject malformed files.
3. Read the authentication value in the third comma-separated field of the seventh
   header data line (zero-based file line 7). It must begin with `F1`, followed by
   uppercase hexadecimal encoding of a complete RSA signature. `F1` identifies this
   procedure; it is not an FMCSA-assigned identifier.
4. Construct the signed message from all file lines except the final file-check line.
   On file line 7 only, replace the authentication field with an empty field and omit
   its trailing line-check field. Preserve its registration ID, ELD identifier and
   output comment, with their commas. Leave every other line unchanged, including
   its checksum and all section titles, including `End of File:`.
5. Join those lines with CR and append a final CR. Prepend the ASCII string
   `FLEETAI-ELD-RSA-SHA256-V1` followed by CR. Encode the entire message as ASCII.
6. Remove `F1` from the authentication value and decode the remaining hexadecimal
   bytes. Verify using RSA PKCS#1 v1.5 padding with SHA-256 and the trusted public
   key. This implementation supports ordinary RSA keys of at least 2048 bits, not
   EC or RSA-PSS keys. Signature byte length must equal the RSA modulus byte length.

The signature and its dependent line/file checksums are excluded from the signed
message to avoid circular signing. They are still checked separately. File names
and external transport metadata are not signed by this procedure.

## Local command

```powershell
node scripts/eld-verify-output.js "path/to/export-file" "path/to/public-certificate.pem"
```

The command reads files without modifying them. It prints only verification status,
not driver records or key material. Exit codes: 0 valid authentication; 1 invalid
authentication; 2 usage or file/key input failure. A successful result is not a
successful FMCSA validator or transfer result. Never supply a private key.

## Migration and tests

- Earlier local exports used a truncated Base64 signature. The intermediate
  September 10 fix preserved hexadecimal signatures but still depended on database
  fields. Neither is accepted by this versioned verifier; retain old exports as
  historical evidence, and generate a new export when needed. Do not rewrite them.
- No database migration or production environment variable change is required.
  Existing `FMCSA_ELD_AUTH_PRIVATE_KEY` remains the generation key input.
- The September 11 draft was corrected after an actual FMCSA synthetic test response:
  dates export as MMDDYY and lines use CR, not CRLF. Internal YYMMDD dates remain
  unchanged. Date digit reordering preserves the event character-sum checksum.
  Earlier, undeployed V1 draft exports used CRLF; generate fresh test exports with
  the finalized CR procedure rather than treating those draft files as valid.
- No keys were generated for production, registered, rotated or committed here.
- Missing numeric values now export as missing, not false zero. Stored historical
  event checksums are not retroactively rewritten. Historical records made with
  earlier formatting must be evaluated separately for event-check consistency.
- `npm run test:eld` covers RSA 2048/3072 round trips, an independent file-only
  reconstruction, altered data with repaired checksums, wrong keys, malformed files,
  unsupported keys, missing observations and genuine zero readings.
- Non-ASCII names/content currently cause generation to fail explicitly. An approved
  consistent normalization policy across event creation and output remains needed.

## Authoritative reference

FMCSA's [ELD development handbook](https://eld.fmcsa.dot.gov/File/LaunchTraining/c4625093-1169-eeb3-e053-0100007fd1b4/story_content/external_files/ELD_ICD_Development_Handbook.pdf),
table 4-17, describes an alphanumeric authentication value and a possible signature
over values included in the export. This Fleet AI procedure must still be reviewed
against the current portal materials and exercised with the official test tools.
