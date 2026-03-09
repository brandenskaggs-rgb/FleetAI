function autoDetectAdapter(payload, adapters) {
  if (!payload) return null;
  const frames = Array.isArray(payload.frames) ? payload.frames : [];
  const metrics = payload.metrics || payload.rawPids || {};
  const metricKeys = Object.keys(metrics || {});

  const hasObdPid =
    frames.some((f) => f.pid || f.mode || f.service) ||
    metricKeys.some((k) =>
      [
        "rpm",
        "engine_rpm",
        "speed",
        "speed_kph",
        "speedKph",
        "coolant_temp",
        "coolantTempC",
        "battery_voltage",
        "batteryVoltageV",
        "maf",
        "mafGramsPerSec"
      ].includes(k)
    );
  if (hasObdPid && adapters.has("OBD2")) return adapters.get("OBD2");

  const hasJ1939 =
    frames.some((f) => f.spn || f.spnId || f.pgn || f.pgnId || f.canId || f.id) ||
    metricKeys.some((k) =>
      [
        "engine_speed",
        "vehicle_speed",
        "coolant_temp",
        "battery_voltage",
        "engine_hours",
        "odometer_km",
        "fuel_rate_lph"
      ].includes(k)
    );
  if (hasJ1939 && adapters.has("J1939")) return adapters.get("J1939");

  const hasJ1708 = frames.some((f) => f.j1708 || f.mid || f.pidId);
  if (hasJ1708 && adapters.has("J1708")) return adapters.get("J1708");

  if (metrics.engine_speed || metrics.vehicle_speed) return adapters.get("J1939");

  return null;
}

module.exports = {
  autoDetectAdapter
};
