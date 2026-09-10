# Apple port validation record

## Checked on Windows

- `node --test tests/ios-driver-contract.test.js`: 7 passed, including cloud-build and simulator-selection checks.
- Tree-sitter Swift 0.7.3 / tree-sitter 0.25.2: all 12 Swift files parsed, including capture lifecycle and UI tests.
- `Info.plist` and `PrivacyInfo.xcprivacy`: valid XML.
- App icon generated from the approved Link SVG; 1024 by 1024 PNG.
- `npm.cmd run launch:check`: passed existing config, preflight, UI, pairing, host and link checks.
- No changes to `driver_app/`, `server.js`, `server/` or `db/` in this implementation.

These are source/contract checks, not proof that an Apple binary builds or reads a real vehicle.

## Not run: requires macOS / Apple hardware

- `swift test`: twelve core XCTest cases supplied, not executed here.
- `bash driver_ios/scripts/check-apple.sh`: XcodeGen project generation, simulator compile and link.
- iPhone/iPad screenshots, Dynamic Type, VoiceOver, rotations and multitasking behavior.
- Keychain restore after an actual signed app update.
- Real pairing, BLE service selection, sensor values, disconnect/reconnect and background behavior.
- Offline upload replay and inspection submission against an isolated test fleet.
- TestFlight archive, signing, archive privacy review and App Store review.

## Cloud build prepared

The GitHub Actions workflow builds an unsigned simulator app and runs two onboarding UI tests on both
an iPhone and iPad simulator. Core capture-generation, adapter-scope and payload-scope regression tests
were added. No cloud run has been dispatched and no signing credentials have been configured.

No Apple binary is attached or represented as tested. The port must stay out of a live truck rollout
until those gates pass. See README.md for unported Android features and hardware limitations.
