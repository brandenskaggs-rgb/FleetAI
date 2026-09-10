const test = require("node:test");
const assert = require("node:assert/strict");
const { repairMetrics, planRepair } = require("../scripts/repair-telemetry-quality");
const { buildTelemetrySample } = require("../server/ml");

test("Pressure units survive ingestion and stale readings remain missing", () => {
  const base = { vehicleId: "fixture", orgId: "org-a", timestamp: "2026-01-01T00:00:00Z", engine: { fuelPressureKpa: 336 } };
  const live = buildTelemetrySample(base);
  assert.equal(live.metrics.fuelPressure, 336);
  assert.equal(live.metrics.fuelPressureKpa, 336);
  const stale = buildTelemetrySample(base, { meta: { metricAgesMs: { fuelPressureKpa: 60000 } } });
  assert.equal(stale.metrics.fuelPressure, null);
  assert.equal(stale.metrics.fuelPressureKpa, null);
});

test("Repairs require source evidence, preserve zeros with meaning, and are idempotent", () => {
  const raw = { fuelPressureKpa: 336, batteryVoltageV: 0 };
  const input = { fuelPressure: 336, batteryVoltage: 0, rpm: 0, vehicleSpeed: 0 };
  const fixed = repairMetrics(input, raw);
  assert.deepEqual(fixed.metrics, { ...input, batteryVoltage: null, fuelPressureKpa: 336 });
  assert.equal(input.batteryVoltage, 0);
  assert.equal(raw.batteryVoltageV, 0);
  assert.deepEqual(repairMetrics(fixed.metrics, raw).reasons, []);
  assert.deepEqual(repairMetrics({ fuelPressure: 48.7 }, raw).reasons, []);
  assert.deepEqual(repairMetrics({ fuelPressure: null }, raw).reasons, []);
});

test("Duplicate repair requires identical scoped observations and raw evidence", () => {
  const row = { id: "one", orgId: "a", vehicleId: "v", ts: "2026-01-01", metrics: { rpm: 1000 }, raw: { rpm: 1000 } };
  const records = [row, { ...row, id: "two" }, { ...row, id: "three", orgId: "b" },
    { ...row, id: "four", raw: { rpm: 1001 } }, { ...row, id: "five", driverId: "another" }];
  const plan = planRepair(records);
  assert.equal(plan.summary.duplicateRows, 1);
  assert.equal(plan.actions[0].before.id, "two");
});
