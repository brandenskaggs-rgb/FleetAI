const { randomUUID } = require("node:crypto");
const { WATCH_GROUPS, describeWatch } = require("./sensorWatchService");
const { SENSORS } = require("../telematics/diagnostics/sensorCatalog");

const signals = new Map(SENSORS.flatMap(s => [[s.key, s], [s.path.split(".").pop(), s]]));
const messages = {
  idle: "No sensor scan has been requested for this vehicle.",
  awaiting_tablet: "Requested. Waiting for the paired OBD tablet to check in.",
  no_supported_signals: "The tablet checked in but reported no supported sensors in this selection.",
  waiting_for_readings: "The tablet acknowledged the request. No matching sensor readings have arrived yet.",
  receiving: "Receiving fresh sensor readings from the paired tablet.",
  interrupted: "No fresh readings. Times below are the last measurements, not current values.",
  stopped: "The sensor watch was stopped.",
  expired: "The capture window ended."
};

function proposeScan(vehicleId) {
  return { id: randomUUID(), action: "start_sensor_watch", mode: "confirmation_required",
    label: "Start 5-minute read-only scan", payload: { vehicleId, groups: Object.keys(WATCH_GROUPS),
      durationMinutes: 5, reason: "Live diagnostic scan" } };
}

async function scanSession(prisma, orgId, vehicleId, now = Date.now()) {
  if (!orgId || !vehicleId) throw new Error("Scan scope required");
  const row = await prisma.sensorWatch.findUnique({ where: { orgId_vehicleId: { orgId, vehicleId } } });
  if (!row) return { status: "idle", message: messages.idle, readings: [] };
  const watch = describeWatch(row, now);
  const start = +new Date(row.createdAt);
  const end = Math.min(now, +new Date(row.expiresAt), row.stoppedAt ? +new Date(row.stoppedAt) : Infinity);
  const latest = new Map();
  if (row.deviceId && row.acknowledgedAt && end >= start) {
    const samples = await prisma.telemetrySample.findMany({
      where: { orgId, vehicleId, ts: { gte: new Date(start), lte: new Date(end) },
        raw: { path: ["sensorWatchRequestId"], equals: row.requestId } },
      orderBy: { ts: "desc" }, take: 64, select: { ts: true, raw: true }
    });
    for (const { raw, ts } of samples) {
      if (raw?.watchDeviceId !== row.deviceId || raw.sensorWatchRequestId !== row.requestId) continue;
      for (const key of Object.keys(raw.watchReadings || {})) {
        if (!(row.reason === "Live diagnostic scan" && signals.has(key)) && !watch.supportedKeys.includes(key)) continue;
        const read = raw.watchReadings?.[key];
        if (!Number.isFinite(read?.value) || !Number.isFinite(read.at) || read.at < start || read.at > end ||
            read.at > +new Date(ts) || read.at <= (latest.get(key)?.at ?? -Infinity)) continue;
        const sensor = signals.get(key);
        latest.set(key, { key, label: sensor?.label || key, unit: sensor?.unit || "", at: read.at, value: read.value,
          fresh: now - read.at <= 15000 });
      }
    }
  }
  const readings = [...latest.values()];
  let status = watch.status;
  if (!["expired", "stopped"].includes(status)) {
    status = readings.some(r => r.fresh) ? "receiving" : readings.length ? "interrupted"
      : status === "tablet_applied" ? "waiting_for_readings" : status;
  }
  return { status, message: messages[status], requestId: row.requestId, expiresAt: row.expiresAt,
    acknowledgedAt: row.acknowledgedAt, supportedKeys: watch.supportedKeys, unavailableKeys: watch.unavailableKeys,
    readings: readings.map(r => ({ ...r, fresh: status === "receiving" && r.fresh })) };
}

module.exports = { scanSession, proposeScan };
