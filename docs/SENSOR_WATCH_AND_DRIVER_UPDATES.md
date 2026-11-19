# Focused monitoring and Android updates

## Scope and evidence

This change preserves pairing, credentials, queued telemetry, read-only ECU access,
and the existing Node/Python prediction architecture. It does not replace or retrain
models, and does not establish field-validated transmission failure prediction.

The existing models and DTC layer contain drivetrain/transmission-related logic.
The ingestion path now retains available transmission temperature, shaft speeds,
gear, converter slip, pressure, and individual wheel speeds. Unknown values stay
missing, not zero. The sensor inventory recognizes actual enhanced readings even
when the standard OBD capability bitmap cannot describe them.

The J1939 SPN mapping now uses SPN 177 for transmission oil temperature (0.03125 C
per bit, offset -273 C). The erroneous SPN 127 temperature mapping was removed;
127 is transmission oil pressure. This concerns decoded SPN input, not a new
universal raw-CAN adapter implementation.

The Camaro enhanced profile still has no verified OEM sensor definitions. This
change does not invent GM addresses or make unavailable ABS/transmission data
appear. Adapter, ECU, protocol, and a verified vehicle profile must all support
the requested signal. Basic OBD capability is not access to every ECU.

## Advisor sensor watch

- Ask the Advisor to watch a selected vehicle, then confirm the proposed action.
- Authorized operators can request engine, transmission, and brake/traction groups.
- Default duration is 30 minutes; the server permits 5 to 60 minutes.
- The updated OBD service checks for a request every 30 seconds while connected.
- It gives supported signals a bounded scheduling priority increase. It does not
  increase the command budget, bypass read-only policy, or starve overdue signals.
- A request expires automatically. Offline/revoked requests lose their local lease
  within 60 seconds; ordinary telemetry continues normally.
- The server reports waiting, applied, no supported signals, stopped, or expired.
  Applied means the polling plan acknowledged it, not that every sensor is live.
- Watch state and acknowledgments are scoped to the authenticated fleet and paired
  vehicle; acknowledgments must match the current request revision.
- The Advisor receives supported/unavailable signal lists and recent individual
  readings with sample recording timestamps, not guaranteed ECU acquisition times.
  Sparse readings must not be interpreted as simultaneous.
- Sample metadata retains the watch request ID. Current watch storage is not a full
  historical command audit trail; replacing a watch replaces its current record.

Focused polling is implemented for the Android OBD service only. The wired/J1939
service and Apple client do not yet consume these watch commands. There is no
autonomous ECU control, code clearing, repair diagnosis, or promised failure date.
Jerking or suspected braking problems require inspection, not just monitoring.

## Database deployment

Apply the additive Prisma migration `20261118090000_sensor_watch` before running
the updated backend, and generate the Prisma client using the existing deployment
workflow. The new table stores one current watch per organization and vehicle.
No existing customer rows, pairings, models, or telemetry are migrated or deleted.
This migration has not been applied to Railway by this local implementation.

## Wireless update behavior

Android 1.10.6 (version code 18) checks backend release metadata on app resume,
at most once per six hours after a successful check. Settings also has a manual
check. Automatic pop-ups are suppressed while an OBD or J1939 service is running.
Failed checks do not interrupt telemetry or sign out the driver. This is
an availability check, not an unattended installer or continuous background job.

Play/release builds open only Fleet AI's Google Play listing. Pilot/debug builds
may open an HTTPS APK URL on fleetaiops.com under `/downloads/driver/`. Android
still requires user installation approval and matching application ID/signing key.
Do not uninstall to update: uninstalling can remove pairing and offline telemetry.
Install updates while parked, after pending uploads finish whenever possible.

The current installed app needs this update once before it can detect future
releases. Changing backend version numbers alone does not install software.

### Pilot rollout

The 1.10.7 / version-code 19 pilot now uses a packaged deployment artifact in
`releases/driver`. With no explicit pilot release environment variables, the
backend verifies its manifest, file size and SHA-256 before returning update
metadata. The APK and metadata deploy together and survive rebuilds. See
`releases/driver/README.md`. The following volume-based procedure remains an
operator override, not a prerequisite for the packaged pilot release.

1. Build the APK and verify its signing certificate against the installed pilot.
   If the original debug keystore is unavailable, do not overwrite it or instruct
   the driver to uninstall. Recover the original key first.
2. Store the verified APK on a Railway persistent volume or another deployment
   artifact mechanism. Never assume the ephemeral deployment filesystem persists.
3. Set `FLEETAI_DRIVER_RELEASE_DIR` to the absolute persistent APK directory.
4. After staging and checking the file, set these backend variables:
   - `FLEETAI_DRIVER_PILOT_DEBUG_VERSION_CODE=18`
   - `FLEETAI_DRIVER_PILOT_DEBUG_VERSION_NAME=1.10.6`
   - `FLEETAI_DRIVER_PILOT_DEBUG_URL=https://fleetaiops.com/downloads/driver/fleetai-18.apk`
   - Optional `FLEETAI_DRIVER_PILOT_DEBUG_NOTES` (maximum 500 characters).
5. Verify the public metadata endpoint and APK download. The route serves only the
   exact advertised APK filename; it does not expose the release directory.
6. Install once over the existing pilot app. Confirm pairing, offline queue,
   telemetry, and manual update checks on actual hardware before wider rollout.

No release is advertised when configuration is absent. Never publish version
metadata until the corresponding download is available. The public release file
must contain no credentials. Retain prior artifacts privately for recovery; Android
normally rejects version downgrades, so a rollback usually requires a higher-code
build signed with the original key.

### Google Play rollout

Publish the signed bundle through Play's normal testing/review/release process.
Only after the version is available to the intended users, configure
`FLEETAI_DRIVER_PLAY_VERSION_CODE`, `FLEETAI_DRIVER_PLAY_VERSION_NAME`, and optional
`FLEETAI_DRIVER_PLAY_NOTES`. Release builds never install backend-hosted APKs.
Play signing and an existing debug signing key are different channels; do not
assume a Play build can update a debug pilot in place.

## Verification and remaining work

Run `npm run test:sensor-watch`, `npm run test:ai`, `npm run test:integration`,
`npm run launch:check`, `npx prisma validate`, and Android
`testDebugUnitTest assembleDebug`. Tests cover tenant/vehicle scope, confirmation,
role restrictions, stale acknowledgments, missing readings, SPN decoding,
read-only contracts, and allowed release hosts/channels/versions.

Local passing tests are not a road test, OEM compatibility certification, or a
Google Play approval. Still required: deploy migration and backend, stage a
same-key APK, verify over-the-air installation and pairing retention on hardware,
and validate actual supported signals on each vehicle. Existing dependency audit
findings are separate from this feature and must not be interpreted as resolved.

## References

- Veepeak enhanced-feature limitations: https://veepeak.com/pages/obdcheck-ble-plus
- Android app signing: https://developer.android.com/studio/publish/app-signing
- Google Play updates: https://developer.android.com/google/play/app-updates
- J1939 parameter reference: https://c-a-i.net/DOWNLOADS/TMT3978_Parameters.pdf
