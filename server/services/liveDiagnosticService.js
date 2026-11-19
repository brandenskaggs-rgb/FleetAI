const { SENSORS, readPath } = require("../telematics/diagnostics/sensorCatalog");
const { decodeCode } = require("../telematics/diagnostics/dtcCatalog");
const { sensorTtlMs, sensorAgeMs } = require("../telematics/diagnostics/sensorFreshness");
const { sanitizeObdFaultRead, faultReadCodes, COVERAGE } = require("../telematics/diagnostics/obdFaultRead");

const SAMPLE_KEYS = {
  speedKph: "vehicleSpeed", coolantTempC: "coolantTemp", oilTempC: "oilTemp", batteryVoltageV: "batteryVoltage",
  engineLoadPct: "engineLoad", torquePct: "engineTorque", fuelRateLph: "fuelRate", intakeAirTempC: "intakeAirTemp",
  mafGramsPerSec: "maf", throttlePosPct: "throttlePos", fuelLevelPct: "fuelLevel", absoluteLoadPct: "absoluteLoad",
  ignitionTimingAdvanceDeg: "ignitionTiming", fuelRailPressureRelativeKpa: "fuelRailPressureRelative",
  fuelRailGaugePressureKpa: "fuelRailPressureGauge", fuelRailAbsolutePressureKpa: "fuelRailPressureAbsolute",
  shortTermFuelTrimBank1Pct: "stft1", longTermFuelTrimBank1Pct: "ltft1", shortTermFuelTrimBank2Pct: "stft2", longTermFuelTrimBank2Pct: "ltft2",
  brakePedalPositionPct: "brakePedalPosition", dpfSootLoadPct: "dpfSootLoad",
  o2B1S1VoltageV: "o2B1S1Voltage", o2B1S2VoltageV: "o2B1S2Voltage", o2B2S1VoltageV: "o2B2S1Voltage", o2B2S2VoltageV: "o2B2S2Voltage",
  catalystTempB1S1C: "catalystTempB1S1", catalystTempB2S1C: "catalystTempB2S1", catalystTempB1S2C: "catalystTempB1S2", catalystTempB2S2C: "catalystTempB2S2",
  commandedEgrPct: "commandedEgr", egrErrorPct: "egrError", commandedEquivalenceRatio: "equivalenceRatio", fuelInjectionTimingDeg: "fuelInjectionTiming"
};
const finite = value => value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);
const time = value => value == null ? NaN : new Date(value).getTime();
const iso = value => Number.isFinite(time(value)) ? new Date(value).toISOString() : null;

