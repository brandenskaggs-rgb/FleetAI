'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const swift = read('driver_ios/Sources/Core/ELMProtocol.swift');
const android = read('driver_app/app/src/main/java/com/fleetai/driver/telemetry/J1979Spec.kt');
const specs = [...swift.matchAll(/PIDSpec\((0x[\dA-F]+),"([^"]+)","([^"]+)","([^"]+)",([^)]*)\)/g)].map(m => {
  const args = m[5].split(',').map(value => {
    assert.match(value.trim(), /^[\d./+\-\s]+$/);
    return Function(`"use strict"; return (${value})`)();
  });
  return { command: `01${Number(m[1]).toString(16).toUpperCase().padStart(2,'0')}`, key: m[2], unit: m[4], interval: args[0], bytes: args[1] ?? 1, scale: args[2] ?? 1, offset: args[3] ?? 0 };
});

test('Apple sensor definitions cover the same standard PID keys and widths as Android', () => {
  const kotlin = [...android.matchAll(/PidSpec\("([^"]+)", "([^"]+)", "[^"]+", (\d+), "([^"]+)"/g)];
  assert.equal(specs.length, kotlin.length);
  assert.equal(new Set(specs.map(s=>s.key)).size, specs.length);
  for (const [,command,key,bytes,unit] of kotlin) {
    const match = specs.find(s=>s.command === command);
    assert.ok(match, command); assert.equal(match.key,key); assert.equal(match.bytes,Number(bytes));
    assert.equal(match.unit === 'km/h' ? 'kph' : match.unit, unit);
    assert.ok(match.interval > 0);
  }
});
test('Apple scale definitions preserve canonical sensor units', () => {
  const fixtures = [ ['rpm',6904,1726],['speedKph',100,100],['coolantTempC',130,90],['batteryVoltageV',14000,14],
    ['shortTermFuelTrimBank1Pct',128,0],['engineLoadPct',255,100],['fuelRateLph',100,5],
    ['fuelRailGaugePressureKpa',100,1000],['fuelRailPressureRelativeKpa',100,7.9],
    ['fuelInjectionTimingDeg',26880,0],['actualTorquePct',175,50],['referenceTorqueNm',1000,1000],
    ['odometerKm',1000,100],['commandedEquivalenceRatio',32768,1] ];
  for (const [key,raw,expected] of fixtures) {
    const spec = specs.find(s=>s.key === key);
    assert.ok(Math.abs(raw*spec.scale+spec.offset-expected)<0.000001,key);
  }
});
test('Apple API paths and claim fields are the existing device contracts', () => {
  const contract = read('driver_ios/Sources/Core/DriverContract.swift');
  const kotlin = read('driver_app/app/src/main/java/com/fleetai/driver/network/ApiService.kt');
  for (const route of ['/api/pairings/claim','/api/telemetry/ingest','/api/driver/dvir','/api/vehicle/dtcs','/api/eld/hos/status']) {
    assert.ok(contract.includes(`"${route}"`)); assert.ok(kotlin.includes(`"${route.slice(1)}"`));
  }
  const store = read('driver_ios/Sources/App/DriverStore.swift');
  for (const field of ['pairingCode','driverPin','deviceId','deviceLabel']) assert.ok(store.includes(`"${field}"`));
  const api = read('driver_ios/Sources/App/DriverAPI.swift');
  assert.ok(api.includes('completionHandler(nil)'));
  assert.ok(api.includes('"Authorization"')); assert.ok(api.includes('"X-Tenant-Id"'));
  assert.ok(api.includes('httpCookieStorage = nil'));
});
test('Apple persistence and isolation guardrails remain present', () => {
  const vault = read('driver_ios/Sources/App/SessionVault.swift');
  assert.ok(vault.includes('kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly'));
  assert.ok(!vault.includes('UserDefaults'));
  const queue = read('driver_ios/Sources/Core/DurableOutbox.swift');
  assert.ok(queue.includes('entry.scope == session.scope'));
  assert.ok(queue.includes('options: .atomic'));
  assert.ok(queue.includes('updated.rejected = permanent'));
  assert.ok(queue.includes('throw DriverError.queueFull'));
  const model = read('driver_ios/Sources/App/DriverStore.swift');
  assert.ok(model.includes('Task { await flush() }'));
  const ble = read('driver_ios/Sources/App/BLEVehicleAdapter.swift');
  assert.ok(ble.includes('ELMProtocol.allows(command)'));
  assert.ok(ble.includes('Date() <= responseDeadline'));
});
test('Apple build targets iPhone/iPad with Bluetooth privacy disclosure and no insecure transport exception', () => {
  const plist = read('driver_ios/Info.plist');
  const project = read('driver_ios/project.yml');
  assert.ok(project.includes('TARGETED_DEVICE_FAMILY: "1,2"'));
  assert.ok(plist.includes('NSBluetoothAlwaysUsageDescription'));
  assert.ok(plist.includes('bluetooth-central'));
  assert.ok(!plist.includes('NSAllowsArbitraryLoads'));
  assert.ok(!plist.includes('location</string>'));
  const icon = fs.readFileSync(path.join(root,'driver_ios/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon.png'));
  assert.equal(icon.readUInt32BE(16),1024); assert.equal(icon.readUInt32BE(20),1024);
});

test('cloud Apple checks are unsigned, scoped and do not deploy production', () => {
  const workflow = read('.github/workflows/apple-driver.yml');
  assert.ok(workflow.includes('runs-on: macos-15'));
  assert.ok(workflow.includes('contents: read'));
  assert.ok(workflow.includes('persist-credentials: false'));
  assert.ok(workflow.includes('branches: [clean-auth-rebuild]'));
  assert.ok(!workflow.includes('secrets.'));
  for (const [, ref] of workflow.matchAll(/uses: ([^\s#]+)/g)) assert.match(ref, /@[a-f0-9]{40}$/);
  const check = read('driver_ios/scripts/check-apple.sh');
  assert.ok(check.includes('swift test')); assert.ok(check.includes('CODE_SIGNING_ALLOWED=NO'));
  assert.ok(check.includes('RUN_UI_TESTS'));
});

test('simulator selection requires both device families and iOS 16 or later', () => {
  const { spawnSync } = require('node:child_process');
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const select = inventory => spawnSync(python, [path.join(root,'driver_ios/scripts/select-simulators.py'),'-'], { input:JSON.stringify(inventory), encoding:'utf8' });
  const inventory = { devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-15-0': [{name:'iPhone old',udid:'too-old',isAvailable:true}],
    'com.apple.CoreSimulator.SimRuntime.iOS-18-5': [{name:'iPhone Test',udid:'phone-test',isAvailable:true},{name:'iPad Test',udid:'pad-test',isAvailable:true}],
    'com.apple.CoreSimulator.SimRuntime.tvOS-18-5': [{name:'Apple TV',udid:'tv',isAvailable:true}]
  } };
  const result = select(inventory);
  assert.equal(result.status,0,result.stderr);
  assert.deepEqual(result.stdout.trim().split(/\r?\n/), ['iPhone phone-test','iPad pad-test']);
  inventory.devices['com.apple.CoreSimulator.SimRuntime.iOS-18-5'].pop();
  assert.notEqual(select(inventory).status,0);
});
