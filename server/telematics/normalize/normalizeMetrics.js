const { fToC, mphToKph, milesToKm, gphToLph } = require("./units");

function normalizeMetrics(input) {
  const decoded = input.decoded || {};
  const metrics = decoded.metrics || decoded || {};
  const dtc = decoded.dtc || {};
  const meta = decoded.meta || {};
  const protocol = String(input.protocol || "UNKNOWN").toUpperCase();

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
    ltft1: metrics.ltft1 ?? metrics.longTermFuelTrim ?? null
  };

  const electrical = {
    batteryVoltageV: metrics.batteryVoltageV ?? metrics.batteryVoltage ?? null
  };

  const vehicle = {
    speedKph: metrics.speedKph ?? (metrics.speedMph != null ? mphToKph(metrics.speedMph) : null),
    odometerKm: metrics.odometerKm ?? (metrics.odometerMiles != null ? milesToKm(metrics.odometerMiles) : null),
    engineHours: metrics.engineHours ?? null,
    fuelLevelPct: metrics.fuelLevelPct ?? null
  };

  const emissions = {
    egtC: metrics.egtC ?? null,
    dpfSootLoadPct: metrics.dpfSootLoadPct ?? null,
    regenActive: metrics.regenActive ?? null
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
