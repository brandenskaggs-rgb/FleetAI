const crypto = require("crypto");
const { resolveChargingProfile } = require("./ml/chargingProfiles");

const MIN_SAMPLES = 200;
const EWMA_ALPHA = 0.18;
const SEASONAL_MIN_SAMPLES = 40;
const CLIMATE_WINDOW_DAYS = 30;
const EWMA_TAU_HOURS = 2.0; // time constant for time-weighted EWMA

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

// Optional standardized signals improve evidence when an ECU advertises them,
// but they do not reduce coverage for vehicles that do not implement them.
const OPTIONAL_METRIC_KEYS = [
  "mapKpa",
  "absoluteLoad",
  "ignitionTiming",
  "fuelPressure",
  "fuelRailPressureRelative",
  "fuelRailPressureGauge",
  "fuelRailPressureAbsolute",
  "equivalenceRatio",
  "fuelInjectionTiming",
  "stft1",
  "ltft1",
  "stft2",
  "ltft2",
  "o2B1S1Voltage",
  "o2B1S2Voltage",
  "o2B2S1Voltage",
  "o2B2S2Voltage",
  "catalystTempB1S1",
  "catalystTempB2S1",
  "catalystTempB1S2",
  "catalystTempB2S2",
  "commandedEgr",
  "egrError",
  "acceleratorPedal",
  "brakePedalPosition"
];

const ANALYSIS_METRIC_KEYS = [...METRIC_KEYS, ...OPTIONAL_METRIC_KEYS];
const HEALTH_METRIC_KEYS = METRIC_KEYS.filter(
  (key) => key !== "vehicleSpeed" && key !== "fuelLevel"
);

