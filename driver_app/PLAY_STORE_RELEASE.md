# Fleet AI Driver - Google Play Release

This checklist covers the Android app in `driver_app`. It is an engineering and Play submission guide, not legal advice or a guarantee of approval. Google Play and transportation regulators make the final determinations.

## Release identity

- App name: Fleet AI Driver
- Application ID: `com.fleetai.driver`
- Current release: `1.10.5` (`versionCode 17`)
- Minimum Android: API 26 (Android 8)
- Target Android: API 36 (Android 16)
- Production API: `https://fleetaiops.com`
- Privacy policy: `https://fleetaiops.com/legal/privacy.html`
- Terms: `https://fleetaiops.com/legal/terms.html`

The application ID becomes permanent after publication. Confirm ownership and naming before the first production release.

## Build and signing

New Play apps must use Play App Signing. Create a separate upload key outside this repository and never commit the keystore or passwords.

The existing local pilot APK is signed with an Android Debug certificate. It cannot be updated in place
by a Play-signed APK. Do not uninstall the pilot or clear its data: that loses local pairing and pending
uploads. Use a separate test device for the initial Play build. A real pilot migration needs an explicit
queue-drain and re-pairing plan; this release does not perform one. The production app-signing key and
upload key have different roles. The signing choice must be confirmed before the first upload.

Set these environment variables:

```powershell
$env:FLEETAI_UPLOAD_STORE_FILE='C:\secure\fleet-ai-upload.jks'
$env:FLEETAI_UPLOAD_STORE_PASSWORD='<secret>'
$env:FLEETAI_UPLOAD_KEY_ALIAS='fleet-ai-upload'
$env:FLEETAI_UPLOAD_KEY_PASSWORD='<secret>'
$env:JAVA_HOME='C:\Program Files\Android\Android Studio\jbr'
```

Build and verify:

```powershell
cd driver_app
.\gradlew.bat testDebugUnitTest testReleaseUnitTest lintRelease verifyPlayRelease
```

Upload `app/build/outputs/bundle/release/app-release.aab`. Without all four signing variables, Gradle intentionally creates an unsigned bundle that cannot be uploaded.
`verifyPlayRelease` rejects absent signing configuration, unsigned bundle entries, Android debug signing,
and a non-production origin. It is a signing/identity guard, not a Google policy approval check.

The bundle configuration must report `PAGE_ALIGNMENT_16K`. Increase `versionCode` for every later Play upload.

### Local signing custody

On September 10, 2026 the account owner authorized a new upload key. It is stored outside this
repository at `%LOCALAPPDATA%\FleetAI\Signing\google-play\fleet-ai-upload.p12`, with access restricted
to the current Windows user. `upload-credentials.xml` in that directory contains a Windows DPAPI
protected PSCredential, not a portable plaintext password. `fleet-ai-upload-certificate.pem` is the
public certificate only. Do not commit any of these files.

Use `Import-Clixml` as that same Windows user to load the credential and supply the four environment
variables above for the build process only. Never print its password. The upload key is not the
Google-managed app-signing key and is not the pilot's Android Debug key.

Before release, back up the keystore and password in an owner-controlled encrypted vault. Merely
copying the DPAPI XML to another computer is not a recoverable password backup. No external backup
has been made by this preparation pass.

### Verified preparation results (September 10, 2026)

- Created Fleet AI Driver in the organization's Play Console; application ID `com.fleetai.driver`.
- Saved the Business category, approved support email, and HTTPS website.
- Debug unit tests: 30 passed. Release unit tests: 30 passed.
- Release lint: zero errors, one unused legacy-logo resource warning; no resource was deleted.
- Four new Play-readiness contract tests passed; existing pairing, device-auth and read-only tests passed.
- `npm run launch:check` passed, including preflight, dashboard pairing and link checks.
- `verifyPlayRelease` rejected the unsigned configuration, then passed with the new upload key.
- Google's bundletool validator accepted the signed `1.10.1` / `13` bundle.
- Bundle configuration reports `PAGE_ALIGNMENT_16K`; both 64-bit DataStore libraries have 16,384-byte
  LOAD alignment and 16 KB-aligned RELRO ends. This is binary inspection, not a physical-device test.
- Signed bundle SHA-256: `7DC80AA542E5E9E01C0CEFA5F9C3C038545D033857C2483BF76AB48A67D30C56`.

Publication remains gated on reviewer access, accurate completed declarations, store assets,
foreground-service/location demonstration evidence, and the
physical-device acceptance checks below. Unit tests and a successful build do not imply Google
approval or on-truck validation. Do not submit for review without notifying the account owner.

### Verified preparation results (September 13, 2026)

- Play Console shows the Sentinel X Inc. organization account verified; Fleet AI Driver remains Draft.
- Saved privacy policy, no advertising ID, non-government, no financial features, and no health
  features declarations. Vehicle health is not a human-health feature. Nothing was sent for review.
