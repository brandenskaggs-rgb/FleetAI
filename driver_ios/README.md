# Fleet AI Driver for iPhone and iPad

Status: initial native Apple pilot implementation. **Not a validated release or an ELD replacement.**
Android and backend files are not modified by this port. An APK cannot be installed on iOS.
The Apple app has a separate device identity and must receive its own approved dashboard pairing code.
Do not revoke or replace an existing pilot assignment to test this build.

## Implemented

- SwiftUI iPhone/iPad interface, iOS/iPadOS 16 minimum; approved black Link geometry and app icon.
- Existing `/api/pairings/claim` bootstrap, device bearer authentication and tenant header.
- One atomic Keychain session containing tenant, vehicle, driver, assignment and token.
  Credentials are device-only, accessible after first unlock, never printed or stored in preferences.
- Core Bluetooth peripheral discovery, user-selected write/notify characteristics from one service,
  ELM handshake, supported-PID bitmap discovery and serial read-only polling.
- All 60 standard Android J1979 PID keys/decoders are represented. Polling intervals are intentionally
  conservative on BLE. Unknown OEM Mode 22 data is not guessed or probed.
- Celsius and km/h remain the wire units. The screen converts temperatures to Fahrenheit and speed to mph.
- Measured coolant chart and explicit missing/old sensor states. No simulation or demo readings.
- Fresh readings are batched approximately every two seconds, retaining per-metric capture age.
  Network requests do not block the sensor polling loop. A maximum of roughly two seconds of unpersisted
  readings may be lost on abrupt OS termination; stopping capture attempts to save the remaining batch.
- Atomic disk outbox, original timestamps and batch IDs, retry backoff and a newest/oldest delivery split.
  The storage partition includes server, tenant, vehicle, driver, device and assignment. No token is in a
  telemetry record. HTTP redirects are refused. HTTPS is mandatory and cookies are disabled.
- Authorization failures retain records and stop uploads. Permanent request errors retain rejected records.
  A 100,000-record cap stops enqueueing rather than silently deleting records. Errors are shown in the app.
- Explicit pre/post-trip checklist and offline inspection submission with server idempotency key.
- Read-only fleet DTC records and server HOS summary. No clear-code command or raw diagnostic console.

## Hardware boundary

Veepeak documents Apple support for OBDCheck BLE/BLE+ using Bluetooth LE, not Android's Bluetooth Classic
serial connection. Apple Bluetooth settings pairing is not the app's connection workflow.
This implementation discovers the adapter's GATT characteristics rather than inventing undocumented UUIDs.
An installer must confirm the correct write/notify endpoints with the adapter vendor. Once an ELM
handshake and ECU capability discovery succeed, that exact adapter/interface is saved in Keychain,
scoped to the device assignment. Reconnect saved adapter restores it without repeated UUID selection.
There is no verified first-time one-tap Veepeak profile yet. Do not select characteristics on unrelated BLE devices.

A green 9-pin J1939 connector alone does not establish Apple compatibility. The Android USB serial/CAN
driver cannot run on iOS. Wired J1939 collection is deliberately unavailable here until a specific gateway
provides an Apple-supported transport and documented CAN framing/protocol, with any required SDK/accessory
authorization. Existing Motive/ISAAC equipment must not be assumed to expose a third-party data channel.

## Background behavior

The app declares `bluetooth-central` and registers Core Bluetooth restoration. It can handle Bluetooth
events while iOS grants execution time. It **does not guarantee Android-style continuous background service**.
After restoration following termination, a previously confirmed interface can be restored, but collection
still requires an explicit start. Old capture tasks cannot stop or publish into a newer capture run.
Foreground retry and network recovery drain the durable queue while the process can execute. This build
does not yet use a background URLSession upload worker or automatic capture resumption.
Force quit, reboot before first unlock, Bluetooth permission loss, device disconnection and iOS suspension
must all be tested on real hardware. Do not promise uninterrupted capture behind another ELD app yet.

## Build and tests on a Mac

1. Install an Apple-supported Xcode version and its iOS simulator/runtime.
2. Install XcodeGen 2.44.0 or newer. Run `bash driver_ios/scripts/check-apple.sh` from the repository root.
   This runs core XCTest tests, checks property lists, generates the project and builds an unsigned simulator app.