const RISK_METRICS = {
  cooling: ["coolantTemp"],
  charging: ["batteryVoltage"],
  fuel: ["fuelRate", "maf", "throttlePos"]
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

function metricNumber(metricKey, value) {
  const number = toNumber(value);
  if (number == null) return null;
  if (metricKey === "batteryVoltage" && (number < 5 || number > 40)) return null;
  if (metricKey === "rpm" && (number < 0 || number > 10_000)) return null;
  if (metricKey === "vehicleSpeed" && (number < 0 || number > 300)) return null;
  return number;
}

function median(values) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
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

/**
 * Time-weighted EWMA baseline. Accepts [{ts, value}] sorted oldest-first.
 * α = 1 - exp(-Δt / τ) so burst sampling doesn't inflate the model.
 */
function computeTimeWeightedBaseline(timestampedValues) {
  const valid = timestampedValues
    .map((item) => ({ ts: new Date(item.ts).getTime(), v: toNumber(item.value) }))
    .filter((item) => !Number.isNaN(item.ts) && item.v !== null);

  if (!valid.length) {
    return { count: 0, mean: null, std: null, min: null, max: null, slope: 0 };
  }

  let mean = null;
  let variance = null;
  let min = valid[0].v;
  let max = valid[0].v;
  const plainValues = [];

  for (let i = 0; i < valid.length; i += 1) {
    const { ts, v } = valid[i];
    min = Math.min(min, v);
    max = Math.max(max, v);
    plainValues.push(v);

    if (mean === null) {
      mean = v;
      variance = 0;
      continue;
    }
    const prevTs = valid[i - 1].ts;
    const dtHours = Math.max(0, (ts - prevTs) / 3_600_000);
    const alpha = 1 - Math.exp(-dtHours / EWMA_TAU_HOURS);
    const a = Math.max(0.01, Math.min(0.99, alpha)); // clamp so cold start is safe
    mean = a * v + (1 - a) * mean;
    const diff = v - mean;
    variance = a * diff * diff + (1 - a) * variance;
  }

  const std = variance != null ? Math.sqrt(variance) : null;
  return {
    count: valid.length,
    mean,
    std,
    min,
    max,
    slope: computeSlope(plainValues)
  };
}

function computeBaselines(samples) {
  const baselines = {};
  ANALYSIS_METRIC_KEYS.forEach((key) => {
    const timestampedValues = samples
      .map((s) => ({ ts: s.ts, value: metricNumber(key, s.metrics?.[key]) }))
      .filter((item) => item.ts && item.value !== null);
    baselines[key] = timestampedValues.length >= 2
      ? computeTimeWeightedBaseline(timestampedValues)
      : computeBaseline(samples.map((s) => metricNumber(key, s.metrics?.[key])).filter((v) => v != null));
  });
  return baselines;
}

function getSeasonFromMonth(monthIndex) {
  if (monthIndex === 11 || monthIndex <= 1) return "winter";
  if (monthIndex >= 2 && monthIndex <= 4) return "spring";
  if (monthIndex >= 5 && monthIndex <= 7) return "summer";
  return "fall";
}

function getSeasonFromTimestamp(timestamp) {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return "unknown";
  return getSeasonFromMonth(parsed.getUTCMonth());
}

function computeSeasonalBaselines(samples) {
  const seasonalValues = {};
  const seasons = ["winter", "spring", "summer", "fall"];
  seasons.forEach((season) => {
    seasonalValues[season] = {};
    ANALYSIS_METRIC_KEYS.forEach((key) => {
      seasonalValues[season][key] = [];
    });
  });

  samples.forEach((sample) => {
    const season = getSeasonFromTimestamp(sample.ts);
    if (!seasonalValues[season]) return;
    ANALYSIS_METRIC_KEYS.forEach((key) => {
      const value = metricNumber(key, sample.metrics?.[key]);
      if (value != null) seasonalValues[season][key].push(value);
    });
  });

  const seasonalBaselines = {};
  Object.entries(seasonalValues).forEach(([season, byMetric]) => {
    seasonalBaselines[season] = {};
    ANALYSIS_METRIC_KEYS.forEach((key) => {
      seasonalBaselines[season][key] = computeBaseline(byMetric[key]);
    });
  });
  return seasonalBaselines;
}

function resolveBaseline(metricKey, baselines, seasonalBaselines, seasonKey) {
  const globalBaseline = baselines[metricKey];
  if (!seasonalBaselines || !seasonKey) return globalBaseline;
  const seasonalBaseline = seasonalBaselines[seasonKey]?.[metricKey];
  if (!seasonalBaseline) return globalBaseline;
  if (seasonalBaseline.count >= SEASONAL_MIN_SAMPLES && seasonalBaseline.mean != null) {
    return seasonalBaseline;
  }
  return globalBaseline;
}

function computeCoverage(baselines) {
  const total = METRIC_KEYS.length;
  const available = METRIC_KEYS.filter((key) => {
    const baseline = baselines[key];
    return baseline && baseline.count >= MIN_SAMPLES && baseline.mean != null;
  }).length;
  return total ? available / total : 0;
}

function computeAnomaly(latest, baselines, seasonalBaselines = null, seasonKey = null) {
  if (!latest) {
    return { score: null, contributors: [], confidence: 0 };
  }
  const contributors = [];
  let scoreSum = 0;
  let weightSum = 0;
  ANALYSIS_METRIC_KEYS.forEach((key) => {
    const value = metricNumber(key, latest.metrics?.[key]);
    const baseline = resolveBaseline(key, baselines, seasonalBaselines, seasonKey);
    if (value == null || !baseline || baseline.mean == null || !baseline.std) return;
    const z = Math.abs((value - baseline.mean) / (baseline.std || 1));
    const contrib = clamp(z / 4, 0, 1);
    if (contrib > 0) {
      contributors.push({
        metric: key,
        value,
        zScore: z,
        reason: `${key} deviated by ${z.toFixed(2)} std dev.`,
        baseline: baseline.count >= SEASONAL_MIN_SAMPLES ? "seasonal_or_global" : "global"
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

function computeClimateContext(samples, baselines, seasonalBaselines, seasonKey) {
  if (!samples.length) return null;
  const latest = getLatestSample(samples);
  if (!latest) return null;

  const latestAmbient = toNumber(latest.metrics?.ambientTemp);
  const ambientGlobal = baselines.ambientTemp || null;
  const ambientSeasonal = resolveBaseline("ambientTemp", baselines, seasonalBaselines, seasonKey);

  const latestTs = new Date(latest.ts);
  if (Number.isNaN(latestTs.getTime())) return null;
  const windowStartTs = new Date(latestTs.getTime() - CLIMATE_WINDOW_DAYS * 86400000);
  const recentAmbient = samples
    .filter((s) => {
      const ts = new Date(s.ts);
      return !Number.isNaN(ts.getTime()) && ts >= windowStartTs;
    })
    .map((s) => toNumber(s.metrics?.ambientTemp))
    .filter((v) => v != null);

  const recentMean = recentAmbient.length
    ? recentAmbient.reduce((sum, v) => sum + v, 0) / recentAmbient.length
    : null;
  const seasonalMean = ambientSeasonal?.mean ?? null;
  const seasonalStd = ambientSeasonal?.std ?? null;
  const overallMean = ambientGlobal?.mean ?? null;

  const ambientAnomalyZ =
    latestAmbient != null && seasonalMean != null && seasonalStd
      ? (latestAmbient - seasonalMean) / seasonalStd
      : null;
  const climateShiftC =
    recentMean != null && overallMean != null ? recentMean - overallMean : null;
  const extremeWeatherStress = Boolean(
    (ambientAnomalyZ != null && Math.abs(ambientAnomalyZ) >= 2.0) ||
      (climateShiftC != null && Math.abs(climateShiftC) >= 8.0)
  );

  return {
    season: seasonKey || "unknown",
    latestAmbientC: latestAmbient,
    ambientAnomalyZ,
    recent30dAmbientMeanC: recentMean,
    climateShift30dC: climateShiftC,
    extremeWeatherStress
  };
}

function sustainedLowWindow(points, threshold) {
  let current = null;
  let longest = null;
  for (const point of points) {
    const timestampMs = new Date(point.ts).getTime();
    if (!Number.isFinite(timestampMs) || point.voltage > threshold) {
      current = null;
      continue;
    }
    const gapMs = current ? timestampMs - current.endMs : 0;
    if (!current || gapMs < 0 || gapMs > 45_000) {
      current = {
        startMs: timestampMs,
        endMs: timestampMs,
        count: 1,
        minVoltage: point.voltage
      };
    } else {
      current.endMs = timestampMs;
      current.count += 1;
      current.minVoltage = Math.min(current.minVoltage, point.voltage);
    }
    const durationMs = current.endMs - current.startMs;
    if (!longest || durationMs > longest.durationMs || (durationMs === longest.durationMs && current.count > longest.count)) {
      longest = Object.assign({}, current, { durationMs });
    }
  }
  return longest;
}

function computeChargingEvidence(samples, vehicleMeta = {}) {
  const sorted = (Array.isArray(samples) ? samples : [])
    .slice()
    .sort((a, b) => new Date(a.ts) - new Date(b.ts));
  const latestSampleMs = sorted.length ? new Date(sorted[sorted.length - 1].ts).getTime() : NaN;
  const points = sorted.map((sample) => ({
    ts: sample.ts,
    voltage: metricNumber("batteryVoltage", sample.metrics?.batteryVoltage),
    rpm: metricNumber("rpm", sample.metrics?.rpm)
  })).filter((point) => point.voltage != null && point.rpm != null && point.rpm >= 400);

  if (points.length < 6) {
    return { available: false, status: "insufficient_data", engineRunningSampleCount: points.length };
  }

  const typicalVoltage = median(points.map((point) => point.voltage));
  const inferredSystemVoltage = typicalVoltage != null && typicalVoltage >= 18 ? 24 : 12;
  const profile = resolveChargingProfile(vehicleMeta, inferredSystemVoltage);
  const { systemVoltage, monitorThreshold, warningThreshold, criticalThreshold } = profile;
  const monitorWindow = sustainedLowWindow(points, monitorThreshold);
  const warningWindow = sustainedLowWindow(points, warningThreshold);
  const criticalWindow = sustainedLowWindow(points, criticalThreshold);
  const qualifies = (window, minimumDurationMs, minimumSamples) => Boolean(
    window
      && window.durationMs >= minimumDurationMs
      && window.count >= minimumSamples
      && Number.isFinite(latestSampleMs)
      && latestSampleMs - window.endMs <= 10 * 60_000
  );
  const critical = qualifies(criticalWindow, 60_000, 4);
  const warning = !critical && qualifies(warningWindow, 3 * 60_000, 8);
  const monitor = !critical && !warning && qualifies(monitorWindow, 3 * 60_000, 8);
  const activeWindow = critical ? criticalWindow : warning ? warningWindow : monitor ? monitorWindow : null;
  const recentValues = points.slice(-20).map((point) => point.voltage);
  const status = critical ? "critical" : warning ? "warning" : monitor ? "monitor" : "normal";
  const durationMinutes = activeWindow ? activeWindow.durationMs / 60_000 : 0;
  const explanation = critical || warning
    ? `Charging voltage stayed at or below ${(critical ? criticalThreshold : warningThreshold).toFixed(1)} V for ${durationMinutes.toFixed(1)} minutes while the engine was running; minimum observed voltage was ${activeWindow.minVoltage.toFixed(2)} V.`
    : monitor
      ? `Engine-running voltage stayed below the ${monitorThreshold.toFixed(1)} V monitor threshold for ${durationMinutes.toFixed(1)} minutes. The nominal target for this ${profile.label.toLowerCase()} profile is ${profile.nominalTarget.toFixed(1)} V, but commanded voltage, battery state, and electrical load must be considered before declaring a fault.`
      : `No sustained below-target charging voltage was present in the recent engine-running data. The ${profile.label.toLowerCase()} profile targets about ${profile.nominalTarget.toFixed(1)} V; typical voltage across the available history was ${typicalVoltage.toFixed(2)} V.`;

  return {
    available: true,
    status,
    systemVoltage,
    profileKey: profile.profileKey,
    profileLabel: profile.label,
    profileBasis: profile.basis,
    make: profile.make,
    model: profile.model,
    modelYear: profile.year,
    nominalTarget: profile.nominalTarget,
    expectedOperatingRange: [profile.expectedMin, profile.expectedMax],
    engineRunningSampleCount: points.length,
    typicalVoltage: Math.round(typicalVoltage * 1000) / 1000,
    recentMedianVoltage: Math.round(median(recentValues) * 1000) / 1000,
    minimumVoltage: Math.round(Math.min(...points.map((point) => point.voltage)) * 1000) / 1000,
    monitorThreshold,
    warningThreshold,
    criticalThreshold,
    sustainedLowMinutes: Math.round(durationMinutes * 10) / 10,
    explanation
  };
}

function computeRisk(samples, baselines, climateContext = null, chargingEvidence = null) {
  const lastSamples = samples.slice(-MIN_SAMPLES);
  const result = {
    cooling: null,
    charging: null,
    fuel: null
  };
  const toRisk = (value) => Math.round(clamp(value, 0, 1) * 100);
  const computeMetricTrend = (metric, predicate = () => true) => {
    const values = lastSamples
      .filter(predicate)
      .map((s) => metricNumber(metric, s.metrics?.[metric]))
      .filter((v) => v != null);
    if (values.length < MIN_SAMPLES) return null;
    const baseline = baselines[metric];
    if (!baseline || baseline.mean == null) return null;
    const slope = computeSlope(values);
    const drift = baseline.mean ? Math.abs(values[values.length - 1] - baseline.mean) / Math.max(Math.abs(baseline.mean), 1) : 0;
    return { slope, drift, current: values[values.length - 1], baselineMean: baseline.mean };
  };
  const cooling = computeMetricTrend("coolantTemp");
  if (cooling) {
    const heatStress = clamp((((climateContext?.ambientAnomalyZ ?? 0) - 1) / 2), 0, 1);
    const climateShift = clamp(Math.abs(climateContext?.climateShift30dC ?? 0) / 12, 0, 1);
    const risk = clamp((cooling.drift * 1.2) + (cooling.slope * 0.15) + (heatStress * 0.2) + (climateShift * 0.1), 0, 1);
    result.cooling = {
      risk7: toRisk(risk * 0.6),
      risk14: toRisk(risk * 0.8),
      risk30: toRisk(risk),
      reason: "Coolant temperature trend vs baseline with seasonal climate weighting."
    };
  }
  const charging = computeMetricTrend(
    "batteryVoltage",
    (sample) => (metricNumber("rpm", sample.metrics?.rpm) ?? 0) >= 400
  );
  if (charging) {
    const drop = charging.baselineMean ? Math.max(0, (charging.baselineMean - charging.current) / charging.baselineMean) : 0;
    const coldStress = clamp((((-(climateContext?.ambientAnomalyZ ?? 0)) - 1) / 2), 0, 1);
    const climateShift = clamp(Math.abs(climateContext?.climateShift30dC ?? 0) / 12, 0, 1);
    const evidenceFloor = chargingEvidence?.status === "critical"
      ? 0.9
      : chargingEvidence?.status === "warning" ? 0.72 : 0;
    const risk = Math.max(
      evidenceFloor,
      clamp(drop * 1.4 + Math.abs(charging.slope) * 0.1 + (coldStress * 0.22) + (climateShift * 0.06), 0, 0.69)
    );
    result.charging = {
      risk7: toRisk(risk * 0.6),
      risk14: toRisk(risk * 0.8),
      risk30: toRisk(risk),
      reason: chargingEvidence?.explanation || "Engine-running voltage trend compared with the learned baseline."
    };
  }
  const fuelRate = computeMetricTrend("fuelRate");
  if (fuelRate) {
    const ambientStress = clamp(Math.abs(climateContext?.ambientAnomalyZ ?? 0) / 3, 0, 1);
    const climateShift = clamp(Math.abs(climateContext?.climateShift30dC ?? 0) / 12, 0, 1);
    const risk = clamp((fuelRate.drift * 1.2) + (fuelRate.slope * 0.12) + (ambientStress * 0.12) + (climateShift * 0.08), 0, 1);
    result.fuel = {
      risk7: toRisk(risk * 0.6),
      risk14: toRisk(risk * 0.8),
      risk30: toRisk(risk),
      reason: "Fuel rate variance against baseline with weather-normalized adjustments."
    };
  }
  return result;
}

function confidenceFrom(samplesCount, coverage, observation = {}) {
  const countScore = clamp(samplesCount / 1000, 0, 1);
  const operatingMinutesScore = clamp((observation.operatingMinutes || 0) / 360, 0, 1);
  const sessionScore = clamp((observation.operatingSessionCount || 0) / 10, 0, 1);
  return clamp(
    (countScore * 0.25)
      + (operatingMinutesScore * 0.35)
      + (sessionScore * 0.20)
      + (coverage * 0.20),
    0,
    1
  );
}

const METRIC_SOURCE_KEYS = {
  rpm: ["rpm"],
  vehicleSpeed: ["speedKph", "speedMph"],
  coolantTemp: ["coolantTempC", "coolantTempF"],
  oilTemp: ["oilTempC", "oilTempF"],
  batteryVoltage: ["batteryVoltageV", "batteryVoltage"],
  engineLoad: ["engineLoadPct", "engine_load"],
  engineTorque: ["torquePct", "actualTorquePct"],
  fuelRate: ["fuelRateLph", "fuelRateGph"],
  intakeAirTemp: ["intakeAirTempC", "intakeAirTempF"],
  maf: ["mafGramsPerSec", "maf"],
  throttlePos: ["throttlePosPct"],
  intakeManifoldPressure: ["mapKpa", "boostKpa"],
  dpfSootLoad: ["dpfSootLoadPct"],
  ambientTemp: ["ambientTempC"],
  fuelLevel: ["fuelLevelPct"],
  absoluteLoad: ["absoluteLoadPct"],
  ignitionTiming: ["ignitionTimingAdvanceDeg"],
  fuelPressure: ["fuelPressureKpa"],
  fuelRailPressureRelative: ["fuelRailPressureRelativeKpa"],
  fuelRailPressureGauge: ["fuelRailGaugePressureKpa"],
  fuelRailPressureAbsolute: ["fuelRailAbsolutePressureKpa"],
  equivalenceRatio: ["commandedEquivalenceRatio"],
  fuelInjectionTiming: ["fuelInjectionTimingDeg"],
  stft1: ["shortTermFuelTrimBank1Pct", "stft1", "shortTermFuelTrim"],
  ltft1: ["longTermFuelTrimBank1Pct", "ltft1", "longTermFuelTrim"],
  stft2: ["shortTermFuelTrimBank2Pct"],
  ltft2: ["longTermFuelTrimBank2Pct"],
  o2B1S1Voltage: ["o2B1S1VoltageV"],
  o2B1S2Voltage: ["o2B1S2VoltageV"],
  o2B2S1Voltage: ["o2B2S1VoltageV"],
  o2B2S2Voltage: ["o2B2S2VoltageV"],
  catalystTempB1S1: ["catalystTempB1S1C"],
  catalystTempB2S1: ["catalystTempB2S1C"],
  catalystTempB1S2: ["catalystTempB1S2C"],
  catalystTempB2S2: ["catalystTempB2S2C"],
  commandedEgr: ["commandedEgrPct"],
  egrError: ["egrErrorPct"],
  acceleratorPedal: ["acceleratorPedalDPosPct", "acceleratorPedalEPosPct", "relativeAcceleratorPedalPct"],
  brakePedalPosition: ["brakePedalPositionPct"]
};

function removeStaleMetrics(metrics, metricAgesMs, maximumAgeMs = 30_000) {
  if (!metricAgesMs || typeof metricAgesMs !== "object" || Array.isArray(metricAgesMs)) return metrics;
  const filtered = Object.assign({}, metrics);
  Object.entries(METRIC_SOURCE_KEYS).forEach(([metricKey, sourceKeys]) => {
    const reportedAges = sourceKeys
      .map((key) => toNumber(metricAgesMs[key]))
      .filter((age) => age != null && age >= 0);
    if (reportedAges.length && Math.min(...reportedAges) > maximumAgeMs) filtered[metricKey] = null;
  });
  return filtered;
}

function buildTelemetrySample(normalized, extra = {}) {
  const engine = normalized.engine || {};
  const vehicle = normalized.vehicle || {};
  const electrical = normalized.electrical || {};
  const emissions = normalized.emissions || {};
  const controls = normalized.controls || {};
  const brakes = normalized.brakes || {};
  const metrics = removeStaleMetrics({
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
    fuelLevel: vehicle.fuelLevelPct ?? null,
    mapKpa: engine.mapKpa ?? null,
    absoluteLoad: engine.absoluteLoadPct ?? null,
    ignitionTiming: engine.ignitionTimingAdvanceDeg ?? null,
    fuelPressure: engine.fuelPressureKpa ?? null,
    fuelRailPressureRelative: engine.fuelRailPressureRelativeKpa ?? null,
    fuelRailPressureGauge: engine.fuelRailGaugePressureKpa ?? null,
    fuelRailPressureAbsolute: engine.fuelRailAbsolutePressureKpa ?? null,
    equivalenceRatio: engine.commandedEquivalenceRatio ?? null,
    fuelInjectionTiming: engine.fuelInjectionTimingDeg ?? null,
    stft1: engine.shortTermFuelTrimBank1Pct ?? engine.stft1 ?? null,
    ltft1: engine.longTermFuelTrimBank1Pct ?? engine.ltft1 ?? null,
    stft2: engine.shortTermFuelTrimBank2Pct ?? null,
    ltft2: engine.longTermFuelTrimBank2Pct ?? null,
    o2B1S1Voltage: emissions.o2B1S1VoltageV ?? null,
    o2B1S2Voltage: emissions.o2B1S2VoltageV ?? null,
    o2B2S1Voltage: emissions.o2B2S1VoltageV ?? null,
    o2B2S2Voltage: emissions.o2B2S2VoltageV ?? null,
    catalystTempB1S1: emissions.catalystTempB1S1C ?? null,
    catalystTempB2S1: emissions.catalystTempB2S1C ?? null,
    catalystTempB1S2: emissions.catalystTempB1S2C ?? null,
    catalystTempB2S2: emissions.catalystTempB2S2C ?? null,
    commandedEgr: emissions.commandedEgrPct ?? null,
    egrError: emissions.egrErrorPct ?? null,
    acceleratorPedal: controls.acceleratorPedalDPosPct
      ?? controls.acceleratorPedalEPosPct
      ?? controls.relativeAcceleratorPedalPct
      ?? null,
    brakePedalPosition: brakes.brakePedalPositionPct ?? null
  }, extra.meta?.metricAgesMs);
  const raw = Object.assign({}, extra.rawPids || {}, extra.derivedMetrics || {});
  delete raw.heartbeatMs;
  delete raw.vin;
  delete raw.VIN;
  const timestamp = normalized.timestamp || new Date().toISOString();
  const fingerprint = crypto
    .createHash("sha256")
    .update(JSON.stringify([normalized.vehicleId || null, timestamp, metrics, raw]))
    .digest("hex")
    .slice(0, 24);
  return {
    id: `TS_${fingerprint}`,
    orgId: normalized.orgId || null,
    vehicleId: normalized.vehicleId || null,
    driverId: extra.driverId || null,
    ts: timestamp,
    odometer: vehicle.odometerKm ?? null,
    engineHours: vehicle.engineHours ?? null,
    metrics,
    raw
  };
}

function appendTelemetrySample(data, sample, retentionLimit = 50000) {
  data.telemetrySamples = Array.isArray(data.telemetrySamples) ? data.telemetrySamples : [];
  if (sample?.id && data.telemetrySamples.some((existing) => existing?.id === sample.id)) return false;
  data.telemetrySamples.push(sample);
  if (data.telemetrySamples.length > retentionLimit) {
    data.telemetrySamples = data.telemetrySamples.slice(-retentionLimit);
  }
  return true;
}

function getSamplesForVehicle(data, vehicleId) {
  return (data.telemetrySamples || []).filter((s) => s.vehicleId === vehicleId);
}

function getLatestSample(samples) {
  if (!samples.length) return null;
  return samples.reduce((latest, s) => (new Date(s.ts) > new Date(latest.ts) ? s : latest), samples[0]);
}

function usableTelemetrySamples(samples) {
  const usable = (Array.isArray(samples) ? samples : []).filter((sample) =>
    METRIC_KEYS.some((key) => metricNumber(key, sample?.metrics?.[key]) != null)
  );
  const buckets = new Map();
  usable
    .slice()
    .sort((a, b) => new Date(a.ts) - new Date(b.ts))
    .forEach((sample) => {
      const timestampMs = new Date(sample?.ts).getTime();
      if (!Number.isFinite(timestampMs)) return;
      const key = `${sample?.vehicleId || ""}:${Math.floor(timestampMs / 5000)}`;
      const existing = buckets.get(key);
      if (!existing) {
        buckets.set(key, Object.assign({}, sample, {
          metrics: Object.assign({}, sample.metrics || {}),
          raw: Object.assign({}, sample.raw || {})
        }));
        return;
      }
      const mergedMetrics = Object.assign({}, existing.metrics || {});
      Object.entries(sample.metrics || {}).forEach(([metricKey, value]) => {
        if (value !== null && value !== undefined && value !== "") mergedMetrics[metricKey] = value;
      });
      buckets.set(key, Object.assign({}, existing, sample, {
        ts: new Date(sample.ts) >= new Date(existing.ts) ? sample.ts : existing.ts,
        metrics: mergedMetrics,
        raw: Object.assign({}, existing.raw || {}, sample.raw || {})
      }));
    });
  return Array.from(buckets.values());
}

function computeObservationStats(samples) {
  const sorted = (Array.isArray(samples) ? samples : [])
    .slice()
    .sort((a, b) => new Date(a.ts) - new Date(b.ts));
  const operatingMinuteBuckets = new Set();
  let operatingSessionCount = 0;
  let previousRunningAt = null;
  sorted.forEach((sample) => {
    const timestampMs = new Date(sample.ts).getTime();
    const rpm = metricNumber("rpm", sample.metrics?.rpm);
    if (!Number.isFinite(timestampMs) || rpm == null || rpm < 400) return;
    operatingMinuteBuckets.add(Math.floor(timestampMs / 60_000));
    if (previousRunningAt == null || timestampMs - previousRunningAt > 60_000) operatingSessionCount += 1;
    previousRunningAt = timestampMs;
  });
  return {
    operatingMinutes: operatingMinuteBuckets.size,
    operatingSessionCount,
    wallClockSpanHours: sampleSpanHours(sorted)
  };
}

function sampleSpanHours(samples) {
  const timestamps = (Array.isArray(samples) ? samples : [])
    .map((sample) => new Date(sample.ts).getTime())
    .filter(Number.isFinite);
  if (timestamps.length < 2) return 0;
  return (Math.max(...timestamps) - Math.min(...timestamps)) / 3_600_000;
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
  const samples = usableTelemetrySamples(getSamplesForVehicle(data, vehicleId))
    .sort((a, b) => new Date(a.ts) - new Date(b.ts));
  const sampleCount = samples.length;
  const observation = computeObservationStats(samples);
  const latest = getLatestSample(samples);
  const baselines = computeBaselines(samples);
  const seasonalBaselines = computeSeasonalBaselines(samples);
  const seasonKey = latest ? getSeasonFromTimestamp(latest.ts) : "unknown";
  const coverage = computeCoverage(baselines);
  const climateContext = computeClimateContext(samples, baselines, seasonalBaselines, seasonKey);
  const historySpanHours = observation.operatingMinutes / 60;
  const vehicleMeta = (data.vehicles || []).find((vehicle) => vehicle.vehicleId === vehicleId) || {};
  const chargingEvidence = computeChargingEvidence(samples, vehicleMeta);
  if (sampleCount < MIN_SAMPLES || coverage === 0) {
    return {
      vehicleId,
      orgId: latest?.orgId || null,
      sampleCount,
      coverage,
      historySpanHours,
      wallClockSpanHours: observation.wallClockSpanHours,
      operatingMinutes: observation.operatingMinutes,
      operatingSessionCount: observation.operatingSessionCount,
      chargingEvidence,
      insufficientHistory: true,
      climateContext,
      updatedAt: new Date().toISOString(),
      routeSignature: computeRouteSignature(samples)
    };
  }
  const anomaly = computeAnomaly(latest, baselines, seasonalBaselines, seasonKey);
  const risk = computeRisk(samples, baselines, climateContext, chargingEvidence);
  const confidence = confidenceFrom(sampleCount, coverage, observation);
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
    historySpanHours,
    wallClockSpanHours: observation.wallClockSpanHours,
    operatingMinutes: observation.operatingMinutes,
    operatingSessionCount: observation.operatingSessionCount,
    chargingEvidence,
    climateContext,
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

// ── Multivariate failure signatures ──────────────────────────────────────────
// Each pattern checks co-occurring metric conditions in the latest sample.
// Returns [{id, label, severity, confidence, metrics[], description}]
const MULTIVARIATE_SIGNATURES = [
  {
    id: "cooling_cascade",
    label: "Cooling Cascade Risk",
    severity: "critical",
    check(m) {
      return (m.coolantTemp ?? 0) > 95
        && (m.engineLoad ?? 0) > 75
        && (m.rpm ?? 0) > 1800;
    },
    description: "High coolant temp combined with high engine load and RPM — potential cooling system failure cascade."
  },
  {
    id: "charging_failure",
    label: "Charging System Failure",
    severity: "critical",
    check(m) {
      return (m.batteryVoltage ?? 99) < 12.4
        && (m.rpm ?? 0) > 600;
    },
    description: "Low battery voltage at operating RPM — alternator or charging circuit likely failing."
  },
  {
    id: "dpf_critical_stack",
    label: "DPF Critical Accumulation",
    severity: "warning",
    check(m) {
      return (m.dpfSootLoad ?? 0) > 80
        && (m.fuelRate ?? 0) > 0
        && (m.engineLoad ?? 0) > 60;
    },
    description: "Near-capacity DPF with active load — regen cycle may be blocked or ineffective."
  },
  {
    id: "fuel_system_stress",
    label: "Fuel System Stress",
    severity: "warning",
    check(m) {
      return (m.fuelRate ?? 0) > 0
        && (m.maf ?? 0) > 0
        && (m.throttlePos ?? 0) > 85
        && (m.intakeManifoldPressure ?? 0) > 210;
    },
    description: "High throttle, elevated MAP, and fuel rate divergence — possible injector or turbo issue."
  },
  {
    id: "thermal_overload",
    label: "Thermal Overload",
    severity: "critical",
    check(m) {
      return (m.coolantTemp ?? 0) > 100
        && (m.oilTemp ?? 0) > 120
        && (m.engineLoad ?? 0) > 85;
    },
    description: "Both coolant and oil temps critical with maximum load — imminent thermal failure risk."
  }
];

function detectMultivariateSignatures(latestMetrics) {
  if (!latestMetrics) return [];
  const triggered = [];
  for (const sig of MULTIVARIATE_SIGNATURES) {
    try {
      if (sig.check(latestMetrics)) {
        triggered.push({
          id: sig.id,
          label: sig.label,
          severity: sig.severity,
          description: sig.description
        });
      }
    } catch (_) {
      // guard against unexpected metric shapes
    }
  }
  return triggered;
}

function generateAlertsFromState(state) {
  if (!state || state.insufficientHistory) return [];
  const alerts = [];
  const confidence = state.confidence || 0;
  const historySpanHours = Number(state.historySpanHours) || 0;
  const pushAlert = (type, severity, explanation, checks) => {
    alerts.push({
      id: makeId("ALERT"),
      dedupeKey: `ML:${state.vehicleId}:${type}`,
      orgId: state.orgId || null,
      vehicleId: state.vehicleId,
      type,
      severity,
      createdAt: new Date().toISOString(),
      explanation,
      recommendedChecks: checks
    });
  };
  if (historySpanHours >= 1 && state.anomalyScore != null && state.anomalyScore >= 0.7 && confidence >= 0.5) {
    const severity = state.anomalyScore >= 0.85 ? "critical" : "warning";
    pushAlert("GENERAL", severity, "Anomaly score exceeded threshold with sufficient confidence.", [
      "Review recent telemetry history.",
      "Inspect top contributing subsystems.",
      "Confirm last maintenance log."
    ]);
  }
  const coolingRisk = state.risk?.cooling?.risk14;
  if (historySpanHours >= 6 && coolingRisk != null && coolingRisk >= 70) {
    pushAlert("COOLING", coolingRisk >= 85 ? "critical" : "warning", "The projected 14-day cooling risk exceeded the alert threshold after at least six hours of telemetry history.", [
      "Inspect coolant levels and hoses.",
      "Review recent temperature spikes.",
      "Schedule cooling system inspection."
    ]);
  }
  const chargingRisk = state.risk?.charging?.risk14;
  const chargingEvidence = state.chargingEvidence;
  if (chargingRisk != null && ["warning", "critical"].includes(chargingEvidence?.status)) {
    pushAlert("CHARGING", chargingEvidence.status, chargingEvidence.explanation, [
      "Verify charging voltage with a calibrated meter under load.",
      "Inspect battery terminals, grounds, belt, and alternator connections.",
      "Review charging-system DTCs and repeat the check across another drive cycle."
    ]);
  }
  const fuelRisk = state.risk?.fuel?.risk14;
  if (historySpanHours >= 6 && fuelRisk != null && fuelRisk >= 70) {
    pushAlert("FUEL_SYSTEM", fuelRisk >= 85 ? "critical" : "warning", "The projected 14-day fuel-system risk exceeded the alert threshold after at least six hours of telemetry history.", [
      "Check fuel filters and lines.",
      "Review fuel rate anomalies.",
      "Verify injector health."
    ]);
  }
  if (historySpanHours >= 6 && state.climateContext?.extremeWeatherStress && confidence >= 0.4) {
    pushAlert("CLIMATE_STRESS", "warning", "Extreme ambient conditions detected relative to learned seasonal baseline.", [
      "Review route weather exposure and idling policy.",
      "Inspect cooling and charging systems for climate stress.",
      "Recompute model after next 24h of telemetry."
    ]);
  }
  return alerts;
}

// ── SAE J1939 research-backed 3-tier sensor thresholds ────────────────────
// Each entry: { unit, warnMin?, warnMax?, dangerMin?, dangerMax?, higherIsBad }
const SENSOR_DANGER_THRESHOLDS = {
  coolantTemp:          { unit: "°C",  warnMin: 110, warnMax: 118, dangerMin: 118, higherIsBad: true },
  oilTemp:              { unit: "°C",  warnMin: 110, warnMax: 125, dangerMin: 125, higherIsBad: true },
  batteryVoltage:       { unit: "V",   warnMin: 12.0, warnMax: 12.4, dangerMax: 12.0, higherIsBad: false },
  rpm:                  { unit: "rpm", warnMin: 2000, warnMax: 2800, dangerMin: 2800, higherIsBad: true },
  engineLoad:           { unit: "%",   warnMin: 80,  warnMax: 95,  dangerMin: 95,  higherIsBad: true },
  dpfSootLoad:          { unit: "%",   warnMin: 70,  warnMax: 85,  dangerMin: 85,  higherIsBad: true },
  egtC:                 { unit: "°C",  warnMin: 600, warnMax: 750, dangerMin: 750, higherIsBad: true },
  intakeManifoldPressure: { unit: "kPa", warnMin: 200, warnMax: 250, dangerMin: 250, higherIsBad: true },
  transmissionTemp:     { unit: "°C",  warnMin: 90,  warnMax: 110, dangerMin: 110, higherIsBad: true },
  engineHours:          { unit: "h",   warnMin: 490, warnMax: 510, dangerMin: 510, higherIsBad: true },
  tpmsPressurekPa:      { unit: "kPa", warnMin: 620, warnMax: 690, dangerMax: 620, higherIsBad: false },
  vibrationG:           { unit: "g",   warnMin: 1.5, warnMax: 2.5, dangerMin: 2.5, higherIsBad: true }
};

// Returns "NORMAL" | "WARNING" | "DANGER"
function sensorThresholdFor(metricKey, vehicleMeta = {}) {
  const base = SENSOR_DANGER_THRESHOLDS[metricKey];
  if (metricKey !== "coolantTemp" || !base) return base;
  const descriptor = [vehicleMeta.protocol, vehicleMeta.vehicleClass, vehicleMeta.class]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const heavyDuty = descriptor.includes("j1939") || descriptor.includes("heavy") || descriptor.includes("class 8");
  return heavyDuty
    ? Object.assign({}, base, { warnMin: 105, warnMax: 112, dangerMin: 112 })
    : base;
}

function classifySensorTier(metricKey, value, vehicleMeta = {}) {
  const t = sensorThresholdFor(metricKey, vehicleMeta);
  if (!t || value == null) return "NORMAL";
  if (t.higherIsBad) {
    if (t.dangerMin != null && value >= t.dangerMin) return "DANGER";
    if (t.warnMin  != null && value >= t.warnMin)  return "WARNING";
  } else {
    if (t.dangerMax != null && value <= t.dangerMax) return "DANGER";
    if (t.warnMax   != null && value <= t.warnMax)  return "WARNING";
  }
  return "NORMAL";
}

// Returns 0-100 risk score for a single sensor based on 3-tier thresholds + z-score blend
function computeSensorRiskScore(metricKey, value, baseline, vehicleMeta = {}) {
  const tier = classifySensorTier(metricKey, value, vehicleMeta);
  let thresholdScore = 0;
  if (tier === "WARNING") thresholdScore = 45;
  if (tier === "DANGER")  thresholdScore = 80;

  let zScore = 0;
  if (baseline && baseline.mean != null && baseline.std) {
    zScore = Math.abs((value - baseline.mean) / (baseline.std || 1));
  }
  const zContrib = clamp(zScore / 5, 0, 1) * 40;

  return Math.round(clamp(Math.max(thresholdScore, zContrib + thresholdScore * 0.3), 0, 100));
}

// Projects weeks until a metric hits its danger threshold using linear regression slope.
// samplesPerHour: how many telemetry samples arrive per hour (default: 12 = every 5 min)
// Returns number of weeks or null if trajectory is safe / not enough info.
function computeWeeksToFailure(values, metricKey, samplesPerHour = 12, vehicleMeta = {}) {
  if (!values || values.length < 10) return null;
  const t = sensorThresholdFor(metricKey, vehicleMeta);
  if (!t) return null;

  const current = values[values.length - 1];
  const slope = computeSlope(values); // units per sample index

  const dangerThreshold = t.higherIsBad ? t.dangerMin : t.dangerMax;
  if (dangerThreshold == null || slope === 0) return null;

  const trending = t.higherIsBad ? slope > 0 : slope < 0;
  if (!trending) return null;

  const samplesNeeded = Math.abs((dangerThreshold - current) / slope);
  const weeksNeeded = samplesNeeded / (samplesPerHour * 168);

  if (weeksNeeded <= 0 || weeksNeeded > 52) return null;
  return Math.round(weeksNeeded * 10) / 10;
}

// Master prediction function — ML engine computes everything, AI only narrates
function computeFullPrediction(samples, vehicleId, vehicleMeta = {}) {
  const usableSamples = usableTelemetrySamples(samples);
  if (!usableSamples.length) {
    return {
      vehicleId,
      sampleCount: 0,
      insufficientData: true,
      healthScore: null,
      sensorRisks: {},
      weeksToFailure: {},
      anomaly: null,
      risk: null,
      climateContext: null,
      topContributors: [],
      updatedAt: new Date().toISOString()
    };
  }

  const sorted = usableSamples.slice().sort((a, b) => new Date(a.ts) - new Date(b.ts));
  const observation = computeObservationStats(sorted);
  const latest = sorted[sorted.length - 1];
  const baselines = computeBaselines(sorted);
  const seasonalBaselines = computeSeasonalBaselines(sorted);
  const seasonKey = latest ? getSeasonFromTimestamp(latest.ts) : "unknown";
  const coverage = computeCoverage(baselines);
  const climateContext = computeClimateContext(sorted, baselines, seasonalBaselines, seasonKey);
  const historySpanHours = observation.operatingMinutes / 60;
  const chargingEvidence = computeChargingEvidence(sorted, vehicleMeta);

  // Per-sensor risk scores (0-100) and weeks-to-failure projections
  const sensorRisks = {};
  const weeksToFailure = {};

  // Only established health features affect the launch health score. Optional
  // PIDs are retained for baselines/evidence, but fast-cycling O2 or pedal data
  // must not create a maintenance risk merely because it moved normally.
  HEALTH_METRIC_KEYS.forEach((key) => {
    const current = metricNumber(key, latest.metrics?.[key]);
    if (current == null) return;
    const baseline = baselines[key];
    if (key === "batteryVoltage") {
      sensorRisks[key] = chargingEvidence.status === "critical"
        ? 90
        : chargingEvidence.status === "warning"
          ? 72
          : chargingEvidence.status === "monitor" ? 20 : 0;
    } else {
      sensorRisks[key] = computeSensorRiskScore(key, current, baseline, vehicleMeta);
    }

    const values = sorted
      .map((s) => metricNumber(key, s.metrics?.[key]))
      .filter((v) => v != null);
    const wtf = computeWeeksToFailure(values, key, 12, vehicleMeta);
    if (wtf != null) weeksToFailure[key] = wtf;
  });

  // Overall health score: 100 minus the max weighted sensor risk
  const riskValues = Object.values(sensorRisks);
  const maxRisk = riskValues.length ? Math.max(...riskValues) : 0;
  const avgRisk = riskValues.length
    ? Math.round(riskValues.reduce((a, b) => a + b, 0) / riskValues.length)
    : 0;
  const healthScore = Math.max(0, Math.round(100 - maxRisk * 0.6 - avgRisk * 0.4));

  // Anomaly score and system risks (existing logic)
  const anomaly = usableSamples.length >= MIN_SAMPLES
    ? computeAnomaly(latest, baselines, seasonalBaselines, seasonKey)
    : { score: null, contributors: [] };

  const risk = usableSamples.length >= MIN_SAMPLES
    ? computeRisk(sorted, baselines, climateContext, chargingEvidence)
    : null;

  const confidence = confidenceFrom(usableSamples.length, coverage, observation);
  const signatures = detectMultivariateSignatures(latest.metrics).filter((signature) =>
    signature.id !== "charging_failure"
      || ["warning", "critical"].includes(chargingEvidence.status)
  );

  return {
    vehicleId,
    orgId: latest.orgId || null,
    sampleCount: usableSamples.length,
    insufficientData: usableSamples.length < MIN_SAMPLES,
    healthScore,
    sensorRisks,
    weeksToFailure,
    anomalyScore: anomaly.score != null ? Math.round(anomaly.score * 100) : null,
    topContributors: anomaly.contributors,
    risk,
    historySpanHours,
    wallClockSpanHours: observation.wallClockSpanHours,
    operatingMinutes: observation.operatingMinutes,
    operatingSessionCount: observation.operatingSessionCount,
    chargingEvidence,
    climateContext,
    confidence,
    coverage,
    signatures,
    currentMetrics: Object.fromEntries(
      ANALYSIS_METRIC_KEYS.map((key) => [key, metricNumber(key, latest.metrics?.[key])])
    ),
    updatedAt: new Date().toISOString()
  };
}

module.exports = {
  MIN_SAMPLES,
  METRIC_KEYS,
  OPTIONAL_METRIC_KEYS,
  SENSOR_DANGER_THRESHOLDS,
  buildTelemetrySample,
  appendTelemetrySample,
  computeModelState,
  upsertModelState,
  computeFullPrediction,
  computeChargingEvidence,
  computeWeeksToFailure,
  computeSensorRiskScore,
  classifySensorTier,
  computeTimeWeightedBaseline,
  computeObservationStats,
  detectMultivariateSignatures,
  generateMaintenanceLabels,
  markPreEventWindow,
  detectFuelEventsFromSamples,
  generateAlertsFromState
};
