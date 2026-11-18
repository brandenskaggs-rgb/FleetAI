const { randomUUID } = require("node:crypto");

// Signal names only: never executable diagnostic commands or ECU addresses.
const WATCH_GROUPS = Object.freeze({
  engine: ["rpm", "speedKph", "engineLoadPct", "throttlePosPct", "ignitionTimingAdvanceDeg", "shortTermFuelTrimBank1Pct", "shortTermFuelTrimBank2Pct", "fuelRailGaugePressureKpa", "fuelRailAbsolutePressureKpa", "cylinderMisfireCount"],
  transmission: ["transmissionTempC", "transmissionInputSpeedRpm", "transmissionOutputSpeedRpm", "transmissionGear", "torqueConverterSlipRpm", "transmissionPressureKpa"],
  brakes: ["wheelSpeedFlKph", "wheelSpeedFrKph", "wheelSpeedRlKph", "wheelSpeedRrKph", "absActive", "tractionControlBrakeActive", "serviceBrakeActive", "brakePedalPositionPct"]
});
const allKeys = new Set(Object.values(WATCH_GROUPS).flat());
const scope = (orgId, vehicleId) => {
  if (!orgId || !vehicleId) throw new Error("Sensor watch requires organization and vehicle scope");
  return { orgId, vehicleId };
};

function watchProposal(message, vehicleId) {
  const text = String(message || "");
  if (!vehicleId || /\b(don't|do not|never|cannot|can't)\b/i.test(text)) return null;
  if (/\b(stop|cancel|disable|end)\b.*\b(watch|monitoring|monitor)\b/i.test(text)) {
    return { action: "stop_sensor_watch", mode: "confirmation_required", label: "Stop focused monitoring", payload: { vehicleId } };
  }
  if (!/\b(watch|monitor|track)\b/i.test(text)) return null;
  const groups = [];
  if (/\b(engine|misfir\w*|fuel|ignition)\b/i.test(text)) groups.push("engine");
  if (/\b(transmission|shift\w*|gear\w*|converter)\b/i.test(text)) groups.push("transmission");
  if (/\b(abs|traction|brak\w*|wheel\w*)\b/i.test(text)) groups.push("brakes");
  // Jerking is a symptom, not a diagnosis. Keep all three possibilities visible.
  if (!groups.length || /\b(jerk\w*|fully|everything|whole)\b/i.test(text)) groups.splice(0, groups.length, ...Object.keys(WATCH_GROUPS));
  return { action: "start_sensor_watch", mode: "confirmation_required", label: "Watch supported sensors for 30 minutes", payload: { vehicleId, groups, reason: text.slice(0, 500), durationMinutes: 30 } };
}

function describeWatch(row, now = Date.now()) {
  if (!row) return null;
  const requestedKeys = [...new Set(row.groups.flatMap(group => WATCH_GROUPS[group] || []))];
  const supported = Array.isArray(row.supportedKeys) ? row.supportedKeys.filter(k => requestedKeys.includes(k)) : [];
  const recent = row.acknowledgedAt && now - new Date(row.acknowledgedAt).getTime() < 90_000;
  const status = row.stoppedAt ? "stopped" : new Date(row.expiresAt).getTime() <= now ? "expired"
    : recent ? (supported.length ? "tablet_applied" : "no_supported_signals") : "awaiting_tablet";
  return { requestId: row.requestId, vehicleId: row.vehicleId, groups: row.groups, reason: row.reason,
    expiresAt: row.expiresAt, status, requestedKeys, supportedKeys: supported,
    unavailableKeys: row.acknowledgedAt ? requestedKeys.filter(k => !supported.includes(k)) : [],
    acknowledgedAt: row.acknowledgedAt, limitation: "Polling priority only, not a confirmed diagnosis or continuous live-data guarantee. OEM module access is required for many transmission and ABS signals." };
}

async function saveWatch(prisma, { orgId, vehicleId, userId, groups, reason, durationMinutes = 30 }, now = new Date()) {
  const where = scope(orgId, vehicleId);
  if (!Array.isArray(groups) || !groups.length || groups.some(g => !Object.hasOwn(WATCH_GROUPS, g))) throw new Error("Invalid sensor watch groups");
  if (!Number.isInteger(durationMinutes) || durationMinutes < 5 || durationMinutes > 60) throw new Error("Watch duration must be 5 to 60 minutes");
  const data = { requestId: randomUUID(), groups: [...new Set(groups)], reason: String(reason || "").slice(0, 500),
    requestedBy: userId || null, expiresAt: new Date(now.getTime() + durationMinutes * 60_000),
    stoppedAt: null, acknowledgedAt: null, supportedKeys: [], deviceId: null };
  const row = await prisma.sensorWatch.upsert({ where: { orgId_vehicleId: where }, create: { ...where, ...data }, update: data });
  return describeWatch(row, now.getTime());
}

async function getWatch(prisma, orgId, vehicleId) {
  return describeWatch(await prisma.sensorWatch.findUnique({ where: { orgId_vehicleId: scope(orgId, vehicleId) } }));
}

async function acknowledgeWatch(prisma, device, body, now = new Date()) {
  const where = scope(device.orgId, device.vehicleId);
  const supportedKeys = Array.isArray(body.supportedKeys) ? [...new Set(body.supportedKeys.filter(k => allKeys.has(k)))].slice(0, allKeys.size) : [];
  return prisma.sensorWatch.updateMany({ where: { ...where, requestId: String(body.requestId || ""), stoppedAt: null, expiresAt: { gt: now } },
    data: { acknowledgedAt: now, supportedKeys, deviceId: device.deviceId || null } });
}

module.exports = { WATCH_GROUPS, watchProposal, describeWatch, saveWatch, getWatch, acknowledgeWatch };
