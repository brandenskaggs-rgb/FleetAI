/**
 * End-to-end proof of the OBD-II -> tablet -> backend -> dashboard chain.
 *
 * Exercises the real modules (no HTTP, no DB) so the test is deterministic:
 *   1. J1979 PID frames, as an ELM327 returns them
 *   2. decode -> the flat metric map the Android TelemetrySender posts
 *   3. server normalizeMetrics (the step that was returning all-null)
 *   4. broadcast scoping (device / operator / wrong-org / no-org)
 */
const assert = require("assert");
const { normalizeMetrics } = require("../server/telematics/normalize/normalizeMetrics");
const { decodeObd2Frames } = require("../server/telematics/decoders/obd2PidDecoder");
const { buildSensorView } = require("../server/telematics/diagnostics/sensorCatalog");
const { mergePythonAndNodePrediction } = require("../server/lib/mlMerge");
const {
  buildTelemetrySample,
  classifySensorTier,
  computeFullPrediction,
  computeModelState
} = require("../server/ml");

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  -> " + detail : "")); }
}

// ── 1. Raw OBD-II responses, exactly as an ELM327 returns them ───────────────
// Mode 01 response: "41 <pid> <A> <B>"
function decodePid(pid, a, b) {
  switch (pid) {
    case "0C": return { key: "rpm",             value: ((a * 256) + b) / 4 };
    case "0D": return { key: "speedKph",        value: a };
    case "05": return { key: "coolantTempC",    value: a - 40 };
    case "0F": return { key: "intakeAirTempC",  value: a - 40 };
    case "42": return { key: "batteryVoltageV", value: ((a * 256) + b) / 1000 };
    case "04": return { key: "engineLoadPct",   value: (a * 100) / 255 };
    case "10": return { key: "mafGramsPerSec",  value: ((a * 256) + b) / 100 };
    case "11": return { key: "throttlePosPct",  value: (a * 100) / 255 };
    case "2F": return { key: "fuelLevelPct",    value: (a * 100) / 255 };
    case "5C": return { key: "oilTempC",        value: a - 40 };
    default:   return null;
  }
}

console.log("1. OBD-II PID decode (SAE J1979 formulas)");
const frames = [
  ["0C", 0x1A, 0xF8, "rpm",             1726],
  ["0D", 0x5F, 0x00, "speedKph",        95],
  ["05", 0x80, 0x00, "coolantTempC",    88],
  ["42", 0x36, 0x3C, "batteryVoltageV", 13.884],
  ["04", 0x9E, 0x00, "engineLoadPct",   62.0],
  ["10", 0x79, 0x18, "mafGramsPerSec",  310.0],
  ["2F", 0xCC, 0x00, "fuelLevelPct",    80.0],
  ["5C", 0x87, 0x00, "oilTempC",        95]
];
const metrics = {};
for (const [pid, a, b, key, expect] of frames) {
  const d = decodePid(pid, a, b);
  metrics[d.key] = d.value;
  check(`PID 01${pid} -> ${key}`, Math.abs(d.value - expect) < 0.6, `got ${d.value}, expected ~${expect}`);
}

// ── 2. The flat map the tablet posts ─────────────────────────────────────────
console.log("\n2. Tablet -> backend payload");
const tabletPayload = {
  vehicleId: "TRUCK_2701",
  driverId: "DRIVER_001",
  deviceId: "tablet-abc",
  protocol: "OBD2",
  timestamp: new Date().toISOString(),
  metrics,
  obdConnected: true
};
check("payload carries readings", Object.keys(tabletPayload.metrics).length === 8);

