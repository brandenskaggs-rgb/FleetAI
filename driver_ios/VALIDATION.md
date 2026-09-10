# Apple port validation record

## Checked on Windows

- `node --test tests/ios-driver-contract.test.js`: 7 passed, including cloud-build and simulator-selection checks.
- Tree-sitter Swift 0.7.3 / tree-sitter 0.25.2: all 12 Swift files parsed, including capture lifecycle and UI tests.
- `Info.plist` and `PrivacyInfo.xcprivacy`: valid XML.
- App icon generated from the approved Link SVG; 1024 by 1024 PNG.
- `npm.cmd run launch:check`: passed existing config, preflight, UI, pairing, host and link checks.
- No changes to `driver_app/`, `server.js`, `server/` or `db/` in this implementation.

These are source/contract checks, not proof that an Apple binary builds or reads a real vehicle.

## Verified on GitHub macOS: September 10, 2026

- Code commit: `0d40697`; [successful workflow](https://github.com/brandenskaggs-rgb/FleetAI/actions/runs/34516941060).
- Xcode 16.4, Swift 6.1.2 in Swift 5 language mode, macOS 15 runner.
- Seven Node wire-contract checks passed; twelve core XCTest cases passed.
- XcodeGen generation, property-list validation, unsigned simulator compile and link passed.
- Both onboarding UI tests passed on each of the iPhone and iPad simulators: four executions total.
- Tests captured portrait, landscape and accessibility-size screenshots in the result bundles.
  Screenshot capture is not a completed visual/accessibility audit.
- Initial cloud runs caught three app-layer compile mistakes, now corrected. Simulator selection is
  bounded by the active SDK. Bluetooth delegate conformance retains main-actor isolation.
- Remaining compiler warnings concern skipped App Intents metadata extraction; this app has no App Intents.

## Not run: requires signing / Apple hardware / further review

- VoiceOver, manual screenshot review, multitasking and complete accessibility testing.
- Keychain restore after an actual signed app update.
- Real pairing, BLE service selection, sensor values, disconnect/reconnect and background behavior.
- Offline upload replay and inspection submission against an isolated test fleet.
- TestFlight archive, signing, archive privacy review and App Store review.

## Cloud build active

The GitHub Actions workflow builds an unsigned simulator app and runs two onboarding UI tests on both
an iPhone and iPad simulator. Core capture-generation, adapter-scope and payload-scope regression tests
were added. The cloud run above passed; no signing credentials have been configured.

An unsigned simulator binary was built and tested, not a device-installable release. The port must stay
out of a live truck rollout until the remaining gates pass. See README.md for unported Android features
and hardware limitations. This record-only update does not change the tested app code.
