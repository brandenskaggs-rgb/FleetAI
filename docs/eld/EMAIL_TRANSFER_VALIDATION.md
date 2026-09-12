# FMCSA Email Transfer: Development Evidence

Status: Synthetic test email sent after explicit owner approval; FMCSA response pending.
This is engineering evidence, not registration, certification or proof of field compliance.

## Implemented and independently checked

- `scripts/lib/eld_smime.py` packages a comment and one output-file attachment.
  Base64 attachment encoding preserves the exact ASCII CR-only file bytes.
- It encrypts the MIME entity with AES-256-CBC using the reviewed FMCSA recipient
  certificate, then signs the encrypted entity with RSA/SHA-256. Opaque CMS is
  explicitly DER-encoded and wrapped as `application/pkcs7-mime; smime-type=signed-data`.
  Signed content is never parsed and reserialized before wrapping.
- The recipient certificate is pinned by SHA-256 and checked for expiry, RSA key
  size, email-protection usage, key encipherment and the FMCSA recipient mailbox.
  Its validity ends July 8, 2027 at 18:46:02 UTC. Rotation needs a newly reviewed
  official certificate and tests; do not disable the pin or expiry check.
- `scripts/lib/eld_test_identity.py` reads the official test ZIP without extracting
  private keys. Both the identity and submission must explicitly be test-only.
- `scripts/eld-fmcsa-email-test.py` generates a local ignored `.eml`; it has no mail
  sender, database access or `.env` loading. It does not register a device.

The first email tests exposed incorrect assumptions about SMIME serialization.
The explicit opaque wrapper now passes independent OpenSSL signature verification,
followed by decryption with disposable test keys. Assertions check the exact
attachment bytes, filename, comment and AES-256-CBC algorithm. Additional tests
reject modified signatures, wrong decryption keys, expired or unreviewed recipient
certificates, injection attempts and implicit/production mode.

OpenSSL's `-noverify` in these offline tests skips certificate-chain trust checking
for the self-signed fixtures, NOT the content signature check. It must not be
presented as proof of trusted production certificate chains or revocation status.

## Gmail draft round trip

The connected Google Workspace account matched the owner's requested return mailbox.
A synthetic-only draft was created with the opaque CMS as the top-level MIME entity,
not as an `.eml` attachment to an ordinary email. Reading the draft back in raw form
confirmed all of the following:

- Destination is `fmcsaeldsub@dot.gov`; the subject starts with the required `TEST:` form.
- MIME type remains `application/pkcs7-mime` with `smime-type=signed-data`.
- Decoded CMS bytes exactly match the locally generated message.
- Independent OpenSSL signature verification succeeds on the Gmail representation.

The owner subsequently approved sending this draft. Gmail confirmed the sent
message with the SENT label, message ID `1a0932cec0ef3a13`, and destination
`fmcsaeldsub@dot.gov`. The sent RFC Message-ID is
`<CAJeRfSD=oaBW+aQGe_eqGbLa_P0DOhoRSHj0C5jgp4oC5_o47w@mail.gmail.com>`.
Use this sent identifier, not the earlier draft Message-ID, for reply correlation.
No FMCSA reply, email submission ID or email validation success has yet been
observed. Gmail acceptance does not establish recipient acceptance or certification.

## Next test and production work

1. Completed: sent the existing verified draft once after owner approval. Retain
   the sent Gmail message ID and RFC Message-ID for response correlation.
2. Check both mail delivery and FMCSA's returned validation result. A Gmail send
   confirmation alone is not FMCSA acceptance. Reconcile ambiguous delivery before
   retrying; do not create a duplicate automatically.
3. Preserve the receipt and its error/warning/information classification. Do not
   treat an unrelated email or an uncorrelated response as success.
4. Implement a production raw-MIME transport and durable tenant-scoped transfer
   state machine. The interactive Gmail connector used for this development test
   is not an application runtime integration on Railway.
5. Install approved production credentials, not the official shared test identity.
   Complete authentication, certificate trust/revocation, rotation, monitoring,
   retries/reconciliation and return-mail handling before enabling production.

No new Railway environment variables or database migration are required to run
the offline tests. Production email integration remains unconfigured and incomplete.

## Repeatable offline checks

```powershell
python -m pip install -r scripts/requirements-eld-tools.txt
python tests/eld-smime-test.py
npm run test:eld
python scripts/eld-fmcsa-email-test.py --test-package "path/to/Test_ELD_Info_2022.zip" --recipient-package "path/to/FMCSA_ELD_Expires_July2027_Certificate.zip" --sender "your-monitored-mailbox@example.com"
```

The final command generates but does not send. Keep downloaded test keys and generated
email artifacts outside Git. Never replace the sender with an inbox nobody monitors.

## References

- [FMCSA ELD ICD Development Handbook, section 3.2.3.1](https://eld.fmcsa.dot.gov/File/LaunchTraining/c4625093-1169-eeb3-e053-0100007fd1b4/story_content/external_files/ELD_ICD_Development_Handbook.pdf)
- [Google Gmail API: MIME message submission](https://developers.google.com/workspace/gmail/api/guides/sending)
- [cryptography 50.0.1: PKCS7 signatures and envelopes](https://cryptography.io/en/50.0.1/hazmat/primitives/asymmetric/serialization/)
