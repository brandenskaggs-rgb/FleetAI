const EMPTY_ARRAY = Object.freeze([]);

function createTelemetrySchema() {
  return {
    vehicleId: "",
    deviceId: "",
    vehicleClass: "light",
    timestamp: new Date().toISOString(),
    engine: {
      rpm: null,
      torqueDemandPct: null,
      torqueActualPct: null,
      coolantTempC: null,
      oilPressureKpa: null,
      oilTempC: null,
      exhaustTempC: null,
      engineHours: null
    },
    vehicle: {
      speedKph: null,
      distanceKm: null
    },
    fuel: {
      rateLph: null,
      economyKmpl: null,
      fuelTempC: null
    },
    electrical: {
      batteryVoltage: null
    },
    environment: {
      ambientTempC: null,
      barometricPressureKpa: null
    },
    diagnostics: {
      activeDTCs: EMPTY_ARRAY,
      previousDTCs: EMPTY_ARRAY
    },
    meta: {
      supportedStandards: [],
      busHealth: {
        ok: false,
        lastFrameAt: null,
        dropCount: 0,
        errorCount: 0
      },
      confidenceScore: 0
    }
  };
}

function mergeTelemetry(target, update) {
  if (!update) return target;
  Object.keys(update).forEach((key) => {
    if (typeof update[key] === "object" && update[key] !== null && !Array.isArray(update[key])) {
      target[key] = target[key] || {};
      mergeTelemetry(target[key], update[key]);
    } else {
      target[key] = update[key];
    }
  });
  return target;
}

module.exports = {
  createTelemetrySchema,
  mergeTelemetry
};