function isLiveDiagnosticRequest(message) {
  const text = String(message || "");
  if (/\b(don't|do not|never|cancel|stop|what is|how does|how do|explain|describe)\b/i.test(text)) return false;
  return /\bscan (?:my|the|this) (?:car|truck|vehicle)\b/i.test(text)
    || /\b(run|perform|do|start)\s+(?:(?:a|the|another|new|full|live|diagnostic|sensor)\s+)*scan\b/i.test(text)
    || (/\b(run|perform|do|start|give me|check)\b/i.test(text)
      && /\b(live diagnostic|diagnostic scan|sensor scan)\b/i.test(text));
}

function coverage(readings, group) {
  const rows = readings.filter(r => r.group === group);
  return { fresh: rows.filter(r => r.state === "fresh").map(r => r.signal),
    recorded: rows.filter(r => r.value !== null).map(r => r.signal),
    unreported: rows.filter(r => r.value === null).map(r => r.signal) };
}

async function runLiveDiagnostic({ prisma, orgId, vehicleId, telemetryLatest = new Map(), now = new Date() }) {
  if (!orgId || !vehicleId) throw new Error("live_diagnostic_scope_required");
  const vehicle = await prisma.vehicle.findFirst({ where: { orgId, vehicleId }, select: { vehicleId: true, unitName: true } });
  if (!vehicle) return null;
  const nowMs = now.getTime();
  const where = { orgId, vehicleId, vehicle: { orgId } };
  const samples = await prisma.telemetrySample.findMany({ where, orderBy: { ts: "desc" }, take: 120,
    select: { id: true, orgId: true, vehicleId: true, ts: true, metrics: true, raw: true } });
  const rows = samples.filter(s => s.orgId === orgId && s.vehicleId === vehicleId && Number.isFinite(time(s.ts)) && time(s.ts) <= nowMs + 5000);
  const prediction = await prisma.mlPredictionRun.findFirst({ where, orderBy: { createdAt: "desc" },
    select: { id: true, modelVersion: true, source: true, confidenceStage: true, createdAt: true, healthScore: true, riskProbability: true, confidence: true } });
  const cached = telemetryLatest.get(vehicleId);
  // A global vehicle cache is never sufficient proof of tenant ownership.
  const snapshot = cached?.metrics?.orgId === orgId && cached?.vehicleId === vehicleId ? cached : null;
  const packetAge = nowMs - time(snapshot?.lastObdPacketAt);
  const cacheElapsed = nowMs - time(snapshot?.ts);
  const busLive = snapshot?.busDataActive === true && packetAge >= -5000 && packetAge <= 15_000 && cacheElapsed >= -5000 && cacheElapsed <= 15_000;
  const ages = snapshot?.deviceDiagnostics?.metricAgesMs || {};
  const readings = SENSORS.map(sensor => {
    const sampleKey = SAMPLE_KEYS[sensor.key] || sensor.key;
    const sample = rows.find(row => finite(row.metrics?.[sampleKey]) !== null);
    const historical = sample ? finite(sample.metrics[sampleKey]) : null;
    const cachedValue = finite(readPath(snapshot?.metrics, sensor.path));
    const totalAge = sensorAgeMs(ages[sensor.key], cacheElapsed);
    const fresh = busLive && cachedValue !== null && totalAge !== null && totalAge <= sensorTtlMs(sensor.key);
    // Retained cache values without acquisition ages must not turn into fresh evidence.
    const value = fresh ? cachedValue : historical;
    const recordedAt = fresh ? iso(snapshot.ts) : iso(sample?.ts);
    const state = fresh ? "fresh" : sample ? (nowMs - time(sample.ts) <= 30_000 ? "recent_record" : "stale") : "unreported";
    return { signal: sensor.key, label: sensor.label, value, unit: sensor.unit, group: sensor.group, state,
      recordedAt, ageMs: fresh ? totalAge : sample ? Math.max(0, nowMs - time(sample.ts)) : null,
      source: fresh ? "live_cache" : sample ? `sample:${sample.id}` : null };
  });
  const consumed = new Set(SENSORS.map(s => SAMPLE_KEYS[s.key] || s.key));
  // Include numeric uploaded signals not yet named in the catalog, without guessing their units.
  for (const sample of rows) for (const [key, value] of Object.entries(sample.metrics || {})) {
    if (consumed.has(key) || finite(value) === null || readings.length >= 250) continue;
    consumed.add(key);
    readings.push({ signal: key, label: key, value: finite(value), unit: "not specified", group: "other", state: nowMs - time(sample.ts) <= 30_000 ? "recent_record" : "stale",
      recordedAt: iso(sample.ts), ageMs: Math.max(0, nowMs - time(sample.ts)), source: `sample:${sample.id}` });
  }
  const dtcCandidates = rows.filter(r => Array.isArray(r.raw?.activeDTCs) && ["read", "stale"].includes(r.raw.dtcScanStatus) && Number.isFinite(time(r.raw.dtcCapturedAt)));
  const meta = snapshot?.deviceDiagnostics;
  if (meta && Array.isArray(snapshot?.metrics?.dtc?.active) && ["read", "stale"].includes(meta.dtcScanStatus) && Number.isFinite(time(meta.dtcCapturedAt))) {
    dtcCandidates.push({ raw: { activeDTCs: snapshot.metrics.dtc.active.map(c => typeof c === "string" ? c : c.code), dtcCapturedAt: meta.dtcCapturedAt, dtcScanStatus: meta.dtcScanStatus } });
  }
  for (const raw of [...rows.map(row => row.raw), meta]) {
    const read = sanitizeObdFaultRead(raw?.obdFaultRead);
    if (read) dtcCandidates.push({ raw: { obdFaultRead: read, dtcCapturedAt: read.capturedAt, dtcScanStatus: "read" } });
  }
  const dtc = dtcCandidates.filter(r => time(r.raw.dtcCapturedAt) <= nowMs + 5000).sort((a, b) => time(b.raw.dtcCapturedAt) - time(a.raw.dtcCapturedAt) || Number(!!b.raw.obdFaultRead) - Number(!!a.raw.obdFaultRead))[0]?.raw;
  const faultRead = dtc?.obdFaultRead;
  const faultCodes = { status: !dtc ? "not_read" : dtc.dtcScanStatus === "read" && nowMs - time(dtc.dtcCapturedAt) <= 60_000 ? "recent_report" : "historical",
    capturedAt: iso(dtc?.dtcCapturedAt), completeness: faultRead?.status || "legacy_read", milOn: faultRead?.milOn ?? null,
    coverage: faultRead ? COVERAGE : "Only uploaded codes are available; TPMS/ABS module coverage is not verified.",
    codes: faultRead ? faultReadCodes(faultRead).slice(0, 200).map(item => ({ ...decodeCode(item.code), codeStatus: item.codeStatus })) : (dtc?.activeDTCs || []).slice(0, 200).map(decodeCode) };
  const counts = Object.fromEntries(["fresh", "recent_record", "stale", "unreported"].map(state => [state, readings.filter(r => r.state === state).length]));
  const transmission = coverage(readings, "transmission");
  const brakes = coverage(readings, "brakes");
  const report = { vehicleId, vehicleName: vehicle.unitName || vehicleId, generatedAt: now.toISOString(),
    mode: "read_only_received_telemetry", connection: busLive ? "recent_bus_packets" : "live_connection_not_verified",
    counts, transmission, brakes, faultCodes, readings,
    modelEvidence: prediction ? { ...prediction, healthScore: finite(prediction.healthScore), riskProbability: finite(prediction.riskProbability), confidence: finite(prediction.confidence),
      createdAt: iso(prediction.createdAt), recomputed: false, stale: nowMs - time(prediction.createdAt) > 60_000 || time(prediction.createdAt) > nowMs + 5000 } : null,
    limitations: ["Analyzes received telemetry only; no ECU command, actuator test, code clearing, or guaranteed diagnosis.",
      "Unreported means no reading in the available window, not proof of an unsupported or broken sensor.",
      "Recent records carry upload sample times, not verified live connection or exact ECU acquisition times.",
      "Synthetic model validation is not proven field accuracy. Existing ML results are dated evidence, not a new prediction.",
      "This is a point-in-time report, not a newly started continuous monitoring session. A jerking vehicle needs inspection; this report cannot establish safety to drive."] };
  const currentCodes = faultCodes.status === "recent_report" ? faultCodes.codes.filter(code => code.codeStatus !== "permanent") : [];
  const details = faultCodes.codes.slice(0, 5).map(code => `${code.code}${code.codeStatus ? ` (${code.codeStatus})` : ""}: ${code.parameter || "reported fault"}`).join("; ");
  report.summary = [
    counts.fresh ? `I checked the latest received data for ${report.vehicleName}. ${counts.fresh} sensor readings have fresh timing evidence.` : `I checked the available records for ${report.vehicleName}, but I cannot verify fresh live sensor readings right now.`,
    `${counts.recent_record} readings are from recent stored samples, ${counts.stale} are stale, and ${counts.unreported} catalog signals have no reading in this window.`,
    faultCodes.status === "not_read" ? "I don't have a verified fault-code read. That does not mean there are no faults." : faultCodes.status === "historical" ? `The fault-code read is historical (${faultCodes.capturedAt}); it is not a new scan.` : details ? `The latest reported codes are ${details}.` : `No code entries were received at ${faultCodes.capturedAt}. This does not establish a complete or clean scan.`,
    faultCodes.completeness === "inconsistent" ? "The check-engine status and code read disagree. The read is incomplete, not a clean scan."
      : faultCodes.completeness === "partial" ? "Some fault-code or monitor requests had no valid response. The read is partial."
        : "Only the reported diagnostic coverage is available, not a complete all-module scan.",
    faultCodes.milOn === true ? "The ECU reported the check-engine lamp commanded on at the recorded read time. Have the warning investigated." : faultCodes.coverage,
    transmission.fresh.length ? `${transmission.fresh.length} transmission readings are fresh; the report lists their values and the missing signals.` : "There are no verified fresh transmission readings, so I cannot confirm transmission slip or rule out a transmission problem.",
    brakes.fresh.some(k => k.startsWith("wheelSpeed")) ? "Wheel-speed coverage is listed in the report; partial coverage cannot rule out an ABS or traction problem." : "I cannot verify fresh individual wheel-speed readings for ABS/traction analysis.",
    currentCodes.some(c => c.driveability === "stop") ? "The code catalog flags a stop-driving fault. Stay parked and arrange inspection." : "This does not establish that the vehicle is safe to drive; jerking or suspected braking faults need inspection.",
    "This analyzed uploaded readings; it did not command a new ECU scan or start continuous monitoring. The saved report includes timestamps, available model evidence, and sensor coverage."
  ].join("\n\n");
  return report;
}

module.exports = { isLiveDiagnosticRequest, runLiveDiagnostic };
