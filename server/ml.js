const crypto = require("crypto");

const MIN_SAMPLES = 200;
const EWMA_ALPHA = 0.18;

const METRIC_KEYS = [
  "rpm",
  "vehicleSpeed",
  "coolantTemp",
  "oilTemp",
  "batteryVoltage",
  "engineLoad",
  "engineTorque",
  "fuelRate",
  "intakeAirTemp",
  "maf",
  "throttlePos",
  "intakeManifoldPressure",
  "dpfSootLoad",
  "ambientTemp",
  "fuelLevel"
];

const RISK_METRICS = {
  cooling: ["coolantTemp"],
  charging: ["batteryVoltage"],
  fuel: ["fuelRate", "maf", "throttlePos", "fuelLevel"]
};

const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));

function makeId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function computeSlope(values) {
  const n = values.length;
  if (n < 2) return 0;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumX2 = 0;
  for (let i = 0; i < n; i += 1) {
    const x = i;
    const y = values[i];
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumX2 += x * x;
  }
  const denom = n * sumX2 - sumX * sumX;
  if (!denom) return 0;
  return (n * sumXY - sumX * sumY) / denom;
}

function computeBaseline(values) {
  if (!values.length) {
    return { count: 0, mean: null, std: null, min: null, max: null, slope: 0 };
  }
  let mean = null;
  let variance = null;
  let min = values[0];
  let max = values[0];
  values.forEach((val) => {
    const v = toNumber(val);
    if (v === null) return;
    min = Math.min(min, v);
    max = Math.max(max, v);
    if (mean === null) {
      mean = v;
      variance = 0;
      return;
    }
    mean = EWMA_ALPHA * v + (1 - EWMA_ALPHA) * mean;
    const diff = v - mean;
    variance = EWMA_ALPHA * diff * diff + (1 - EWMA_ALPHA) * variance;
  });
  const std = variance != null ? Math.sqrt(variance) : null;
  return {
    count: values.length,
    mean,
    std,
    min,
    max,
    slope: computeSlope(values)
  };
}

function computeBaselines(samples) {
  const baselines = {};
  METRIC_KEYS.forEach((key) => {
    const values = samples.map((s) => toNumber(s.metrics?.[key])).filter((v) => v != null);
    baselines[key] = computeBaseline(values);
  });
  return baselines;
}

function computeCoverage(baselines) {
  const total = METRIC_KEYS.length;
  const available = METRIC_KEYS.filter((key) => {
    const baseline = baselines[key];
    return baseline && baseline.count >= MIN_SAMPLES && baseline.mean != null;
  }).length;
  return total ? available / total : 0;
}

function computeAnomaly(latest, baselines) {
  if (!latest) {
    return { score: null, contributors: [], confidence: 0 };
  }
  const contributors = [];
  let scoreSum = 0;
  let weightSum = 0;
  METRIC_KEYS.forEach((key) => {
    const value = toNumber(latest.metrics?.[key]);
    const baseline = baselines[key];
    if (value == null || !baseline || baseline.mean == null || !baseline.std) return;
    const z = Math.abs((value - baseline.mean) / (baseline.std || 1));
    const contrib = clamp(z / 4, 0, 1);
    if (contrib > 0) {
      contributors.push({
        metric: key,
        value,
        zScore: z,
        reason: `${key} deviated by ${z.toFixed(2)} std dev.`
      });
    }
    scoreSum += contrib;
    weightSum += 1;
  });
  contributors.sort((a, b) => b.zScore - a.zScore);
  return {
    score: weightSum ? clamp(scoreSum / weightSum, 0, 1) : null,
    contributors: contributors.slice(0, 4)
  };
}

