#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
command -v xcodebuild >/dev/null || { echo "Xcode on macOS is required."; exit 1; }
command -v xcodegen >/dev/null || { echo "Install XcodeGen 2.44.0 or newer."; exit 1; }
mkdir -p TestResults
swift test 2>&1 | tee TestResults/core-tests.log
plutil -lint Info.plist Resources/PrivacyInfo.xcprivacy
xcodegen generate
xcodebuild -project FleetAIDriver.xcodeproj -scheme FleetAIDriver \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath DerivedData CODE_SIGNING_ALLOWED=NO build 2>&1 | tee TestResults/build.log
if [ "${RUN_UI_TESTS:-0}" = "1" ]; then
  xcrun simctl list devices available --json > TestResults/simulators.json
  python3 scripts/select-simulators.py TestResults/simulators.json "$(xcrun --sdk iphonesimulator --show-sdk-version)" > TestResults/destinations.txt
  while read -r family udid; do
    xcodebuild -project FleetAIDriver.xcodeproj -scheme FleetAIDriver \
      -destination "platform=iOS Simulator,id=$udid" -destination-timeout 120 \
      -derivedDataPath DerivedData -resultBundlePath "TestResults/$family-$(date +%s).xcresult" \
      -parallel-testing-enabled NO CODE_SIGNING_ALLOWED=NO test 2>&1 | tee "TestResults/$family-tests.log"
    xcrun simctl shutdown "$udid" || true
  done < TestResults/destinations.txt
fi