- Data safety is an incomplete saved draft, not a completed or certified declaration. Selected
  approximate/precise location, name, user IDs, diagnostics, app interactions, other user-generated
  content, and device IDs. Verify all categories and per-category handling before submission,
  including any server-side sharing, optionality and retention. Do not infer "no sharing" merely
  because the app has no advertising SDK.
- The public privacy policy and owner-approved support address were verified on the live website.
- `testDebugUnitTest`: 64 tests passed; `testReleaseUnitTest`: 64 tests passed.
- `lintRelease`: zero errors, one unused legacy-logo warning. All four Play contract tests passed.
- `verifyPlayRelease` passed with the existing protected upload key. No new key was generated.
- Bundletool validation passed and bundle configuration reports `PAGE_ALIGNMENT_16K`.
- Signed release: `1.10.4` / `16`; preserved at `output/android/Fleet-AI-Driver-1.10.4-play.aab`.
- SHA-256: `FB07CA512F2636197501E533DB6E05CEE6C3F9FDB0B51A3453607A667BED2D1E`.
- This pass changed release documentation only, not tablet behavior or existing pilot pairing/data.
- With owner approval, created `Fleet AI - Google Play Review` and its separate customer login.
  Temporary login succeeded and correctly requires a first-login password change. The owner must
  complete that change. No credentials are stored in this document or source control.
- The review organization currently has no vehicles or telemetry. Fictional driver/vehicle setup,
  repeatable pairing instructions and cross-tenant access verification remain pending. Existing
  customer organizations were not edited. Do not share review access with Google until verified.
- Content ratings are pending IARC terms approval. Target audience is blocked by Sign in details.
  App bundle upload, store assets, permission demonstration video and physical release testing remain.

## Play Console declarations

The 1.10.5 training-demo fixes and repeatable review instructions are documented in
`GOOGLE_PLAY_REVIEW_ACCESS.md`. Historical build evidence above refers to its stated version,
not automatically to the new build. Do not upload the older 1.10.4 bundle for these demo fixes.
The September 14 verification section records the successful 1.10.5 unit/instrumentation runs,
signed artifact hash and remaining reviewer-access blocker. The bundle was subsequently uploaded
and saved as an internal-testing draft on September 14; see the upload status below.

### Google Play upload status (September 14, 2026)

- Source changes committed and pushed as `bede511` on `clean-auth-rebuild`.
- Google accepted signed version `1.10.5` / `17` and the release draft was saved with updated notes.
- Removed version `1.10.1` / `13` from this draft only; it remains in Google's artifact library.
- Preview reports three warnings: no internal testers selected, no deobfuscation file, and no native
  debug symbols. Release minification is disabled, so no R8 mapping file is generated by this build.
- No internal rollout, production release, or review submission was performed. Public release is
  still gated by initial setup: reviewer access, content rating, target audience, data safety, and
  store listing assets. Permission demonstration and physical acceptance checks also remain.
- The IARC Terms of Use require the account owner's confirmation before acceptance.
- No customer fleet, existing tablet session, production pairing, or database was changed by upload.

### App access

The pairing flow normally requires an expiring dispatch code. That is NOT sufficient permanent reviewer
access. The existing training mode can demonstrate local screens as follows:

1. Open Fleet AI Driver.
2. Tap **Tablet details**, then **View training demo**.
3. The demo uses local sample data and cannot access a customer fleet.
4. Open Sensors to view sample telemetry and Settings to view legal links.

Do not give Google a real customer pairing code or driver PIN. Do not assume the training demo covers
every restricted production feature or satisfies Google's access requirement. Before review, provide
an isolated reviewer fleet with an approved durable/repeatable access process, or obtain confirmation
of acceptable hardware/demo review instructions. No production authentication bypass is added here.

The proposed repeatable review process uses existing authentication: an isolated review organization,
fictional driver and vehicle, and a reviewer-only customer account allowed to generate fresh pairing
codes for that organization. Reviewers can generate a new code on each installation, then pair using
the fictional driver's PIN. Test this entire flow before entering instructions into Play Console.
Do not extend production pairing-code lifetimes, reuse a pilot's vehicle/driver, or add an authentication
bypass. No real VIN, fleet DOT number, contact information or customer telemetry belongs in this fleet.
Hardware-dependent tests still require a supported adapter and vehicle; a reviewer account cannot
create live sensor data or establish ELD certification. Keep training samples clearly identified.

### Data safety

Declare the app's actual production behavior. At minimum, review these collected categories:

| Play category | Data | Purpose | Notes |
| --- | --- | --- | --- |
| Personal info | Driver name and user/driver ID | Account management and app functionality | Issued by the fleet; no in-app account creation |
| Precise location | Latitude, longitude, accuracy, speed, bearing, timestamp | Fleet management and app functionality | Optional; may continue during the visible telemetry foreground service |
| Device or other IDs | Fleet AI tablet ID, adapter details/serial, app version | Security, pairing, diagnostics, app functionality | No advertising ID |
| App activity / other user content | HOS duty events, notes, driver updates, certifications | Compliance workflow and app functionality | Confirm final Play category wording in the current form |
| App info and performance | Connection state, protocol, request failures, telemetry quality | Diagnostics, security, reliability | Production logcat excludes request bodies and identifiers |
| Vehicle operational data | VIN, OBD-II PIDs, J1939 frames, DTCs, derived metrics | Fleet operations and predictive maintenance | Vehicle data is not human health data |

