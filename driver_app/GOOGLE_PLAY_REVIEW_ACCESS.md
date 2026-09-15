# Fleet AI Driver: reviewer access

Prepared for version 1.10.5 (17). This is not a statement of Play approval or ELD certification.

## Current status (September 14, 2026)

The isolated reviewer workspace now contains the fictional vehicle `PLAY-REVIEW-01` and
driver `Google Play Reviewer`. No real fleet VIN, driver or telemetry was used. The owner entered
the reviewer password directly into Google Play's private sign-in form; that declaration is saved.
The historical preparation notes below describe earlier gates, not the current access status.

- A real API pairing claim succeeded. The authenticated driver profile matched the reviewer
  organization; the vehicle list contained only the fictional review vehicle. HOS and DTC reads
  succeeded. The device status correctly reported no production ELD authorization.
- `ReviewerPairingReleaseTest` passed on the signed release in an isolated API 35 emulator:
  real pairing-screen entry, authenticated profile, expected organization and vehicle, persisted
  token, and session restoration after activity recreation. It did not exercise process death,
  physical vehicle hardware, background collection, or cross-tenant adversarial access.
- Both temporary test assignments were revoked through the review workspace afterward. No
  existing pilot account or tablet session was changed. The review driver and vehicle remain
  available so a reviewer can generate a fresh code for each installation.
- `PlayListingScreenshotsTest` passed at phone and tablet sizes. Uploaded screenshots were also
  inspected visually. One wide Home capture caught an earlier compositor frame and was rejected;
  a test pass alone is not approval of every captured image. Only verified images were uploaded.
- No production app source, schema, API, signing key or version changed in this preparation pass.

Current private access instructions describe website login, Workspace > Pair a tablet, selecting
the review driver and vehicle, generating fresh codes, and the offline training route. They also
explain that live sensors require a compatible adapter. Credentials and one-time codes must never
be copied into this document or the listing.

### Repeating the live acceptance test

The test is skipped unless instrumentation argument `reviewerLiveTest=true` is explicitly supplied.
It requires `reviewOrgId`, `reviewPairingCode` and `reviewDriverPin` arguments obtained for the
isolated reviewer workspace. Supply them only to a clean, unpaired emulator running the signed
release. Never target a pilot tablet. The test clears its matching local reviewer session after
execution; revoke that test's server assignment separately in the reviewer dashboard. Do not
record credentials in committed scripts or build logs. Scope assertions confirm the expected
assignment, not a comprehensive tenant-isolation security audit.

## Offline training walkthrough

1. Open Fleet AI Driver on a clean Android install.
2. On the pairing screen, tap **Tablet details**, then **View training demo**.
3. Leave pairing code and driver PIN blank. No website account or vehicle adapter is required for this mode.
4. Home identifies the sample driver and vehicle. Try a duty change, break or end shift.
5. Logbook shows activity entered during this training session. It is not a certified HOS record.
6. Inspections lets you fill the checklist and save a training inspection locally.
7. Sensors shows generated coolant, RPM, speed, voltage, intake and oil-temperature readings. Change units or search for a sensor. These values are not ECU measurements.
8. Notifications shows locally generated driver updates, not messages delivered to a real fleet.
9. Open Settings from Home and select **Exit training demo** to return to pairing.

All training screens carry a sample-data notice. Vehicle hardware and location collection are not
enabled in training. Training activity and inspections are handled locally, not queued for fleet
upload. The HTTP client rejects training-session requests before opening a network connection.
Privacy and terms links open the public website normally.

## What the demo does not establish

- It does not exercise real company sign-in, dashboard pairing, server synchronization or network recovery.
- It does not supply hardware sensor evidence or demonstrate Bluetooth/USB reliability.
- It does not demonstrate legal ELD certification, roadside transfers or compliance with driving limits.
- It is not full access to all production functionality. Do not check that Play declaration based on the demo alone.

