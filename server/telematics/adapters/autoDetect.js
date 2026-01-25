function autoDetectAdapter(payload, adapters) {
  if (!payload) return null;
  const frames = Array.isArray(payload.frames) ? payload.frames : [];
  const metrics = payload.metrics || payload.rawPids || {};

  const hasObdPid = frames.some((f) => f.pid || f.mode) || metrics.rpm || metrics.coolant_temp;
  if (hasObdPid && adapters.has("OBD2")) return adapters.get("OBD2");

  const hasJ1939 = frames.some((f) => f.spn || f.pgn || f.pgnId);
  if (hasJ1939 && adapters.has("J1939")) return adapters.get("J1939");

  const hasJ1708 = frames.some((f) => f.j1708 || f.mid || f.pidId);
  if (hasJ1708 && adapters.has("J1708")) return adapters.get("J1708");

  if (metrics.engine_speed || metrics.vehicle_speed) return adapters.get("J1939");

  return null;
}

module.exports = {
  autoDetectAdapter
};
