const { decodeObd2Frames } = require("../decoders/obd2PidDecoder");

const obd2Adapter = {
  name: "OBD2 Adapter",
  protocol: "OBD2",
  capabilities: [
    "rpm",
    "speedKph",
    "coolantTempC",
    "intakeAirTempC",
    "mafGramsPerSec",
    "engineLoadPct",
    "throttlePosPct",
    "fuelLevelPct",
    "oilTempC",
    "batteryVoltageV",
    "dtcActive",
    "dtcPending",
    "vin"
  ],
  decodeFrames(frames) {
    return decodeObd2Frames(frames || []);
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
  obd2Adapter
};
