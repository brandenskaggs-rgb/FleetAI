const { fToC, mphToKph, milesToKm, gphToLph } = require("./units");

// True when an object carries at least one recognised reading key. Used to tell
// a wrapper object ({ metrics: {...} }) apart from a flat reading map, without
// guessing from structure alone.
const READING_KEYS = [
  "rpm", "engineLoadPct", "engine_load", "torquePct",
  "coolantTempC", "coolantTempF", "oilTempC", "oilTempF",
  "intakeAirTempC", "intakeAirTempF", "mafGramsPerSec", "maf",
  "fuelRateLph", "fuelRateGph", "throttlePosPct",
  "stft1", "shortTermFuelTrim", "ltft1", "longTermFuelTrim",
  "batteryVoltageV", "batteryVoltage",
  "speedKph", "speedMph", "odometerKm", "odometerMiles",
  "engineHours", "fuelLevelPct",
  "egtC", "dpfSootLoadPct", "regenActive",
  "engineOilPressureKpa", "fuelDeliveryPressureKpa", "engineOilLevelPct",
  "actualTorquePct", "driverDemandTorquePct", "ambientTempC", "barometricPressureKpa",
  "instantFuelEconomyKmPerL", "tripDistanceKm", "alternatorVoltageV"
];

function hasAnyReading(obj) {
  if (!obj || typeof obj !== "object") return false;
  return READING_KEYS.some((k) => obj[k] !== undefined);
}

function normalizeMetrics(input) {
  const src = input || {};

  // Accept three shapes, because three different callers produce three
  // different ones and only the first used to work:
  //
  //   1. { decoded: { metrics, dtc, meta } }   gateway/OEM ingestion
  //   2. { metrics, dtc, meta }                server-side callers
  //   3. { rpm: 1450, speedKph: 95, ... }      a FLAT reading map — what the
  //                                            Android tablet actually posts
  //
  // The previous expression was:
  //     const decoded = input.decoded || {};
  //     const metrics = decoded.metrics || decoded || {};
  //
  // For shape 3, input.decoded is undefined so decoded became {}. `{}` is
  // truthy, so `decoded.metrics || decoded` short-circuited to that empty
  // object and the caller's readings were never looked at. Every field came
  // back null. That silently emptied the entire tablet -> backend -> dashboard
  // telemetry path: /api/telemetry/ingest passes payload.metrics straight in,
  // so a truck streaming real OBD-II data produced an all-null snapshot and the
  // fleet manager saw a connected vehicle reporting nothing.
  const decoded = (src.decoded && typeof src.decoded === "object") ? src.decoded : null;
  const metrics =
    (decoded && decoded.metrics && typeof decoded.metrics === "object") ? decoded.metrics
    : (decoded && hasAnyReading(decoded)) ? decoded
    : (src.metrics && typeof src.metrics === "object") ? src.metrics
    : src;

  const dtc = (decoded && decoded.dtc) || src.dtc || {};
  const meta = (decoded && decoded.meta) || src.meta || {};
  const protocol = String(src.protocol || (decoded && decoded.protocol) || "UNKNOWN").toUpperCase();

  const engine = {
    rpm: metrics.rpm ?? null,
    engineLoadPct: metrics.engineLoadPct ?? metrics.engine_load ?? null,
    torquePct: metrics.torquePct ?? null,
    coolantTempC: metrics.coolantTempC ?? (metrics.coolantTempF != null ? fToC(metrics.coolantTempF) : null),
    oilTempC: metrics.oilTempC ?? (metrics.oilTempF != null ? fToC(metrics.oilTempF) : null),
    intakeAirTempC: metrics.intakeAirTempC ?? (metrics.intakeAirTempF != null ? fToC(metrics.intakeAirTempF) : null),
    mafGramsPerSec: metrics.mafGramsPerSec ?? metrics.maf ?? null,
    fuelRateLph: metrics.fuelRateLph ?? (metrics.fuelRateGph != null ? gphToLph(metrics.fuelRateGph) : null),
    throttlePosPct: metrics.throttlePosPct ?? null,
    stft1: metrics.stft1 ?? metrics.shortTermFuelTrim ?? null,
    ltft1: metrics.ltft1 ?? metrics.longTermFuelTrim ?? null,
    engineOilPressureKpa: metrics.engineOilPressureKpa ?? null,
    fuelDeliveryPressureKpa: metrics.fuelDeliveryPressureKpa ?? null,
    engineOilLevelPct: metrics.engineOilLevelPct ?? null,
    actualTorquePct: metrics.actualTorquePct ?? null,
    driverDemandTorquePct: metrics.driverDemandTorquePct ?? null
  };

  const electrical = {
    batteryVoltageV: metrics.batteryVoltageV ?? metrics.batteryVoltage ?? null,
    alternatorVoltageV: metrics.alternatorVoltageV ?? null
  };

  const vehicle = {
    speedKph: metrics.speedKph ?? (metrics.speedMph != null ? mphToKph(metrics.speedMph) : null),
    odometerKm: metrics.odometerKm ?? (metrics.odometerMiles != null ? milesToKm(metrics.odometerMiles) : null),
    engineHours: metrics.engineHours ?? null,
    fuelLevelPct: metrics.fuelLevelPct ?? null,
    tripDistanceKm: metrics.tripDistanceKm ?? null,
    instantFuelEconomyKmPerL: metrics.instantFuelEconomyKmPerL ?? null
  };

  const emissions = {
    egtC: metrics.egtC ?? null,
    dpfSootLoadPct: metrics.dpfSootLoadPct ?? null,
    regenActive: metrics.regenActive ?? null
  };

  const environment = {
    ambientTempC: metrics.ambientTempC ?? null,
    barometricPressureKpa: metrics.barometricPressureKpa ?? metrics.baroKpa ?? null
  };

  const active = Array.isArray(dtc.active) ? dtc.active : [];
  const pending = Array.isArray(dtc.pending) ? dtc.pending : [];
  const toObj = (code) => ({
    code,
    system: code ? code.slice(0, 1) : "",
    protocol
  });

  return {
    timestamp: input.timestamp || new Date().toISOString(),
    orgId: input.orgId || null,
    vehicleId: input.vehicleId || null,
    sourceProtocol: protocol,
    engine,
    electrical,
    vehicle,
    emissions,
    environment,
    dtc: {
      active: active.map(toObj),
      pending: pending.map(toObj)
    },
    meta: {
      vin: metrics.vin || meta.vin || null,
      ecuCount: metrics.ecuCount || meta.ecuCount || null,
      supportedPids: meta.supportedPids || [],
      supportedSpns: meta.supportedSpns || []
    }
  };
}

module.exports = {
  normalizeMetrics
};