function computeRisk(samples, baselines) {
  const lastSamples = samples.slice(-MIN_SAMPLES);
  const result = {
    cooling: null,
    charging: null,
    fuel: null
  };
  const toRisk = (value) => Math.round(clamp(value, 0, 1) * 100);
  const computeMetricTrend = (metric) => {
    const values = lastSamples.map((s) => toNumber(s.metrics?.[metric])).filter((v) => v != null);
    if (values.length < MIN_SAMPLES) return null;
    const baseline = baselines[metric];
    if (!baseline || baseline.mean == null) return null;
    const slope = computeSlope(values);
    const drift = baseline.mean ? Math.abs(values[values.length - 1] - baseline.mean) / Math.max(Math.abs(baseline.mean), 1) : 0;
    return { slope, drift, current: values[values.length - 1], baselineMean: baseline.mean };
  };
  const cooling = computeMetricTrend("coolantTemp");
  if (cooling) {
    const risk = clamp((cooling.drift * 1.2) + (cooling.slope * 0.15), 0, 1);
    result.cooling = {
      risk7: toRisk(risk * 0.6),
      risk14: toRisk(risk * 0.8),
      risk30: toRisk(risk),
      reason: "Coolant temperature trend vs baseline."
    };
  }
  const charging = computeMetricTrend("batteryVoltage");
  if (charging) {
    const drop = charging.baselineMean ? Math.max(0, (charging.baselineMean - charging.current) / charging.baselineMean) : 0;
    const risk = clamp(drop * 1.4 + Math.abs(charging.slope) * 0.1, 0, 1);
    result.charging = {
      risk7: toRisk(risk * 0.6),
      risk14: toRisk(risk * 0.8),
      risk30: toRisk(risk),
      reason: "Voltage sag/instability detected."
    };
  }
  const fuelRate = computeMetricTrend("fuelRate");
  if (fuelRate) {
    const risk = clamp((fuelRate.drift * 1.2) + (fuelRate.slope * 0.12), 0, 1);
    result.fuel = {
      risk7: toRisk(risk * 0.6),
      risk14: toRisk(risk * 0.8),
      risk30: toRisk(risk),
      reason: "Fuel rate variance against baseline."
    };
  }
  return result;
}

function confidenceFrom(samplesCount, coverage) {
  const countScore = clamp(samplesCount / MIN_SAMPLES, 0, 1);
  return clamp((countScore * 0.7) + (coverage * 0.3), 0, 1);
}

function buildTelemetrySample(normalized, extra = {}) {
  const engine = normalized.engine || {};
  const vehicle = normalized.vehicle || {};
  const electrical = normalized.electrical || {};
  return {
    id: makeId("TS"),
    orgId: normalized.orgId || null,
    vehicleId: normalized.vehicleId || null,
    driverId: extra.driverId || null,
    ts: normalized.timestamp || new Date().toISOString(),
    odometer: vehicle.odometerKm ?? null,
    engineHours: vehicle.engineHours ?? null,
    metrics: {
      rpm: engine.rpm ?? null,
      vehicleSpeed: vehicle.speedKph ?? null,
      coolantTemp: engine.coolantTempC ?? null,
      oilTemp: engine.oilTempC ?? null,
      batteryVoltage: electrical.batteryVoltageV ?? null,
      engineLoad: engine.engineLoadPct ?? null,
      engineTorque: engine.torquePct ?? null,
      fuelRate: engine.fuelRateLph ?? null,
      intakeAirTemp: engine.intakeAirTempC ?? null,
      maf: engine.mafGramsPerSec ?? null,
      throttlePos: engine.throttlePosPct ?? null,
      intakeManifoldPressure: engine.mapKpa ?? engine.boostKpa ?? null,
      dpfSootLoad: engine.dpfSootLoadPct ?? null,
      ambientTemp: engine.ambientTempC ?? null,
      fuelLevel: vehicle.fuelLevelPct ?? null
    },
    raw: Object.assign({}, extra.rawPids || {}, extra.derivedMetrics || {})
  };
}

function appendTelemetrySample(data, sample, retentionLimit = 50000) {
  data.telemetrySamples = Array.isArray(data.telemetrySamples) ? data.telemetrySamples : [];
  data.telemetrySamples.push(sample);
  if (data.telemetrySamples.length > retentionLimit) {
    data.telemetrySamples = data.telemetrySamples.slice(-retentionLimit);
  }
}

function getSamplesForVehicle(data, vehicleId) {
  return (data.telemetrySamples || []).filter((s) => s.vehicleId === vehicleId);
}

function getLatestSample(samples) {
  if (!samples.length) return null;
  return samples.reduce((latest, s) => (new Date(s.ts) > new Date(latest.ts) ? s : latest), samples[0]);
}

