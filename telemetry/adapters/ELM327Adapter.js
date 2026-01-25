const BaseAdapter = require("./BaseAdapter");
const { decodePid, decodeDtcBytes, decodeVin } = require("../standards/j1979/decoder");
const { decodeSupportedPids } = require("../standards/j1979/discovery");
const { PID_CATALOG } = require("../standards/j1979/pidCatalog");
const { decodeVinAttributes } = require("../standards/j1979/vinDecode");

class ELM327Adapter extends BaseAdapter {
  constructor() {
    super();
    this.standard = "J1979";
    this.supportedPids = new Set();
    this.lastVin = null;
    this.lastGoodSampleAt = null;
    this.pidCooldown = new Map(); // pid -> timestamp until resume
    this.pidFailCount = new Map(); // pid -> consecutive failures
    this.discoveryDone = false;
    this.vinDecoded = null;
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
        this.discoveryDone = true;
        return null;
      }
      const decoded = decodePid(pid.toString(16).toUpperCase().padStart(2, "0"), data);
      if (!decoded || decoded.value == null) return null;
      this.lastGoodSampleAt = Date.now();
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
      this.vinDecoded = decodeVinAttributes(this.lastVin);
      return { meta: { vin: this.lastVin, vinDecoded: this.vinDecoded } };
    }
    return null;
  }

  mapDecoded(decoded) {
    const out = {};
    switch (decoded.key) {
      case "engine_rpm":
        out.engine = { rpm: decoded.value };
        break;
      case "driver_demand_torque":
        out.engine = { ...(out.engine || {}), torqueDemandPct: decoded.value };
        break;
      case "actual_engine_torque":
        out.engine = { ...(out.engine || {}), torqueActualPct: decoded.value };
        break;
      case "vehicle_speed":
        out.vehicle = { speedKph: decoded.value };
        break;
      case "coolant_temp":
        out.engine = { coolantTempC: decoded.value };
        break;
      case "iat":
      case "intake_air_temp":
        out.engine = { intakeAirTempC: decoded.value };
        break;
      case "intake_air_temp":
        out.engine = { intakeAirTempC: decoded.value };
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
      case "maf":
        out.engine = { mafGramsPerSec: decoded.value };
        break;
      case "engine_load":
        out.engine = { loadPct: decoded.value };
        break;
      case "map":
        out.engine = { mapKpa: decoded.value };
        break;
      case "baro":
        out.engine = { baroKpa: decoded.value };
        break;
      case "fuel_pressure":
        out.fuel = { fuelPressureKpa: decoded.value };
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

  /**
   * Build a polling plan with adaptive cooldown for unsupported PIDs.
   * Returns array of { pidHex, intervalMs }
   */
  buildPollingPlan() {
    const core = [
      { pid: "0C", rate: 250 }, // rpm fast
      { pid: "0D", rate: 250 }, // speed fast
      { pid: "11", rate: 300 }, // throttle fast
      { pid: "05", rate: 800 }, // coolant
      { pid: "0F", rate: 800 }, // intake
      { pid: "10", rate: 800 }, // maf
      { pid: "04", rate: 800 }, // load
      { pid: "42", rate: 1000 }, // voltage
      { pid: "2F", rate: 4000 }, // fuel level
      { pid: "33", rate: 4000 }, // baro
      { pid: "0B", rate: 800 }, // map
      { pid: "0A", rate: 4000 } // fuel pressure
    ];
    const supported = this.discoveryDone && this.supportedPids.size
      ? core.filter((c) => this.supportedPids.has(c.pid))
      : core; // fallback: optimistic core
    return supported;
  }

  /**
   * Decide if a pid should be skipped due to cooldown/backoff
   */
  shouldSkip(pid) {
    const until = this.pidCooldown.get(pid);
    if (!until) return false;
    if (Date.now() > until) {
      this.pidCooldown.delete(pid);
      this.pidFailCount.set(pid, 0);
      return false;
    }
    return true;
  }

  markFailure(pid) {
    const fail = (this.pidFailCount.get(pid) || 0) + 1;
    this.pidFailCount.set(pid, fail);
    if (fail >= 3) {
      // back off for 30s
      this.pidCooldown.set(pid, Date.now() + 30000);
    }
  }
}

module.exports = ELM327Adapter;
