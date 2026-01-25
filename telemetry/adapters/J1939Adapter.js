const BaseAdapter = require("./BaseAdapter");
const { decodeSpns, decodeDmDtc, J1939Reassembler, decodeFrame } = require("../standards/j1939/decoder");
const { J1939Discovery } = require("../standards/j1939/discovery");

class J1939Adapter extends BaseAdapter {
  constructor() {
    super();
    this.standard = "J1939";
    this.reassembler = new J1939Reassembler();
    this.discovery = new J1939Discovery();
  }

  handleFrame(frame) {
    const decoded = decodeFrame(frame, this.reassembler);
    if (!decoded) return null;
    const pgn = decoded.pgn;
    const data = decoded.data || [];
    this.discovery.registerPgn(pgn);

    if (pgn === 65226 || pgn === 65227) {
      const dtcs = decodeDmDtc(data).map((d) => `SPN${d.spn} FMI${d.fmi} OC${d.oc}`);
      return {
        diagnostics: pgn === 65226 ? { activeDTCs: dtcs } : { previousDTCs: dtcs }
      };
    }

    const spns = decodeSpns(pgn, data);
    this.discovery.registerSpns(spns.map((s) => s.spn));
    return this.mapSpns(spns);
  }

  mapSpns(spns) {
    const update = {};
    for (const spn of spns) {
      if (spn.value == null) continue;
      switch (spn.name) {
        case "engine_speed":
          update.engine = { ...(update.engine || {}), rpm: spn.value };
          break;
        case "driver_demand_torque":
          update.engine = { ...(update.engine || {}), torqueDemandPct: spn.value };
          break;
        case "actual_engine_torque":
          update.engine = { ...(update.engine || {}), torqueActualPct: spn.value };
          break;
        case "coolant_temp":
          update.engine = { ...(update.engine || {}), coolantTempC: spn.value };
          break;
        case "oil_pressure":
          update.engine = { ...(update.engine || {}), oilPressureKpa: spn.value };
          break;
        case "oil_temp":
          update.engine = { ...(update.engine || {}), oilTempC: spn.value };
          break;
        case "exhaust_temp":
          update.engine = { ...(update.engine || {}), exhaustTempC: spn.value };
          break;
        case "engine_hours":
          update.engine = { ...(update.engine || {}), engineHours: spn.value };
          break;
        case "vehicle_speed":
          update.vehicle = { ...(update.vehicle || {}), speedKph: spn.value };
          break;
        case "vehicle_distance":
          update.vehicle = { ...(update.vehicle || {}), distanceKm: spn.value };
          break;
        case "fuel_rate":
          update.fuel = { ...(update.fuel || {}), rateLph: spn.value };
          break;
        case "instant_fuel_economy":
          update.fuel = { ...(update.fuel || {}), economyKmpl: spn.value };
          break;
        case "fuel_temp":
          update.fuel = { ...(update.fuel || {}), fuelTempC: spn.value };
          break;
        case "battery_voltage":
          update.electrical = { ...(update.electrical || {}), batteryVoltage: spn.value };
          break;
        case "ambient_temp":
          update.environment = { ...(update.environment || {}), ambientTempC: spn.value };
          break;
        case "barometric_pressure":
          update.environment = { ...(update.environment || {}), barometricPressureKpa: spn.value };
          break;
        default:
          break;
      }
    }
    return update;
  }
}

module.exports = J1939Adapter;