3. Open `driver_ios/FleetAIDriver.xcodeproj`, choose your Apple development team and confirm the bundle ID
   is registered to Fleet AI. Run on an iPhone/iPad. No development-team ID or signing key is committed.
4. For distribution, archive with the current App Store-supported Xcode, then use TestFlight under your
   own Apple Developer account. An actual archive/privacy report, App Store privacy answers, app metadata,
   review access and hardware validation are still required. The privacy manifest is a starting inventory,
   not a guarantee of App Store acceptance.

Windows checks:

```powershell
node --test tests/ios-driver-contract.test.js
# Optional grammar tool, installed in an isolated environment:
artifacts/ios-source-check/Scripts/python.exe driver_ios/scripts/check-swift-syntax.py
```

The Node test checks source contracts, PID table parity and scale constants. It does not execute Swift.
The grammar check does not type-check or link Apple frameworks. `swift test` and the Xcode build must pass
on a Mac before signing/testing. Rebuild the icon from the existing mark using
`node driver_ios/scripts/render-app-icon.js` (repository Playwright dependency).

## Build without owning a Mac

`.github/workflows/apple-driver.yml` builds on GitHub's `macos-15` runner after an Apple-related push to
`clean-auth-rebuild` or a matching pull request. It runs core tests, an unsigned simulator build, and
iPhone/iPad onboarding UI tests with screenshots in the result bundles. XcodeGen and GitHub actions
are pinned to reviewed commits. The job has read-only repository permissions, no signing secrets,
and does not deploy Railway or upload to the App Store. The repository's existing Railway integration
may independently deploy on a branch push; the workflow does not control that integration.

The first successful cloud build tested code commit `0d40697` on September 10, 2026:
[build and test results](https://github.com/brandenskaggs-rgb/FleetAI/actions/runs/34516941060).
Twelve core tests and both onboarding tests on each simulator family passed. See VALIDATION.md for
the distinction between simulator evidence and real-device release gates.
Private-repository macOS runner minutes may incur GitHub charges; review the account's Actions budget
before enabling repeated builds. A cloud simulator app cannot be installed on an iPhone.

For TestFlight delivery, confirm active Apple Developer Program membership at
https://developer.apple.com/account/ and access to https://appstoreconnect.apple.com/ .
Signing requires the Fleet AI team's bundle ID, distribution certificate/private key, and provisioning
profile, or a properly authorized managed-signing setup. Those must be stored in an appropriately
restricted CI environment, never in source or chat. The account holder must accept Apple's agreements.
Do not purchase memberships or provide credentials until the app build and hardware plan are understood.

See [Apple membership options](https://developer.apple.com/support/compare-memberships/) and
[GitHub macOS runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

## Required release evidence

- Xcode simulator build plus core XCTest pass; iPhone and iPad visual/accessibility testing at large text sizes.
- New test vehicle/device assignment, successful claim and restore after upgrade/restart; existing Android
  vehicle session remains unchanged. Reassignment and token-recovery UX still need a dedicated implementation.
- Real Veepeak GATT UUIDs and throughput measurements; ignition-off, out-of-range, partial frames, late
  responses, reconnect and multiple-ECU validation. Supported-PID values must agree with a known-good scan tool.
- Loss of internet, disk full, rejected records, expired authorization, restart and original-timestamp replay.
  Rejected/corrupt-record recovery currently needs engineering support; no export/recovery UI is provided.
- Foreground/background/locked-device/force-quit tests while another app is active.
- Direct ECU DTC capture (currently only fleet records are displayed), VIN/OEM profile integration, GPS,
  advanced J1939, messaging, driver duty edits and complete ELD workflows are not yet ported.
- No macOS, watchOS or tvOS support claim. Apple-silicon Mac availability is disabled in this target.

## Sources checked

- [Apple Bluetooth and accessory interfaces](https://developer.apple.com/bluetooth/)
- [Apple Core Bluetooth background execution](https://developer.apple.com/library/archive/documentation/NetworkingInternetWeb/Conceptual/CoreBluetooth_concepts/CoreBluetoothBackgroundProcessingForIOSApps/PerformingTasksWhileYourAppIsInTheBackground.html)
- [Apple Xcode system requirements](https://developer.apple.com/xcode/system-requirements)
- [Veepeak OBDCheck BLE+ instructions](https://veepeak.com/pages/obdcheck-ble-plus-user-instructions)
