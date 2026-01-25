const { decodeJ1939Frames } = require("../decoders/j1939PgnDecoder");

const j1939Adapter = {
  name: "J1939 Adapter",
  protocol: "J1939",
  capabilities: [
    "rpm",
    "speedKph",
    "coolantTempC",
    "oilTempC",
    "batteryVoltageV",
    "engineLoadPct",
    "fuelRateLph",
    "engineHours",
    "odometerKm",
    "fuelLevelPct",
    "egtC",
    "dpfSootLoadPct",
    "regenActive"
  ],
  decodeFrames(frames) {
    return decodeJ1939Frames(frames || []);
  },
  decodeMetrics(metrics) {
    return {
      metrics: metrics || {},
      dtc: {},
      meta: {}
    };
  }
};

module.exports = {
  j1939Adapter
};
