const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  computeFullPrediction,
  generateAlertsFromState
} = require("../server/ml");

function buildSamples({ lowVoltage = null, lowDurationSamples = 0, lowRpm = 900, invalidTail = false } = {}) {
  const start = Date.parse("2026-08-17T12:00:00.000Z");
  const count = 260;
  return Array.from({ length: count }, (_, index) => {
    const inLowWindow = lowVoltage != null && index >= count - lowDurationSamples;
    const voltage = invalidTail && index >= count - 20
      ? 0
      : inLowWindow ? lowVoltage : index < 80 ? 14.25 : 12.84;
    return {
      id: `TS_${index}`,
      ts: new Date(start + index * 5_000).toISOString(),
      orgId: "ORG_TEST",
      vehicleId: "VEH_TEST",
      metrics: {
        rpm: inLowWindow ? lowRpm : 1100,
        batteryVoltage: voltage,
        coolantTemp: 91,
        engineLoad: 34
      }
    };
  });
}

function alertsFor(prediction) {
  return generateAlertsFromState({
    vehicleId: prediction.vehicleId,
    orgId: "ORG_TEST",
    anomalyScore: prediction.anomalyScore == null ? null : prediction.anomalyScore / 100,
    confidence: prediction.confidence,
    risk: prediction.risk,
    historySpanHours: prediction.historySpanHours,
    chargingEvidence: prediction.chargingEvidence,
    climateContext: prediction.climateContext,
    insufficientHistory: prediction.insufficientData
  });
}

const smartCharging = computeFullPrediction(buildSamples(), "VEH_TEST");
assert.strictEqual(smartCharging.chargingEvidence.status, "normal");
assert.strictEqual(alertsFor(smartCharging).some((alert) => alert.type === "CHARGING"), false);

const invalidFrames = computeFullPrediction(buildSamples({ invalidTail: true }), "VEH_TEST");
assert.strictEqual(invalidFrames.chargingEvidence.status, "normal");
assert.strictEqual(invalidFrames.currentMetrics.batteryVoltage, null);
assert.strictEqual(alertsFor(invalidFrames).some((alert) => alert.type === "CHARGING"), false);

const engineOffLow = computeFullPrediction(buildSamples({ lowVoltage: 11.6, lowDurationSamples: 50, lowRpm: 0 }), "VEH_TEST");
assert.strictEqual(engineOffLow.chargingEvidence.status, "normal");
assert.strictEqual(alertsFor(engineOffLow).some((alert) => alert.type === "CHARGING"), false);

const sustainedLow = computeFullPrediction(buildSamples({ lowVoltage: 12.1, lowDurationSamples: 50 }), "VEH_TEST");
assert.strictEqual(sustainedLow.chargingEvidence.status, "warning");
const chargingAlerts = alertsFor(sustainedLow).filter((alert) => alert.type === "CHARGING");
assert.strictEqual(chargingAlerts.length, 1);
assert.strictEqual(chargingAlerts[0].dedupeKey, "ML:VEH_TEST:CHARGING");
assert.match(chargingAlerts[0].explanation, /engine was running/i);
assert.doesNotMatch(chargingAlerts[0].explanation, /over 14 days/i);

const dashboard = fs.readFileSync(path.join(__dirname, "..", "ui", "fleetai-dashboard.html"), "utf8");
assert.match(dashboard, /r\.explanation\|\|r\.message/);
assert.match(dashboard, /data-resolve/);

const serverSource = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
assert.match(serverSource, /async function discoverVehicleContext\(data\)/);
assert.match(serverSource, /primaryVehicles = await sqliteDb\.listVehicles\(\)/);
assert.match(serverSource, /vehicleById\.get\(vehicleId\)\?\.orgId/);
const pipelineSource = serverSource.slice(
  serverSource.indexOf("async function runTelemetryPipeline()"),
  serverSource.indexOf("function triggerTelemetryPipeline()")
);
assert.doesNotMatch(pipelineSource, /const vehicles = \(data\.vehicles \|\| \[\]\)\.map/);
assert.doesNotMatch(serverSource, /const vehicles = \(data\.vehicles \|\| \[\]\)\.map/);

console.log("ML charging evidence and alert regression tests passed");
