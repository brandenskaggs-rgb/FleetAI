# Pilot Android update artifacts

The current pilot APK and `pilot.json` ship together as immutable deployment
artifacts. This small pilot release is tracked in Git so Railway recreates it on
every deployment, without relying on an ephemeral uploaded file. Only the exact
advertised APK is served; this directory is not a static website mount.

Version 1.10.11 / 23 uses the same debug signing certificate and application ID
(`com.fleetai.driver`) as the existing 1.10.6 through 1.10.10 pilots. Signing keys are NOT stored
here. Do not replace the pilot key with the Google Play upload key. This is not
a Google Play release and must not be advertised on the Play channel.

The backend verifies the artifact's size and SHA-256 before advertising it.
Explicit `FLEETAI_DRIVER_PILOT_DEBUG_*` environment configuration still overrides
this packaged release and requires a real file in `FLEETAI_DRIVER_RELEASE_DIR`.
An invalid or incomplete override fails closed rather than falling back.

For subsequent pilot updates: increment Android versionCode/versionName, build
with the original key, verify signing and tests, copy the generated APK here,
update the manifest, then test `tests/driver-release-publishing.test.js` and deploy.
Do not publish metadata ahead of its file. Keep prior artifacts in Git history.
For a larger release history, move artifacts to a persistent artifact store and
use the existing operator-configured directory path instead of adding binaries.

Install while parked and let pending telemetry uploads finish. Choose Update,
not uninstall. Pairing preferences, tokens and the local database are unchanged
by this release; uninstalling or clearing app data would erase local state.
