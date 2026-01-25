const { decodeJ1708Frames } = require("../decoders/j1708J1587Decoder");

const j1708Adapter = {
  name: "J1708/J1587 Adapter",
  protocol: "J1708",
  capabilities: [
    "rpm",
    "speedKph",
    "coolantTempC",
    "batteryVoltageV",
    "engineHours",
    "fuelRateLph"
  ],
  decodeFrames(frames) {
    return decodeJ1708Frames(frames || []);
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
  j1708Adapter
};
