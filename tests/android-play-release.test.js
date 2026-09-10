'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = file => fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');

test('Play publication has a separate fail-closed signing gate', () => {
  const gradle = read('driver_app/app/build.gradle');
  assert.ok(gradle.includes("tasks.register('verifyPlayRelease')"));
  for (const text of ['if (!uploadSigningReady)', 'if (!entry.codeSigners)', 'CN=Android Debug', 'expected the production HTTPS origin']) {
    assert.ok(gradle.includes(text), text);
  }
  assert.match(gradle, /applicationId "com\.fleetai\.driver"/);
  assert.match(gradle, /targetSdk 36/);
});

test('location updates explicitly select a Looper for service coroutine callers', () => {
  const tracker = read('driver_app/app/src/main/java/com/fleetai/driver/telemetry/DeviceLocationTracker.kt');
  assert.match(tracker, /requestLocationUpdates\(provider, 1_000L, 5f, this, Looper\.getMainLooper\(\)\)/);
});

test('release documentation tracks manifest service types and actual version', () => {
  const guide = read('driver_app/PLAY_STORE_RELEASE.md');
  const gradle = read('driver_app/app/build.gradle');
  const version = gradle.match(/versionName "([^"]+)"/)[1];
  const code = gradle.match(/versionCode (\d+)/)[1];
  assert.ok(guide.includes('`' + version + '` (`versionCode ' + code + '`)'));
  const manifest = read('driver_app/app/src/main/AndroidManifest.xml');
  assert.match(manifest, /foregroundServiceType="connectedDevice\|location"/);
  assert.ok(!manifest.includes('ACCESS_BACKGROUND_LOCATION'));
  assert.ok(!guide.includes('- `shortService`:'));
});

test('privacy requests use the account-owner-confirmed mailbox', () => {
  const privacy = read('legal/privacy.html');
  assert.ok(privacy.includes('mailto:brandenskaggs@sentinelxinc.com'));
  assert.ok(!/mailto:(support|legal)@fleetai\.com/.test(privacy));
  assert.ok(privacy.includes('Bluetooth OBD-II and USB'));
});
