# Driver Tablet: Link Brand and Read-only Diagnostics

## Release

Android version 1.10.0, versionCode 12. Application ID remains
`com.fleetai.driver`. This is an in-place update, not a replacement package.

## Interface

- Black Link mark on app screens, launcher, Android splash and notification icon.
- Graphite/white and neutral-green surfaces; existing light/dark preference is retained.
- Bundled Source Sans typography, 56dp primary actions, filled form fields.
- Landscape navigation rail and compact-width bottom navigation.
- Pairing has two numbered inputs, optional PIN visibility and expandable tablet details.
- Blender connection illustration is packaged locally; no network fetch is needed.
- Home puts duty status, fault codes and settings within immediate reach.
- Sensors appear before adapter setup, with a sensor search and expandable diagnostics.
- Inspection choices adapt to available width; progress counts completed checks.
- Sign-out and reset-pairing actions require confirmation with a Keep connected option.

The artwork comes from `tools/render-dashboard-connection.py` and the saved
Fleet-AI-Connection Blender scene. The live interface is native Jetpack Compose,
not a rendered image of controls.

## Diagnostic Safety

Removed the driver Clear button, viewmodel clear operation, repository clear
interface and ECU clear method. Both OBD command writers enforce
`ObdReadOnlyPolicy`. Supported services 01/02/03/07/09/0A and extended read
services 21/22 remain available. ELM initialization and header configuration
commands remain available. ECU clearing, ECU writes, resets, routine commands,
security access and multi-command newline injection are rejected.

Service 04 (erase diagnostic information) must not be confused with PID 0104
(read engine load). Regression tests explicitly cover that distinction.
Manufacturer-specific requests retain their existing profile/header validation.
USB J1939 remains listen-only.

This is a read-only product policy, not a claim of regulatory certification.

## Pairing and Data Preservation

No changes to AppPreferences keys, token encryption, Room schema, SessionViewModel,
pairing API payloads, network endpoints, telemetry service, offline outbox or
background uploader. No database or Railway configuration migration is required.
The app shell still creates exactly one shared SensorViewModel owner.

An update preserves data only when installed over the existing app with the same
application ID and signing certificate. Do not uninstall the current app or clear
its storage. The debug APK must not be used to replace a differently signed release.
The user's physical tablet and production fleet records were not modified.

## Verification

- Gradle: `:app:testDebugUnitTest :app:assembleDebug :app:lintDebug`.
- Node: `tests/driver-app-contract.test.js`, `tests/tablet-readonly-contract.test.js`,
  `tests/pairing-bootstrap.test.js`, `tests/telemetry-chain.test.js`.
- Emulator visual smoke: `scripts/tablet-visual-smoke.ps1 -OutputDirectory <path>`.
  It accepts emulator serials only and refuses to run outside the training account.
- Visual evidence uses explicitly selected emulator training data, never pilot telemetry.
- A real adapter/vehicle road test remains necessary before declaring hardware behavior verified.

## APK

`driver_app/app/build/outputs/apk/debug/app-debug.apk`

This artifact is debug-signed for controlled testing, not a Play Store release.
Use the existing release signing process for production distribution.
