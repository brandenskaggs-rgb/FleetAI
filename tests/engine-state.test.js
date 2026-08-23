const assert = require("assert");
const {
  classifyEngineEvent,
  selectEngineRunningSamples,
  computeFullPrediction,
  generateAlertsFromState
} = require("../server/ml");

const START = Date.parse("2026-08-22T12:00:00.000Z");

function sample(index, rpm, speedKph = 0, batteryVoltage = 14.2, extra = {}) {
  return {
    id: `ENGINE_${index}`,
    ts: new Date(START + index * 5_000).toISOString(),
    orgId: "ORG_ENGINE",
    vehicleId: "VEH_ENGINE",
    metrics: Object.assign({
      rpm,
      vehicleSpeed: speedKph,
      batteryVoltage,
      coolantTemp: 91,
      engineLoad: rpm >= 400 ? 24 : 0
    }, extra)
  };
}

function stableIdle(count = 40) {
  return Array.from({ length: count }, (_, index) => sample(index, 680 + (index % 3) * 4));
}

const cleanShutdown = [
  ...stableIdle(),
  sample(40, 0, 0, 12.84),
  sample(41, 0, 0, null),
  sample(42, 0, 0, null),
  sample(43, undefined, 0, 12.8)
];
const cleanEvent = classifyEngineEvent(cleanShutdown);
assert.strictEqual(cleanEvent.status, "intentional_shutdown");
assert.strictEqual(cleanEvent.alertable, false);
assert.ok(cleanEvent.confidence >= 0.85);
assert.strictEqual(selectEngineRunningSamples(cleanShutdown).length, 40);

const roughIdle = [
  ...stableIdle(),
  sample(40, 900),
  sample(41, 420),
  sample(42, 880),
  sample(43, 430),
  sample(44, 860),
  sample(45, 410),
  sample(46, 820),
  sample(47, 425),
  sample(48, 0, 0, 12.8),
  sample(49, 0, 0, null)
];
const roughEvent = classifyEngineEvent(roughIdle);
assert.strictEqual(roughEvent.status, "possible_stall_at_stop");
assert.strictEqual(roughEvent.alertable, true);
assert.ok(roughEvent.evidence.lowRpmDipCount >= 2);

const movingStall = [
  ...Array.from({ length: 20 }, (_, index) => sample(index, 1500, 65)),
  sample(20, 0, 58, 13.9),
  sample(21, 0, 45, 13.4)
];
const movingEvent = classifyEngineEvent(movingStall);
assert.strictEqual(movingEvent.status, "possible_stall_moving");
assert.strictEqual(movingEvent.alertable, true);
assert.ok(movingEvent.confidence >= 0.9);

const serviceGap = [
  ...stableIdle(20),
  Object.assign({}, sample(20, 0), { ts: new Date(START + 20 * 5_000 + 180_000).toISOString() }),
  Object.assign({}, sample(21, 0), { ts: new Date(START + 21 * 5_000 + 180_000).toISOString() })
];
const gapEvent = classifyEngineEvent(serviceGap);
assert.strictEqual(gapEvent.status, "connectivity_unknown");
assert.strictEqual(gapEvent.alertable, false);

const predictionSamples = [
  ...Array.from({ length: 240 }, (_, index) => sample(index, 700 + (index % 4) * 3, 0, 14.2)),
  ...Array.from({ length: 20 }, (_, offset) => sample(240 + offset, 0, 0, offset === 0 ? 12.84 : null))
];
const prediction = computeFullPrediction(predictionSamples, "VEH_ENGINE", {
  make: "Chevrolet",
  model: "Camaro",
  year: 2010
});
assert.strictEqual(prediction.sampleCount, 240);
assert.strictEqual(prediction.excludedEngineOffSamples, 20);
assert.strictEqual(prediction.engineEvent.status, "intentional_shutdown");
assert.strictEqual(prediction.currentMetrics.rpm >= 400, true);
assert.strictEqual(prediction.currentMetrics.batteryVoltage, 14.2);
assert.strictEqual(Object.hasOwn(prediction.weeksToFailure, "batteryVoltage"), false);

const stallAlerts = generateAlertsFromState({
  vehicleId: "VEH_ENGINE",
  orgId: "ORG_ENGINE",
  insufficientHistory: true,
  engineEvent: movingEvent
});
assert.strictEqual(stallAlerts.length, 1);
assert.strictEqual(stallAlerts[0].type, "ENGINE_STALL");
assert.strictEqual(stallAlerts[0].severity, "critical");
assert.match(stallAlerts[0].dedupeKey, /^EVENT:VEH_ENGINE:ENGINE_STALL:/);

const shutdownAlerts = generateAlertsFromState({
  vehicleId: "VEH_ENGINE",
  orgId: "ORG_ENGINE",
  insufficientHistory: false,
  engineEvent: cleanEvent
});
assert.strictEqual(shutdownAlerts.some((alert) => alert.type === "ENGINE_STALL"), false);

console.log("Engine transition classification regression tests passed");
