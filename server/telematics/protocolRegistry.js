const { obd2Adapter } = require("./adapters/obd2Adapter");
const { j1939Adapter } = require("./adapters/j1939Adapter");
const { j1708Adapter } = require("./adapters/j1708Adapter");
const { autoDetectAdapter } = require("./adapters/autoDetect");

const adapters = new Map();

function registerAdapter(name, adapter) {
  adapters.set(String(name).toUpperCase(), adapter);
}

function getAdapter(protocol) {
  if (!protocol) return null;
  const normalized = String(protocol).trim().toUpperCase();
  const aliases = {
    OBD: "OBD2",
    OBDII: "OBD2",
    J1979: "OBD2",
    HDOBD: "OBD2",
    J1939CAN: "J1939",
    J1939_CAN: "J1939",
    CAN_J1939: "J1939",
    SAEJ1939: "J1939",
    J1708J1587: "J1708",
    J1587: "J1708"
  };
  return adapters.get(aliases[normalized] || normalized) || null;
}

function detectAdapter(payload) {
  const explicit = payload.protocol || payload.sourceProtocol;
  if (explicit) {
    const adapter = getAdapter(explicit);
    if (adapter) return adapter;
  }
  return autoDetectAdapter(payload, adapters) || getAdapter("UNKNOWN");
}

registerAdapter("OBD2", obd2Adapter);
registerAdapter("J1939", j1939Adapter);
registerAdapter("J1708", j1708Adapter);
registerAdapter("UNKNOWN", {
  name: "UNKNOWN",
  protocol: "UNKNOWN",
  capabilities: [],
  decodeFrames: () => ({ metrics: {}, dtc: {}, meta: {} }),
  decodeMetrics: (metrics) => ({ metrics: metrics || {}, dtc: {}, meta: {} })
});

module.exports = {
  registerAdapter,
  getAdapter,
  detectAdapter
};