- Data is encrypted in transit with HTTPS.
- The app does not contain ads and does not use data for advertising.
- Fleet data is visible to authorized personnel in the driver's fleet organization and to contracted infrastructure providers that operate the service. Answer Play's “shared” questions using the current contracts and Play definitions.
- The app does not create accounts. Fleet administrators provision drivers and pairing codes.
- Drivers can request access or deletion through their employer or `brandenskaggs@sentinelxinc.com`, subject to required fleet and regulatory retention.
- The account owner confirmed `brandenskaggs@sentinelxinc.com` as the monitored support/privacy contact on September 10, 2026. Deploy the matching public privacy page before submission.

### Location disclosure

The Sensors screen presents this disclosure before Android asks for location:

> Fleet AI Driver collects this tablet's precise location to show the vehicle position to your fleet manager while live telemetry is running, including when the app is not visible. Location is sent securely to Fleet AI, is not used for advertising, and can be turned off here. Vehicle sensor telemetry still works if you decline.

Record a short review video showing:

1. Opening Sensors.
2. Tapping **Enable live location**.
3. Reading the complete disclosure.
4. Both **Allow location** and **Not now** paths.
5. The user-visible telemetry notification while collection is active.
6. Turning location off and stopping telemetry.

### Foreground services

Declare the manifest types in Play Console:

- `connectedDevice`: user starts a read-only Bluetooth OBD-II or listen-only USB/SLCAN J1939 connection; uninterrupted access is needed to read the vehicle interface. The ongoing notification shows status and has a Stop action.
- `location`: only used when the driver separately enables live location; it attaches location to active vehicle telemetry for the authorized fleet map.

The app does not declare `ACCESS_BACKGROUND_LOCATION`, `shortService`, or a `dataSync` foreground service.

### Other App content answers

- Ads: No.
- Target audience: business fleet drivers; not directed to children.
- Content rating: complete the Play questionnaire using the actual app content.
- Privacy policy: use the public URL above, not a PDF.
- App category: Auto & Vehicles or Business, based on the final listing strategy.
- Restricted access: resolve the reviewer-access gate above and describe all hardware requirements.

For a personal developer account created after November 13, 2023, complete a closed test with at least 12 opted-in testers for 14 continuous days before applying for production access.

## Store listing assets

Prepare these separately in Play Console:

- 512 x 512 PNG app icon without transparency.
- 1024 x 500 feature graphic.
- At least two phone screenshots.
- Tablet screenshots from both 7-inch and 10-inch layouts because this is a tablet-focused product.
- Support email and website.

Suggested short description:

> Vehicle telemetry, driver logs, inspections, and live fleet status.

Avoid claims that Fleet AI guarantees failures, replaces a mechanic, or is certified by Google, DOT, FMCSA, or an OEM.

## Physical-device acceptance test

Run this on a clean Play-style release install, not only a debug APK:

- Pair and unpair a tablet against a non-production test organization.
- Deny Bluetooth, notification, and location permissions independently; confirm no crash.
- Approve Bluetooth and connect a Veepeak adapter; verify ECU-off data becomes stale and stops uploading.
- Connect the approved USB/SLCAN J1939 interface; verify listen-only operation, notification status, background continuity, and Stop action.
- Enable location, background the app, verify a fresh map point, disable location, and verify new positions stop.
- Turn the vehicle off and verify no fabricated zero-value telemetry is treated as live.
- Disconnect network access, collect data, reconnect, and verify the outbox drains once without duplicate records.
- Verify HOS events, certification, inspections, logout, and reset pairing.
- Rotate and resize on Android tablets; confirm no clipped controls or inaccessible legal links.
- Test Android 13, Android 15, and Android 16 hardware or Play pre-launch devices.

## Separate transportation compliance

Google Play approval is not FMCSA ELD certification. If Fleet AI will be marketed or used as the carrier's official ELD, complete the FMCSA self-certification and registration process, output-file transfer testing, malfunction/diagnostic behavior, roadside inspection workflow, record-retention validation, and legal review before claiming ELD compliance. Keep pilot telemetry and advisory features clearly distinguished until that work is complete.

## Current official references

- Target API policy: https://support.google.com/googleplay/android-developer/answer/11926878
- User Data policy: https://support.google.com/googleplay/android-developer/answer/10144311
- Data safety: https://support.google.com/googleplay/android-developer/answer/10787469
- Foreground services: https://support.google.com/googleplay/android-developer/answer/13392821
- Prominent disclosure: https://support.google.com/googleplay/android-developer/answer/11150561
- App review setup: https://support.google.com/googleplay/android-developer/answer/9859455
- Play App Signing: https://developer.android.com/studio/publish/app-signing
- 16 KB support: https://developer.android.com/guide/practices/page-sizes
