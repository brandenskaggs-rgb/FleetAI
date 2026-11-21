const test = require("node:test");
const assert = require("node:assert/strict");
const { buildSensorView } = require("../server/telematics/diagnostics/sensorCatalog");

test("retained fuel trims use the tablet metric clock rather than the display alias", () => {
  const result = buildSensorView({engine:{shortTermFuelTrimBank1Pct:0}},
    {metricAgesMs:{shortTermFuelTrimBank1Pct:29_000}}, {elapsedMs:2_000});
  const trim = result.readings.find(r => r.key === "stft1");
  assert.equal(trim.ageMs, 31_000);
  assert.equal(trim.state, "stale");
  assert.equal(trim.value, null);
  assert.equal(trim.lastKnownValue, 0);
});

test("additional decoded channels show measured values without inventing transmission readings", () => {
  const result = buildSensorView({engine:{engineOilPressureKpa:210},electrical:{alternatorVoltageV:13.9}});
  assert.equal(result.readings.find(r => r.key === "engineOilPressureKpa").value, 210);
  assert.equal(result.readings.find(r => r.key === "alternatorVoltageV").value, 13.9);
  const transmission = result.readings.filter(r => r.group === "transmission");
  assert.equal(transmission.length, 6);
  assert.ok(transmission.every(r => r.value === null && !r.supported));
});