// ── 3. Server-side normalization (was returning all null) ────────────────────
console.log("\n3. Server normalizeMetrics(payload.metrics)");
const norm = normalizeMetrics(tabletPayload.metrics);
check("rpm survives",       norm.engine.rpm === metrics.rpm,                       String(norm.engine.rpm));
check("coolant survives",   norm.engine.coolantTempC === metrics.coolantTempC,     String(norm.engine.coolantTempC));
check("speed survives",     norm.vehicle.speedKph === metrics.speedKph,            String(norm.vehicle.speedKph));
check("battery survives",   norm.electrical.batteryVoltageV === metrics.batteryVoltageV, String(norm.electrical.batteryVoltageV));
check("load survives",      norm.engine.engineLoadPct === metrics.engineLoadPct,   String(norm.engine.engineLoadPct));
check("MAF survives",       norm.engine.mafGramsPerSec === metrics.mafGramsPerSec, String(norm.engine.mafGramsPerSec));
check("fuel survives",      norm.vehicle.fuelLevelPct === metrics.fuelLevelPct,    String(norm.vehicle.fuelLevelPct));
check("oil temp survives",  norm.engine.oilTempC === metrics.oilTempC,             String(norm.engine.oilTempC));
const anyNonNull = Object.values(norm.engine).some((v) => v !== null);
check("NOT all-null (the bug)", anyNonNull);

const expanded = decodeObd2Frames([
  { mode: 1, pid: 0x0a, data: [0x20] },
  { mode: 1, pid: 0x23, data: [0x00, 0x64] },
  { mode: 1, pid: 0x0e, data: [0x80] },
  { mode: 1, pid: 0x3c, data: [0x0f, 0xa0] },
  { mode: 1, pid: 0x49, data: [0x80] }
]);
const expandedNorm = normalizeMetrics({
  protocol: "OBD2",
  decoded: { ...expanded, meta: { supportedPids: ["010A", "0123", "010E", "013C", "0149"] } }
});
check("fuel pressure survives", expandedNorm.engine.fuelPressureKpa === 96);
check("fuel rail pressure survives", expandedNorm.engine.fuelRailGaugePressureKpa === 1000);
check("ignition timing survives", expandedNorm.engine.ignitionTimingAdvanceDeg === 0);
check("catalyst temperature survives", expandedNorm.emissions.catalystTempB1S1C === 360);
check("accelerator position survives", Math.abs(expandedNorm.controls.acceleratorPedalDPosPct - 50.196) < 0.01);
const expandedView = buildSensorView(expandedNorm, expandedNorm.meta);
check("sensor inventory reports expanded signals", expandedView.counts.reporting >= 5);
check("capability metadata matches canonical PID format", expandedView.readings.find(r => r.key === "fuelPressureKpa")?.supported === true);
const expandedSample = buildTelemetrySample(expandedNorm);
check("ML snapshot retains fuel pressure", expandedSample.metrics.fuelPressure === 96);
check("ML snapshot retains rail pressure", expandedSample.metrics.fuelRailPressureGauge === 1000);
check("ML snapshot retains catalyst temperature", expandedSample.metrics.catalystTempB1S1 === 360);
const staleSample = buildTelemetrySample(norm, {
  rawPids: Object.assign({ vin: "1G1TESTVIN0000000" }, metrics),
  meta: { metricAgesMs: { coolantTempC: 45_000, rpm: 500 } }
});
check("stale PID is excluded from ML current metrics", staleSample.metrics.coolantTemp === null);
check("fresh PID remains available to ML", staleSample.metrics.rpm === metrics.rpm);
check("VIN is not copied into every raw sample", staleSample.raw.vin === undefined);
check("104C heat soak is not a light-duty danger tier", classifySensorTier("coolantTemp", 104, { vehicleClass: "passenger_car" }) === "NORMAL");

// ── 4. Broadcast scoping ─────────────────────────────────────────────────────
console.log("\n4. Real-time fan-out scoping");
const subs = new Set();
function mkSub(scope) {
  const frames = [];
  const r = { write: (f) => frames.push(f), __fleetScope: scope, frames };
  subs.add(r);
  return r;
}
function broadcast(snapshot, orgId) {
  const frame = `data: ${JSON.stringify(snapshot)}\n\n`;
  for (const sub of subs) {
    const scope = sub.__fleetScope;
    if (!scope) continue;
    if (scope.kind === "device" && scope.vehicleId !== snapshot.vehicleId) continue;
    if (scope.kind === "operator") {
      if (!scope.orgId) continue;
      if (orgId && scope.orgId !== orgId) continue;
      if (!orgId) continue;
    }
    sub.write(frame);
  }
}