Keep the separate reviewer organization for authenticated production-flow review. Provision a
fictional driver and vehicle, verify repeatable pairing and tenant isolation, and enter its credentials
only in Play Console's private access fields. Never use a customer's account or place credentials
in this file. The owner's successful customer login alone does not verify tablet pairing.

Hardware-dependent behavior still needs a real-device demonstration and accurate access instructions.
Google may request more evidence; a video or training mode alone does not guarantee acceptance.

## Play Console text (under 500 characters)

Name: Offline training demo - no fleet pairing

For version 1.10.5 (17): open Fleet AI Driver, tap Tablet details, then View training demo. No company code, PIN, adapter or website login is needed. Explore Home, Logbook, Inspections, Sensors and Notifications. All samples stay on the device and are labeled training data. Home > Settings > Exit training demo returns to setup. Live fleet sync, vehicle readings and legal ELD functions are not demonstrated by this mode; they require separate authenticated access and supported hardware.

## Release acceptance

Run the release instrumentation test on a clean emulator only; it refuses an existing paired session.
It uses encrypted DataStore, an in-memory Room database, a fail-on-call API double and the real HTTP
interceptor. It verifies local activity/inspection/notification behavior, no API calls, certification
rejection, legacy demo-token handling, exit, unchanged device identity, and refusal to overwrite a
synthetic paired-account fixture. No customer credentials or telemetry are used.

```powershell
cd driver_app
# Supply the existing upload-signing environment securely; never paste passwords into this document.
.\gradlew.bat -PFLEETAI_TEST_BUILD_TYPE=release connectedReleaseAndroidTest
```

This test is not a visual walkthrough or a real vehicle test. Release-screen navigation, permissions,
foreground notification behavior and production pairing must also be checked before submission.
Do not install the upload-key-signed release over the debug-signed pilot tablet or uninstall that pilot.

### Verification on September 14, 2026

- 64 debug unit tests and 64 release unit tests passed, with no skips.
- All 6 release instrumentation tests passed on a fresh API 35 tablet emulator, with no skips.
  These include the new training-session test, three logbook screen tests and two pilot-status screen tests.
- The training test also exercised SensorViewModel's six generated readings, Fahrenheit/Celsius conversion,
  speed-unit labels, rejection of USB connection and refusal to enable location collection in training.
- 71 driver-contract assertions, 10 pairing-bootstrap checks and 7 Play-release contract tests passed.
- `npm run launch:check`, including the public link audit and dashboard pairing checks, passed.
- Release lint: zero errors; one existing unused legacy-logo warning.
- The existing upload key signed the 1.10.5 (17) bundle. `verifyPlayRelease` and bundletool validation passed;
  bundle configuration reports `PAGE_ALIGNMENT_16K`.
- Bundle: `output/android/Fleet-AI-Driver-1.10.5-play.aab`.
- SHA-256: `6A2D35F0F3108AA2AAA3EC409C4FFA8A32A797B8F597F40B60D910577F94B7C8`.
- Initial emulator runs could not install: the existing emulator had a different signing certificate,
  then the fresh emulator was not fully booted. Neither was counted as a pass. Its old install was
  preserved, and the successful run used a separate clean AVD after boot completion.
- Play Console rejected saving the demo-only instructions unless its full-access declaration was checked.
  That declaration was deliberately left unchecked. The instructions are preserved here, not confirmed
  saved in Play Console. Complete authenticated reviewer access before making that declaration.
- No bundle was uploaded, no review or rollout was submitted, and no current pilot tablet or production
  fleet account was changed. No database migration or Railway configuration change is required.

### Subsequent upload on September 14, 2026

After the owner requested commit, push and publication work, source commit `bede511` was pushed.
Google accepted the same signed 1.10.5 (17) artifact listed above and the internal-testing draft was
saved. The previous version 13 was removed from this draft but remains in the artifact library.
No rollout or review was submitted. Demo-only access instructions remain unsaved because they do
not truthfully establish full access. The separate reviewer pairing workflow still needs validation.
See `PLAY_STORE_RELEASE.md` for the current warnings and publication gates.
