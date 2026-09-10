const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const base = path.join(__dirname, '..', 'driver_app', 'app', 'src', 'main');
const source = (name) => fs.readFileSync(path.join(base, 'java', 'com', 'fleetai', 'driver', name), 'utf8');

test('driver has no code-erasure UI, viewmodel or repository method', () => {
  for (const file of ['ui/screens/DiagnosticsScreen.kt', 'ui/viewmodel/DiagnosticsViewModel.kt',
    'data/repository/DriverRepository.kt', 'data/repository/DefaultDriverRepository.kt', 'obd/ObdConnectionManager.kt']) {
    assert.doesNotMatch(source(file), /clearDtcs|clearDiagnosticCodes|viewModel\.clear\(/);
  }
  assert.match(source('ui/screens/DiagnosticsScreen.kt'), /Read-only diagnostics/);
});

test('both OBD command writers apply read-only policy before writing', () => {
  assert.match(source('obd/ObdConnectionManager.kt'), /sendCommandUnlocked\(command: String\)[\s\S]*?require\(ObdReadOnlyPolicy\.allows\(command\)\)[\s\S]*?Transport\.BLE/);
  assert.match(source('obd/ClassicBluetoothObdTransport.kt'), /require\(ObdReadOnlyPolicy\.allows\(command\)\)[\s\S]*?out\.write/);
  assert.match(source('j1939/UsbJ1939Transport.kt'), /SlcanCodec\.OPEN_LISTEN_ONLY/);
});

test('pairing submission retains its existing contract without a sign-out shortcut', () => {
  const screen = source('ui/screens/PairDeviceScreen.kt');
  assert.match(screen, /claimPairing\(pairingCode, driverPin, deviceLabel\)/);
  assert.match(screen, /pairingCode\.length != 6/);
  assert.match(screen, /driverPin\.length != 6/);
  assert.doesNotMatch(screen, /sessionViewModel\.logout\(/);
});

test('existing sign-in storage and app identity remain stable', () => {
  const prefs = source('data/local/AppPreferences.kt');
  assert.match(prefs, /preferencesDataStore\(name = "fleet_driver_prefs"\)/);
  for (const key of ['tenant_id', 'driver_id', 'auth_token', 'vehicle_id', 'device_id', 'assignment_id', 'obd_device_address']) {
    assert.ok(prefs.includes('"' + key + '"'), key);
  }
  const build = fs.readFileSync(path.join(base, '..', '..', 'build.gradle'), 'utf8');
  assert.match(build, /applicationId "com\.fleetai\.driver"/);
  assert.match(source('ui/screens/SettingsScreen.kt'), /Keep connected/);
});

test('new Link mark replaces the old splash and screen references', () => {
  const splash = fs.readFileSync(path.join(base, 'res', 'values-v31', 'themes.xml'), 'utf8');
  assert.match(splash, /windowSplashScreenAnimatedIcon">@drawable\/ic_launcher_foreground/);
  assert.doesNotMatch(splash, /fleet_ai_logo/);
  assert.match(source('ui/components/FleetBrandMark.kt'), /ContentScale\.Fit/);
});

test('Home does not restore a previously open Settings screen', () => {
  const shell = source('FleetAIDriverApp.kt');
  assert.equal((shell.match(/restoreState = screen != MainScreen.Home/g) || []).length, 2);
  assert.doesNotMatch(shell, /restoreState = true/);
});
