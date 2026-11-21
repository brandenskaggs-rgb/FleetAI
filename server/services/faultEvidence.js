const { sanitizeObdFaultRead } = require("../telematics/diagnostics/obdFaultRead");

async function loadPersistedFaultEvidence(prisma, orgId, vehicleId, now = new Date()) {
  const scan = await prisma.diagnosticScan.findFirst({
    where: { orgId, vehicleId, vehicle: { orgId }, scannedAt: { lte: new Date(now.getTime() + 5000) } },
    orderBy: { scannedAt: "desc" },
    select: { id: true, orgId: true, vehicleId: true, scannedAt: true, codes: true, summary: true }
  });
  if (!scan || scan.orgId !== orgId || scan.vehicleId !== vehicleId) return null;
  const read = sanitizeObdFaultRead(scan.summary?.obdFaultRead);
  const latestPositive = scan.codes?.length ? scan : await prisma.diagnosticScan.findFirst({
    where: {orgId,vehicleId,vehicle:{orgId},scannedAt:{lte:scan.scannedAt},codeCount:{gt:0}},
    orderBy:{scannedAt:"desc"},select:{id:true,orgId:true,vehicleId:true,scannedAt:true,codes:true,summary:true}
  });
  const lastKnown = latestPositive?.orgId === orgId && latestPositive?.vehicleId === vehicleId && latestPositive.codes?.length
    ? {scanId:latestPositive.id,capturedAt:latestPositive.scannedAt,codes:latestPositive.codes} : null;
  const priorModes = [];
  if (read && read.status !== "read" && now.getTime()-Date.parse(read.capturedAt)<=120000) {
    for (const mode of ["confirmed","pending"]) {
      if (read[mode] !== null) continue;
      const prior = await prisma.diagnosticScan.findFirst({
        where:{orgId,vehicleId,vehicle:{orgId},scannedAt:{gte:new Date(+now-120000),lte:scan.scannedAt},
          summary:{path:["obdFaultRead",mode],not:require("@prisma/client").Prisma.AnyNull}},
        orderBy:{scannedAt:"desc"},select:{orgId:true,vehicleId:true,summary:true}
      });
      const verified=sanitizeObdFaultRead(prior?.summary?.obdFaultRead);
      if(prior?.orgId===orgId && prior.vehicleId===vehicleId && verified?.[mode]!=null)
        priorModes.push({obdFaultRead:{capturedAt:verified.capturedAt,[mode]:verified[mode]},dtcScanStatus:"read"});
    }
  }
  return { obdFaultRead: read, dtcCapturedAt: read?.capturedAt || scan.scannedAt,
    dtcScanStatus: "read", diagnosticScanId: scan.id, lastKnown, priorModes,
    activeDTCs: Array.isArray(scan.codes) ? scan.codes.filter(c => c?.codeStatus !== "permanent").map(c => typeof c === "string" ? c : c.code) : [] };
}

function selectPredictionFaultEvidence(samples, persisted, now = Date.now()) {
  const candidates = [...samples.map(s => s.raw), ...(persisted?.priorModes || []), persisted].filter(Boolean).flatMap(raw => {
    const read = sanitizeObdFaultRead(raw.obdFaultRead);
    const capturedAt = read?.capturedAt || raw.dtcCapturedAt;
    const timestamp = capturedAt == null ? NaN : new Date(capturedAt).getTime();
    if (!Number.isFinite(timestamp) || timestamp > now + 5000 ||
      (!read && (!Array.isArray(raw.activeDTCs) || !["read", "stale"].includes(raw.dtcScanStatus)))) return [];
    return [{ raw, read, timestamp }];
  }).sort((a, b) => b.timestamp - a.timestamp || Number(!!b.read) - Number(!!a.read));
  const selected = candidates[0];
  if (!selected) return { codes: [], status: "not_read", capturedAt: null, completeness: "not_read" };
  const { raw, read, timestamp } = selected;
  const recent = raw.dtcScanStatus !== "stale" && now - timestamp <= 120000;
  // Each OBD mode is a separate request. A missing response is not a negative
  // result. A verified empty array supersedes older positives for that mode.
  const modeEvidence = {};
  if (read) for (const mode of ["pending", "confirmed"]) {
    const match = candidates.find(c => c.read?.[mode] != null &&
      !(c.read.status === "inconsistent" && !c.read[mode].length) &&
      c.raw.dtcScanStatus !== "stale" && now-c.timestamp <= 120000);
    if (match) modeEvidence[mode] = {codes:match.read[mode],capturedAt:new Date(match.timestamp).toISOString()};
  }
  const codes = read ? Object.values(modeEvidence).flatMap(item=>item.codes) : raw.activeDTCs;
  return { codes: recent ? [...new Set(codes.filter(c => typeof c === "string" && /^[PCBU][0-3][0-9A-F]{3}$/i.test(c)).map(c => c.toUpperCase()))] : [],
    status: recent ? "recent_report" : "historical", capturedAt: new Date(timestamp).toISOString(),
    completeness: read?.status || "legacy_read", diagnosticScanId: raw.diagnosticScanId || null,
    modeEvidence, lastKnown:persisted?.lastKnown || null, milOn: read?.milOn ?? null };
}

module.exports = { loadPersistedFaultEvidence, selectPredictionFaultEvidence };
