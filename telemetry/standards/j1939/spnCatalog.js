const SPN_CATALOG = {
  61444: [
    { spn: 190, name: "engine_speed", start: 3, length: 2, scale: 0.125, offset: 0, unit: "rpm" },
    { spn: 512, name: "driver_demand_torque", start: 1, length: 1, scale: 1, offset: -125, unit: "pct" },
    { spn: 513, name: "actual_engine_torque", start: 2, length: 1, scale: 1, offset: -125, unit: "pct" }
  ],
  65262: [
    { spn: 110, name: "coolant_temp", start: 0, length: 1, scale: 1, offset: -40, unit: "c" },
    { spn: 174, name: "fuel_temp", start: 1, length: 1, scale: 1, offset: -40, unit: "c" }
  ],
  65263: [
    { spn: 94, name: "fuel_delivery_pressure", start: 0, length: 1, scale: 4, offset: 0, unit: "kpa" },
    { spn: 100, name: "oil_pressure", start: 1, length: 1, scale: 4, offset: 0, unit: "kpa" },
    { spn: 101, name: "oil_temp", start: 2, length: 1, scale: 1, offset: -40, unit: "c" }
  ],
  65265: [
    { spn: 84, name: "vehicle_speed", start: 1, length: 2, scale: 1 / 256, offset: 0, unit: "kph" }
  ],
  65269: [
    { spn: 171, name: "ambient_temp", start: 0, length: 1, scale: 1, offset: -40, unit: "c" },
    { spn: 108, name: "barometric_pressure", start: 1, length: 2, scale: 0.5, offset: 0, unit: "kpa" }
  ],
  65266: [
    { spn: 183, name: "fuel_rate", start: 0, length: 2, scale: 0.05, offset: 0, unit: "lph" },
    { spn: 184, name: "instant_fuel_economy", start: 2, length: 2, scale: 1 / 512, offset: 0, unit: "kmpl" }
  ],
  65257: [
    { spn: 168, name: "battery_voltage", start: 0, length: 2, scale: 0.05, offset: 0, unit: "v" }
  ],
  65270: [
    { spn: 173, name: "exhaust_temp", start: 0, length: 2, scale: 0.03125, offset: 0, unit: "c" }
  ],
  65259: [
    { spn: 247, name: "engine_hours", start: 0, length: 4, scale: 0.05, offset: 0, unit: "h" }
  ],
  65260: [
    { spn: 245, name: "vehicle_distance", start: 0, length: 4, scale: 0.125, offset: 0, unit: "km" }
  ]
};

module.exports = {
  SPN_CATALOG
};
