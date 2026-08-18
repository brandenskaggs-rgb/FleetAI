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
  "instantFuelEconomyKmPerL", "tripDistanceKm", "alternatorVoltageV", "mapKpa", "boostPsi",
  "shortTermFuelTrimBank1Pct", "longTermFuelTrimBank1Pct", "shortTermFuelTrimBank2Pct", "longTermFuelTrimBank2Pct",
  "fuelPressureKpa", "fuelRailPressureRelativeKpa", "fuelRailGaugePressureKpa", "fuelRailAbsolutePressureKpa",
  "ignitionTimingAdvanceDeg", "commandedEgrPct", "egrErrorPct", "commandedEvapPurgePct",
  "commandedEquivalenceRatio", "fuelInjectionTimingDeg", "absoluteLoadPct",
  "o2B1S1VoltageV", "o2B1S2VoltageV", "o2B2S1VoltageV", "o2B2S2VoltageV",
  "catalystTempB1S1C", "catalystTempB2S1C", "catalystTempB1S2C", "catalystTempB2S2C",
  "relativeThrottlePosPct", "absoluteThrottleBPosPct", "absoluteThrottleCPosPct",
  "acceleratorPedalDPosPct", "acceleratorPedalEPosPct", "acceleratorPedalFPosPct",
  "relativeAcceleratorPedalPct", "acceleratorPedalPosPct", "commandedThrottleActuatorPct", "referenceTorqueNm",
  "engineRunTimeSec", "distanceWithMilOnKm", "warmupsSinceClear", "distanceSinceClearKm",
  "milRunTimeMin", "timeSinceClearMin",
  "evapSystemVaporPressurePa", "absoluteEvapVaporPressureKpa", "evapSystemVaporPressureWidePa",
  "ethanolFuelPct", "hybridBatteryRemainingPct", "odometerKm",
  "brakePedalPositionPct", "serviceBrakeActive", "absActive", "tractionControlBrakeActive"
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
    driverDemandTorquePct: metrics.driverDemandTorquePct ?? null,
    mapKpa: metrics.mapKpa ?? null,
    boostPsi: metrics.boostPsi ?? null,
    absoluteLoadPct: metrics.absoluteLoadPct ?? null,
    ignitionTimingAdvanceDeg: metrics.ignitionTimingAdvanceDeg ?? null,
    referenceTorqueNm: metrics.referenceTorqueNm ?? null,
    shortTermFuelTrimBank1Pct: metrics.shortTermFuelTrimBank1Pct ?? metrics.stft1 ?? metrics.shortTermFuelTrim ?? null,
    longTermFuelTrimBank1Pct: metrics.longTermFuelTrimBank1Pct ?? metrics.ltft1 ?? metrics.longTermFuelTrim ?? null,
    shortTermFuelTrimBank2Pct: metrics.shortTermFuelTrimBank2Pct ?? null,
    longTermFuelTrimBank2Pct: metrics.longTermFuelTrimBank2Pct ?? null,
    fuelPressureKpa: metrics.fuelPressureKpa ?? null,
    fuelRailPressureRelativeKpa: metrics.fuelRailPressureRelativeKpa ?? null,
    fuelRailGaugePressureKpa: metrics.fuelRailGaugePressureKpa ?? null,
    fuelRailAbsolutePressureKpa: metrics.fuelRailAbsolutePressureKpa ?? null,
    commandedEquivalenceRatio: metrics.commandedEquivalenceRatio ?? null,
    fuelInjectionTimingDeg: metrics.fuelInjectionTimingDeg ?? null,
    engineRunTimeSec: metrics.engineRunTimeSec ?? null
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
    instantFuelEconomyKmPerL: metrics.instantFuelEconomyKmPerL ?? null,
    distanceWithMilOnKm: metrics.distanceWithMilOnKm ?? null,
    warmupsSinceClear: metrics.warmupsSinceClear ?? null,
    distanceSinceClearKm: metrics.distanceSinceClearKm ?? null,
    milRunTimeMin: metrics.milRunTimeMin ?? null,
    timeSinceClearMin: metrics.timeSinceClearMin ?? null,
    hybridBatteryRemainingPct: metrics.hybridBatteryRemainingPct ?? null
  };

  const emissions = {
    egtC: metrics.egtC ?? null,
    dpfSootLoadPct: metrics.dpfSootLoadPct ?? null,
    regenActive: metrics.regenActive ?? null,
    o2B1S1VoltageV: metrics.o2B1S1VoltageV ?? null,
    o2B1S2VoltageV: metrics.o2B1S2VoltageV ?? null,
    o2B2S1VoltageV: metrics.o2B2S1VoltageV ?? null,
    o2B2S2VoltageV: metrics.o2B2S2VoltageV ?? null,
    catalystTempB1S1C: metrics.catalystTempB1S1C ?? null,
    catalystTempB2S1C: metrics.catalystTempB2S1C ?? null,
    catalystTempB1S2C: metrics.catalystTempB1S2C ?? null,
    catalystTempB2S2C: metrics.catalystTempB2S2C ?? null,
    commandedEgrPct: metrics.commandedEgrPct ?? null,
    egrErrorPct: metrics.egrErrorPct ?? null,
    commandedEvapPurgePct: metrics.commandedEvapPurgePct ?? null,
    evapSystemVaporPressurePa: metrics.evapSystemVaporPressurePa ?? null,
    absoluteEvapVaporPressureKpa: metrics.absoluteEvapVaporPressureKpa ?? null,
    evapSystemVaporPressureWidePa: metrics.evapSystemVaporPressureWidePa ?? null
  };

  const environment = {
    ambientTempC: metrics.ambientTempC ?? null,
    barometricPressureKpa: metrics.barometricPressureKpa ?? metrics.baroKpa ?? null
  };

  const controls = {
    relativeThrottlePosPct: metrics.relativeThrottlePosPct ?? null,
    absoluteThrottleBPosPct: metrics.absoluteThrottleBPosPct ?? null,
    absoluteThrottleCPosPct: metrics.absoluteThrottleCPosPct ?? null,
    acceleratorPedalDPosPct: metrics.acceleratorPedalDPosPct ?? null,
    acceleratorPedalEPosPct: metrics.acceleratorPedalEPosPct ?? null,
    acceleratorPedalFPosPct: metrics.acceleratorPedalFPosPct ?? null,
    acceleratorPedalPosPct: metrics.acceleratorPedalPosPct ?? null,
    relativeAcceleratorPedalPct: metrics.relativeAcceleratorPedalPct ?? null,
    commandedThrottleActuatorPct: metrics.commandedThrottleActuatorPct ?? null
  };

  const brakes = {
    brakePedalPositionPct: metrics.brakePedalPositionPct ?? null,
    serviceBrakeActive: metrics.serviceBrakeActive ?? null,
    absActive: metrics.absActive ?? null,
    tractionControlBrakeActive: metrics.tractionControlBrakeActive ?? null
  };

  const fuel = {
    ethanolFuelPct: metrics.ethanolFuelPct ?? null
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
    controls,
    brakes,
    fuel,
    dtc: {
      active: active.map(toObj),
      pending: pending.map(toObj)
    },
    meta: {
      vin: metrics.vin || meta.vin || null,
      ecuCount: metrics.ecuCount || meta.ecuCount || null,
      supportedPids: meta.supportedPids || [],
      supportedSpns: meta.supportedSpns || [],
      metricAgesMs: meta.metricAgesMs || {}
    }
  };
}

module.exports = {
  normalizeMetrics
};