const ownerOp   = mkSub({ kind: "operator", orgId: "ORG_A" });
const otherOp   = mkSub({ kind: "operator", orgId: "ORG_B" });
const noOrgOp   = mkSub({ kind: "operator", orgId: null });
const ownDevice = mkSub({ kind: "device", vehicleId: "TRUCK_2701", orgId: "ORG_A" });
const othDevice = mkSub({ kind: "device", vehicleId: "TRUCK_9999", orgId: "ORG_A" });

broadcast({ vehicleId: "TRUCK_2701", metrics: norm }, "ORG_A");

check("owning org receives",        ownerOp.frames.length === 1);
check("other org receives NOTHING", otherOp.frames.length === 0);
check("unresolved org fails closed", noOrgOp.frames.length === 0);
check("paired device receives",     ownDevice.frames.length === 1);
check("other device receives NOTHING", othDevice.frames.length === 0);

const payload = JSON.parse(ownerOp.frames[0].replace(/^data: /, "").trim());
check("frame carries real values", payload.metrics.engine.rpm === metrics.rpm);

// Heartbeats prove transport liveness but contain no mechanical evidence. They
// must never increase ML sample count or confidence.
const heartbeatSamples = Array.from({ length: 100 }, (_, index) => ({
  vehicleId: "TRUCK_2701",
  ts: new Date(Date.now() + index).toISOString(),
  metrics: Object.fromEntries([
    "rpm", "coolantTemp", "batteryVoltage", "engineLoad", "vehicleSpeed"
  ].map((key) => [key, null])),
  raw: { heartbeatMs: Date.now() + index }
}));
const heartbeatPrediction = computeFullPrediction(heartbeatSamples, "TRUCK_2701");
check("heartbeats do not count as ML samples", heartbeatPrediction.sampleCount === 0);
check("heartbeat-only prediction stays insufficient", heartbeatPrediction.insufficientData === true);
const heartbeatState = computeModelState({ telemetrySamples: heartbeatSamples }, "TRUCK_2701");
check("heartbeats do not train model state", heartbeatState.sampleCount === 0 && heartbeatState.insufficientHistory === true);

const burstSamples = Array.from({ length: 300 }, (_, index) => {
  const ts = Date.now() + index * 5_000;
  const base = {
    vehicleId: "TRUCK_2701",
    orgId: "ORG_A",
    metrics: { rpm: 1200, coolantTemp: 94, batteryVoltage: 14.2, engineLoad: 35, vehicleSpeed: 60 }
  };
  return [
    Object.assign({ id: `burst-a-${index}`, ts: new Date(ts).toISOString() }, base),
    Object.assign({ id: `burst-b-${index}`, ts: new Date(ts + 50).toISOString() }, base)
  ];
}).flat();
const burstPrediction = computeFullPrediction(burstSamples, "TRUCK_2701");
check("parallel burst samples coalesce into physical observations", burstPrediction.sampleCount === 300, String(burstPrediction.sampleCount));
check("confidence is capped by operating time and sessions", burstPrediction.confidence < 0.7, String(burstPrediction.confidence));
const mergedPrediction = mergePythonAndNodePrediction(
  Object.assign({}, burstPrediction, { confidence: 0.42, insufficientHistory: true }),
  { confidence: 0.91, prediction: "normal", healthScore: 90 },
  { vehicleId: "TRUCK_2701" }
);
check("Python confidence cannot exceed observed-data confidence", mergedPrediction.confidence === 0.42, String(mergedPrediction.confidence));
check("Python merge preserves insufficient-history state", mergedPrediction.insufficientHistory === true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
