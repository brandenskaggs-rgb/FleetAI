# Fleet AI Driver - Google Play Release

This checklist covers the Android app in `driver_app`. It is an engineering and Play submission guide, not legal advice or a guarantee of approval. Google Play and transportation regulators make the final determinations.

## Release identity

- App name: Fleet AI Driver
- Application ID: `com.fleetai.driver`
- Current release: `1.9.0` (`versionCode 11`)
- Minimum Android: API 26 (Android 8)
- Target Android: API 36 (Android 16)
- Production API: `https://fleetaiops.com`
- Privacy policy: `https://fleetaiops.com/legal/privacy.html`
- Terms: `https://fleetaiops.com/legal/terms.html`

The application ID becomes permanent after publication. Confirm ownership and naming before the first production release.

## Build and signing

New Play apps must use Play App Signing. Create a separate upload key outside this repository and never commit the keystore or passwords.

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
.\gradlew.bat testDebugUnitTest lintRelease bundleRelease
```

Upload `app/build/outputs/bundle/release/app-release.aab`. Without all four signing variables, Gradle intentionally creates an unsigned bundle that cannot be uploaded.

The bundle configuration must report `PAGE_ALIGNMENT_16K`. Increase `versionCode` for every later Play upload.

## Play Console declarations

### App access

The pairing flow normally requires an expiring dispatch code. In review instructions, tell Google:

1. Open Fleet AI Driver.
2. Tap **View training demo** below the pairing form.
3. The demo uses local sample data and cannot access a customer fleet.
4. Open Sensors to view sample telemetry and Settings to view legal links.

Do not give Google a real customer pairing code or driver PIN.

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
- Drivers can request access or deletion through their employer or `support@fleetai.com`, subject to required fleet and regulatory retention.
- Confirm that `support@fleetai.com` and `legal@fleetai.com` are monitored before submission.

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

- `connectedDevice`: user starts a listen-only USB J1939 connection; uninterrupted access is needed to read the attached truck interface. The ongoing notification shows status and has a Stop action.
- `location`: only used when the driver separately enables live location; it attaches location to active vehicle telemetry for the authorized fleet map.
- `shortService`: used only while establishing the external device connection, then transitions to `connectedDevice` or stops.

The app does not declare `ACCESS_BACKGROUND_LOCATION` and does not declare a `dataSync` foreground service.

### Other App content answers

- Ads: No.
- Target audience: business fleet drivers; not directed to children.
- Content rating: complete the Play questionnaire using the actual app content.
- Privacy policy: use the public URL above, not a PDF.
- App category: Auto & Vehicles or Business, based on the final listing strategy.
- Restricted access: include the training-demo review instructions.

For a personal developer account created after November 13, 2023, complete a closed test with at least 12 opted-in testers for 14 continuous days before applying for production access.

## Store listing assets

Prepare these separately in Play Console:

- 512 x 512 PNG app icon without transparency.
- 1024 x 500 feature graphic.
- At least two phone screenshots.
- Tablet screenshots from both 7-inch and 10-inch layouts because this is a tablet-focused product.
- Support email and website.

Suggested short description:

> Pair a fleet tablet, capture vehicle telemetry, complete logs, and share live status.

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
