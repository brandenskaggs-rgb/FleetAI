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

test('training sessions are blocked before the shared HTTP client sends requests', () => {
  const client = read('driver_app/app/src/main/java/com/fleetai/driver/network/ApiClient.kt');
  assert.ok(client.indexOf('it.trainingSession.first()') < client.indexOf('chain.proceed('));
  assert.match(client, /throw java\.io\.IOException\("Training demo is local only/);
  const prefs = read('driver_app/app/src/main/java/com/fleetai/driver/data/local/AppPreferences.kt');
  assert.match(prefs, /check\(token\.isBlank\(\) \|\| token\.startsWith\("demo_"\)\)/);
});

test('training screen, local-only banner and exit remain available in release source', () => {
  const root = 'driver_app/app/src/main/java/com/fleetai/driver/';
  assert.ok(read(root + 'ui/screens/PairDeviceScreen.kt').includes('View training demo'));
  assert.ok(read(root + 'FleetAIDriverApp.kt').includes('Sample data stays on this device'));
  assert.ok(read(root + 'ui/screens/SettingsScreen.kt').includes('Exit training demo'));
  assert.ok(read(root + 'ui/viewmodel/SettingsViewModel.kt').includes('preferences.exitTrainingSession()'));
  assert.ok(read(root + 'ui/screens/SensorsScreen.kt').includes('showSetup && !trainingDemo'));
});

test('training workflow has release instrumentation coverage, not just source checks', () => {
  const testSource = read('driver_app/app/src/androidTest/java/com/fleetai/driver/TrainingDemoReleaseTest.kt');
  for (const behavior of ['repo.updateDutyStatus', 'repo.submitInspection', 'repo.syncPending',
    'ApiClient.api.getEldDeviceStatus()', 'prefs.exitTrainingSession()', 'assertEquals(0, apiCalls)',
    'repo.certifyEldRecords', 'prefs.startTrainingSession()']) {
    assert.ok(testSource.includes(behavior), behavior);
  }
});
