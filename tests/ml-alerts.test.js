const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  computeFullPrediction,
  generateAlertsFromState
} = require("../server/ml");
const { resolveChargingProfile } = require("../server/ml/chargingProfiles");
const { decodeVin } = require("../server/services/vinCapabilityService");

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

const smartCharging = computeFullPrediction(buildSamples(), "VEH_TEST", { make: "Chevrolet", model: "Camaro", year: 2010 });
assert.strictEqual(smartCharging.chargingEvidence.status, "monitor");
assert.strictEqual(smartCharging.chargingEvidence.profileKey, "gm_regulated");
assert.strictEqual(smartCharging.chargingEvidence.nominalTarget, 14);
assert.match(smartCharging.chargingEvidence.explanation, /nominal target/i);
assert.strictEqual(alertsFor(smartCharging).some((alert) => alert.type === "CHARGING"), false);

const freightlinerCharging = computeFullPrediction(buildSamples(), "TRUCK_TEST", { make: "Freightliner", model: "Cascadia", protocol: "J1939" });
assert.strictEqual(freightlinerCharging.chargingEvidence.profileKey, "daimler_truck_heavy");
assert.strictEqual(freightlinerCharging.chargingEvidence.status, "warning");
assert.strictEqual(alertsFor(freightlinerCharging).filter((alert) => alert.type === "CHARGING").length, 1);

assert.strictEqual(resolveChargingProfile({ make: "Ford" }, 12).profileKey, "ford_regenerative");
assert.strictEqual(resolveChargingProfile({ make: "Chevy" }, 12).profileKey, "gm_regulated");
assert.strictEqual(resolveChargingProfile({ make: "Ram" }, 12).profileKey, "stellantis_ibs");
assert.strictEqual(resolveChargingProfile({ make: "Toyota" }, 12).profileKey, "toyota_managed");
assert.strictEqual(resolveChargingProfile({ make: "Honda" }, 12).profileKey, "honda_managed");
assert.strictEqual(resolveChargingProfile({ make: "Nissan" }, 12).profileKey, "nissan_managed");
assert.strictEqual(resolveChargingProfile({ make: "Hyundai" }, 12).profileKey, "hyundai_group_managed");
assert.strictEqual(resolveChargingProfile({ make: "BMW" }, 12).profileKey, "bmw_group_managed");
assert.strictEqual(resolveChargingProfile({ make: "Mercedes-Benz" }, 12).profileKey, "mercedes_managed");
assert.strictEqual(resolveChargingProfile({ make: "Audi" }, 12).profileKey, "volkswagen_group_managed");
assert.strictEqual(resolveChargingProfile({ make: "Volvo" }, 12).profileKey, "volvo_cars_managed");
assert.strictEqual(resolveChargingProfile({ make: "Subaru" }, 12).profileKey, "subaru_managed");
assert.strictEqual(resolveChargingProfile({ make: "Mazda" }, 12).profileKey, "mazda_managed");
assert.strictEqual(resolveChargingProfile({ make: "Tesla" }, 12).profileKey, "ev_low_voltage");
assert.strictEqual(resolveChargingProfile({ make: "Peterbilt", protocol: "J1939" }, 12).profileKey, "paccar_heavy");
assert.strictEqual(resolveChargingProfile({ make: "Kenworth", protocol: "J1939" }, 12).profileKey, "paccar_heavy");
assert.strictEqual(resolveChargingProfile({ make: "Kenworth", protocol: "J1939" }, 12).warningThreshold, 11.9);
assert.strictEqual(resolveChargingProfile({ make: "International", protocol: "J1939" }, 12).profileKey, "international_heavy");
assert.strictEqual(resolveChargingProfile({ make: "Mack", protocol: "J1939" }, 12).profileKey, "volvo_group_heavy");
assert.strictEqual(resolveChargingProfile({ make: "Volvo", protocol: "J1939" }, 24).systemVoltage, 24);
assert.strictEqual(resolveChargingProfile({ make: "Unknown" }, 12).profileKey, "adaptive_fallback");
assert.strictEqual(decodeVin("1FUAAAAAAAAAAAAAA").make, "Freightliner");
assert.strictEqual(decodeVin("1XKAAAAAAAAAAAAAA").make, "Kenworth");
assert.strictEqual(decodeVin("1XPAAAAAAAAAAAAAA").make, "Peterbilt");
assert.strictEqual(decodeVin("1HTAAAAAAAAAAAAAA").make, "International");
assert.strictEqual(decodeVin("4V4AAAAAAAAAAAAAA").make, "Volvo Trucks");
assert.strictEqual(decodeVin("1C6AAAAAAAAAAAAAA").make, "Ram");
assert.strictEqual(decodeVin("1HGAAAAAAAAAAAAAA").make, "Honda");
assert.strictEqual(decodeVin("5NPAAAAAAAAAAAAAA").make, "Hyundai");
assert.strictEqual(decodeVin("KNNAAAAAAAAAAAAAA").make, null);

const invalidFrames = computeFullPrediction(buildSamples({ invalidTail: true }), "VEH_TEST");
assert.ok(["normal", "monitor"].includes(invalidFrames.chargingEvidence.status));
assert.strictEqual(invalidFrames.currentMetrics.batteryVoltage, null);
assert.strictEqual(alertsFor(invalidFrames).some((alert) => alert.type === "CHARGING"), false);

const engineOffLow = computeFullPrediction(buildSamples({ lowVoltage: 11.6, lowDurationSamples: 50, lowRpm: 0 }), "VEH_TEST");
assert.ok(!["warning", "critical"].includes(engineOffLow.chargingEvidence.status));
assert.strictEqual(alertsFor(engineOffLow).some((alert) => alert.type === "CHARGING"), false);

const sustainedLow = computeFullPrediction(buildSamples({ lowVoltage: 12.1, lowDurationSamples: 50 }), "VEH_TEST");
assert.strictEqual(sustainedLow.chargingEvidence.status, "warning");
const chargingAlerts = alertsFor(sustainedLow).filter((alert) => alert.type === "CHARGING");
assert.strictEqual(chargingAlerts.length, 1);
assert.strictEqual(chargingAlerts[0].dedupeKey, "ML:VEH_TEST:CHARGING");
assert.match(chargingAlerts[0].explanation, /engine was running/i);
assert.doesNotMatch(chargingAlerts[0].explanation, /over 14 days/i);

const dutyCycleDrift = buildSamples().map((sample, index) => ({
  ...sample,
  metrics: {
    ...sample.metrics,
    vehicleSpeed: Math.min(130, index * 0.5),
    fuelLevel: Math.max(5, 80 - index * 0.3)
  }
}));
const contextualPrediction = computeFullPrediction(dutyCycleDrift, "VEH_TEST");
assert.strictEqual(Object.hasOwn(contextualPrediction.sensorRisks, "vehicleSpeed"), false);
assert.strictEqual(Object.hasOwn(contextualPrediction.sensorRisks, "fuelLevel"), false);
assert.strictEqual(Object.hasOwn(contextualPrediction.weeksToFailure, "vehicleSpeed"), false);
assert.strictEqual(Object.hasOwn(contextualPrediction.weeksToFailure, "fuelLevel"), false);

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