function computeRouteSignature(samples) {
  const geo = samples
    .map((s) => ({
      ts: s.ts,
      lat: toNumber(s.raw?.lat ?? s.raw?.latitude ?? s.raw?.gpsLat),
      lon: toNumber(s.raw?.lon ?? s.raw?.longitude ?? s.raw?.gpsLon)
    }))
    .filter((g) => g.lat != null && g.lon != null);
  if (geo.length < 2) return null;
  geo.sort((a, b) => new Date(a.ts) - new Date(b.ts));
  const start = geo[0];
  const end = geo[geo.length - 1];
  const round = (value) => Math.round(value * 10) / 10;
  return `${round(start.lat)},${round(start.lon)}->${round(end.lat)},${round(end.lon)}`;
}

function computeModelState(data, vehicleId) {
  const samples = getSamplesForVehicle(data, vehicleId).sort((a, b) => new Date(a.ts) - new Date(b.ts));
  const sampleCount = samples.length;
  const latest = getLatestSample(samples);
  const baselines = computeBaselines(samples);
  const coverage = computeCoverage(baselines);
  if (sampleCount < MIN_SAMPLES || coverage === 0) {
    return {
      vehicleId,
      orgId: latest?.orgId || null,
      sampleCount,
      coverage,
      insufficientHistory: true,
      updatedAt: new Date().toISOString(),
      routeSignature: computeRouteSignature(samples)
    };
  }
  const anomaly = computeAnomaly(latest, baselines);
  const risk = computeRisk(samples, baselines);
  const confidence = confidenceFrom(sampleCount, coverage);
  return {
    vehicleId,
    orgId: latest?.orgId || null,
    sampleCount,
    coverage,
    insufficientHistory: false,
    anomalyScore: anomaly.score,
    topContributors: anomaly.contributors,
    confidence,
    risk,
    updatedAt: new Date().toISOString(),
    routeSignature: computeRouteSignature(samples)
  };
}

function upsertModelState(data, state) {
  data.modelState = Array.isArray(data.modelState) ? data.modelState : [];
  data.modelState = data.modelState.filter((m) => m.vehicleId !== state.vehicleId);
  data.modelState.push(state);
}

function generateMaintenanceLabels(payload) {
  const text = [
    payload.title,
    payload.item,
    payload.notes,
    payload.parts,
    ...(payload.partsUsed || [])
  ].filter(Boolean).join(" ").toLowerCase();
  const labels = new Set();
  const add = (label) => labels.add(label);
  if (payload.category) add(String(payload.category).toLowerCase());
  const keywordMap = [
    ["alternator", "alternator_replaced"],
    ["radiator", "radiator_repaired"],
    ["water pump", "water_pump_replaced"],
    ["fuel pump", "fuel_pump_replaced"],
    ["injector", "injector_service"],
    ["dpf", "dpf_service"],
    ["regen", "regen_service"],
    ["turbo", "turbo_service"],
    ["maf", "maf_service"],
    ["egr", "egr_service"],
    ["battery", "battery_replaced"],
    ["thermostat", "thermostat_replaced"],
    ["brake", "brake_service"],
    ["tire", "tire_service"],
    ["oil", "oil_service"],
    ["coolant", "cooling_service"]
  ];
  keywordMap.forEach(([keyword, label]) => {
    if (text.includes(keyword)) add(label);
  });
  return Array.from(labels);
}

function markPreEventWindow(data, vehicleId, labels, occurredAt, windowDays = 30) {
  if (!labels || !labels.length || !occurredAt) return;
  const end = new Date(occurredAt).toISOString();
  const start = new Date(new Date(occurredAt).getTime() - windowDays * 86400000).toISOString();
  data.modelState = Array.isArray(data.modelState) ? data.modelState : [];
  let state = data.modelState.find((m) => m.vehicleId === vehicleId);
  if (!state) {
    state = { vehicleId, labelWindows: [] };
    data.modelState.push(state);
  }
  state.labelWindows = Array.isArray(state.labelWindows) ? state.labelWindows : [];
  labels.forEach((label) => {
    state.labelWindows.push({ label, startAt: start, endAt: end, createdAt: new Date().toISOString() });
  });
}

