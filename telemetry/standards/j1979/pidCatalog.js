const PID_CATALOG = {
  "0C": { name: "engine_rpm", unit: "rpm", bytes: 2 },
  "0D": { name: "vehicle_speed", unit: "kph", bytes: 1 },
  "05": { name: "coolant_temp", unit: "c", bytes: 1 },
  "2F": { name: "fuel_level", unit: "pct", bytes: 1 },
  "11": { name: "throttle_pos", unit: "pct", bytes: 1 },
  "42": { name: "control_module_voltage", unit: "v", bytes: 2 },
  "5C": { name: "oil_temp", unit: "c", bytes: 1 },
  "1F": { name: "engine_runtime", unit: "s", bytes: 2 },
  "31": { name: "distance_since_clear", unit: "km", bytes: 2 },
  "A6": { name: "odometer", unit: "km", bytes: 4 }
};

module.exports = {
  PID_CATALOG
};
