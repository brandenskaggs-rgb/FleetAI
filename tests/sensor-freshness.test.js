const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const db = require("../server/db");
const { buildSensorView } = require("../server/telematics/diagnostics/sensorCatalog");
const { sensorTtlMs, sensorAgeMs } = require("../server/telematics/diagnostics/sensorFreshness");
const { registerDiagnosticsRoutes } = require("../server/routes/diagnosticsRoutes");

test("server display expiry matches every standard Android PID interval", () => {
  const source = fs.readFileSync(path.join(__dirname, "../driver_app/app/src/main/java/com/fleetai/driver/telemetry/J1979Spec.kt"), "utf8");
  const entries = [...source.matchAll(/PidSpec\("[^"]+", "([^"]+)", "[^"]+", \d+, "[^"]+", ([\d_]+)/g)];
  assert.ok(entries.length > 50);
  for (const [, key, interval] of entries) assert.equal(sensorTtlMs(key), Math.min(120000, Math.max(30000, Number(interval.replaceAll("_", "")) * 4)), key);
});

test("retained readings remain labeled stale, with age and support preserved", () => {
  const normalized = { engine: { rpm: 700 }, vehicle: { warmupsSinceClear: 8, odometerKm: 12345 } };
  const support = { metricAgesMs: { rpm: 29_000, warmupsSinceClear: 40_000, odometerKm: 40_000 } };
  const view = buildSensorView(normalized, support, { elapsedMs: 2000 });
  const rpm = view.readings.find(r => r.key === "rpm");
  assert.equal(rpm.state, "stale"); assert.equal(rpm.value, null); assert.equal(rpm.lastKnownValue, 700);
  assert.equal(rpm.ageMs, 31_000); assert.equal(rpm.supported, true);
  assert.equal(view.readings.find(r => r.key === "warmupsSinceClear").value, 8);
  assert.equal(view.readings.find(r => r.key === "odometerKmObd").ageMs, 42_000);
  assert.equal(view.readings.find(r => r.key === "warmupsSinceClear").freshnessLimitMs, 120_000);
  assert.equal(normalized.engine.rpm, 700);
  const disconnected = buildSensorView(normalized, support, { elapsedMs: 3000, connectionLive: false });
  assert.equal(disconnected.counts.reporting, 0);
  assert.equal(disconnected.readings.find(r => r.key === "warmupsSinceClear").lastKnownValue, 8);
});

test("invalid age metadata never becomes a new acquisition timestamp", () => {
  for (const age of [null, undefined, "", true, -1, Infinity, "bad"]) assert.equal(sensorAgeMs(age), null);
  assert.equal(sensorAgeMs(0, 500), 500);
});

test("sensor route ages cache between uploads and rejects heartbeat, invalid and future packet times", async t => {
  const handlers = new Map();
  t.mock.method(db, "getVehicleOrgId", async () => "A");
  const now = Date.now();
  const snapshot = { ts: new Date(now - 4000).toISOString(), lastObdPacketAt: new Date(now - 4000).toISOString(),
    busDataActive: true, metrics: { engine: { rpm: 700 }, vehicle: { warmupsSinceClear: 7 } },
    deviceDiagnostics: { metricAgesMs: { rpm: 28_000, warmupsSinceClear: 40_000 } } };
  registerDiagnosticsRoutes({ get: (url, ...fns) => handlers.set(url, fns.at(-1)), post() {} }, {
    requireEmployeeOrCustomerApi() {}, sanitizeString: String, telemetryLatest: new Map([["car", snapshot]])
  });
  async function read() {
    let body;
    await handlers.get("/api/diagnostics/sensors")({ query: { vehicleId: "car" }, customer: { orgId: "A" } },
      { json(value) { body = value; } }, error => { throw error; });
    return body;
  }
  let body = await read();
  assert.equal(body.readings.find(r => r.key === "rpm").state, "stale");
  assert.equal(body.readings.find(r => r.key === "warmupsSinceClear").value, 7);
  snapshot.busDataActive = false;
  assert.equal((await read()).counts.reporting, 0);
  snapshot.busDataActive = true;
  for (const stamp of ["invalid", new Date(now + 60_000).toISOString(), new Date(now - 60_000).toISOString()]) {
    snapshot.lastObdPacketAt = stamp;
    body = await read(); assert.equal(body.counts.reporting, 0); assert.equal(body.stale, true);
  }
});