function detectFuelEventsFromSamples(data, vehicleId) {
  const samples = getSamplesForVehicle(data, vehicleId);
  if (samples.length < 2) return;
  const sorted = samples.slice(-200).sort((a, b) => new Date(a.ts) - new Date(b.ts));
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    const prevFuel = toNumber(prev.metrics?.fuelLevel);
    const currFuel = toNumber(curr.metrics?.fuelLevel);
    if (prevFuel == null || currFuel == null) continue;
    const delta = currFuel - prevFuel;
    if (delta < 4) continue;
    const rpm = toNumber(curr.metrics?.rpm) || 0;
    const speed = toNumber(curr.metrics?.vehicleSpeed) || 0;
    const stationary = rpm <= 100 && speed <= 1;
    if (!stationary) continue;
    const now = new Date(curr.ts).getTime();
    const recent = (data.fuelEvents || []).find((evt) => {
      const endTs = evt.tsEnd || evt.endTs;
      if (!endTs) return false;
      return Math.abs(new Date(endTs).getTime() - now) < 30 * 60000;
    });
    if (recent) continue;
    data.fuelEvents = Array.isArray(data.fuelEvents) ? data.fuelEvents : [];
    data.fuelEvents.unshift({
      id: makeId("FUEL"),
      orgId: curr.orgId || null,
      vehicleId,
      tsStart: prev.ts,
      tsEnd: curr.ts,
      startTs: prev.ts,
      endTs: curr.ts,
      detectedBy: "AUTO",
      fuelLevelBefore: prevFuel,
      fuelLevelAfter: currFuel,
      gallonsEstimated: null,
      location: null,
      confidence: delta >= 8 ? 0.8 : 0.6,
      note: "Detected fuel increase while stationary."
    });
    break;
  }
}

function generateAlertsFromState(state) {
  if (!state || state.insufficientHistory) return [];
  const alerts = [];
  const confidence = state.confidence || 0;
  const pushAlert = (type, severity, explanation, checks) => {
    alerts.push({
      id: makeId("ALERT"),
      orgId: state.orgId || null,
      vehicleId: state.vehicleId,
      type,
      severity,
      createdAt: new Date().toISOString(),
      explanation,
      recommendedChecks: checks
    });
  };
  if (state.anomalyScore != null && state.anomalyScore >= 0.7 && confidence >= 0.5) {
    const severity = state.anomalyScore >= 0.85 ? "critical" : "warning";
    pushAlert("GENERAL", severity, "Anomaly score exceeded threshold with sufficient confidence.", [
      "Review recent telemetry history.",
      "Inspect top contributing subsystems.",
      "Confirm last maintenance log."
    ]);
  }
  const coolingRisk = state.risk?.cooling?.risk14;
  if (coolingRisk != null && coolingRisk >= 70) {
    pushAlert("COOLING", coolingRisk >= 85 ? "critical" : "warning", "Cooling system risk elevated over 14 days.", [
      "Inspect coolant levels and hoses.",
      "Review recent temperature spikes.",
      "Schedule cooling system inspection."
    ]);
  }
  const chargingRisk = state.risk?.charging?.risk14;
  if (chargingRisk != null && chargingRisk >= 70) {
    pushAlert("CHARGING", chargingRisk >= 85 ? "critical" : "warning", "Charging system risk elevated over 14 days.", [
      "Inspect battery and alternator output.",
      "Check voltage stability at idle.",
      "Confirm recent electrical service."
    ]);
  }
  const fuelRisk = state.risk?.fuel?.risk14;
  if (fuelRisk != null && fuelRisk >= 70) {
    pushAlert("FUEL_SYSTEM", fuelRisk >= 85 ? "critical" : "warning", "Fuel system risk elevated over 14 days.", [
      "Check fuel filters and lines.",
      "Review fuel rate anomalies.",
      "Verify injector health."
    ]);
  }
  return alerts;
}

module.exports = {
  MIN_SAMPLES,
  METRIC_KEYS,
  buildTelemetrySample,
  appendTelemetrySample,
  computeModelState,
  upsertModelState,
  generateMaintenanceLabels,
  markPreEventWindow,
  detectFuelEventsFromSamples,
  generateAlertsFromState
};
