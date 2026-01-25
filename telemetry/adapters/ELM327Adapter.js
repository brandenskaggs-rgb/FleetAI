const BaseAdapter = require("./BaseAdapter");
const { decodePid, decodeDtcBytes, decodeVin } = require("../standards/j1979/decoder");
const { decodeSupportedPids } = require("../standards/j1979/discovery");

class ELM327Adapter extends BaseAdapter {
  constructor() {
    super();
    this.standard = "J1979";
    this.supportedPids = new Set();
    this.lastVin = null;
  }

  handleFrame(frame) {
    if (!frame || frame.mode == null) return null;
    const mode = frame.mode;
    const pid = frame.pid;
    const data = frame.data || [];

    if (mode === 0x01 && pid) {
      if (pid === 0x00 || pid === 0x20 || pid === 0x40 || pid === 0x60) {
        const basePid = pid;
        const supported = decodeSupportedPids(data, basePid);
        supported.forEach((p) => this.supportedPids.add(p));
        return null;
      }
      const decoded = decodePid(pid.toString(16).toUpperCase().padStart(2, "0"), data);
      if (!decoded || decoded.value == null) return null;
      return this.mapDecoded(decoded);
    }

    if (mode === 0x03 || mode === 0x07) {
      const dtcs = decodeDtcBytes(data);
      return {
        diagnostics: mode === 0x03 ? { activeDTCs: dtcs } : { previousDTCs: dtcs }
      };
    }

    if (mode === 0x09 && pid === 0x02) {
      this.lastVin = decodeVin(data);
      return { meta: { vin: this.lastVin } };
    }
    return null;
  }

  mapDecoded(decoded) {
    const out = {};
    switch (decoded.key) {
      case "engine_rpm":
        out.engine = { rpm: decoded.value };
        break;
      case "vehicle_speed":
        out.vehicle = { speedKph: decoded.value };
        break;
      case "coolant_temp":
        out.engine = { coolantTempC: decoded.value };
        break;
      case "oil_temp":
        out.engine = { oilTempC: decoded.value };
        break;
      case "fuel_level":
        out.fuel = { levelPct: decoded.value };
        break;
      case "control_module_voltage":
        out.electrical = { batteryVoltage: decoded.value };
        break;
      case "engine_runtime":
        out.engine = { engineHours: decoded.value / 3600 };
        break;
      case "distance_since_clear":
        out.vehicle = { distanceKm: decoded.value };
        break;
      case "odometer":
        out.vehicle = { distanceKm: decoded.value };
        break;
      default:
        break;
    }
    return out;
  }
}

module.exports = ELM327Adapter;
