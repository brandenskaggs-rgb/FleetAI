const { sanitizeObdFaultRead, faultReadCodes } = require("../telematics/diagnostics/obdFaultRead");

async function loadPersistedFaultEvidence(prisma, orgId, vehicleId, now = new Date()) {
  const scan = await prisma.diagnosticScan.findFirst({
    where: { orgId, vehicleId, vehicle: { orgId }, scannedAt: { lte: new Date(now.getTime() + 5000) } },
    orderBy: { scannedAt: "desc" },
    select: { id: true, orgId: true, vehicleId: true, scannedAt: true, codes: true, summary: true }
  });
  if (!scan || scan.orgId !== orgId || scan.vehicleId !== vehicleId) return null;
  const read = sanitizeObdFaultRead(scan.summary?.obdFaultRead);
  return { obdFaultRead: read, dtcCapturedAt: read?.capturedAt || scan.scannedAt,
    dtcScanStatus: "read", diagnosticScanId: scan.id,
    activeDTCs: Array.isArray(scan.codes) ? scan.codes.filter(c => c?.codeStatus !== "permanent").map(c => typeof c === "string" ? c : c.code) : [] };
}

function selectPredictionFaultEvidence(samples, persisted, now = Date.now()) {
  const candidates = [...samples.map(s => s.raw), persisted].filter(Boolean).flatMap(raw => {
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
  const codes = read ? faultReadCodes(read).filter(c => c.codeStatus !== "permanent").map(c => c.code) : raw.activeDTCs;
  return { codes: recent ? [...new Set(codes.filter(c => typeof c === "string" && /^[PCBU][0-3][0-9A-F]{3}$/i.test(c)).map(c => c.toUpperCase()))] : [],
    status: recent ? "recent_report" : "historical", capturedAt: new Date(timestamp).toISOString(),
    completeness: read?.status || "legacy_read", diagnosticScanId: raw.diagnosticScanId || null,
    milOn: read?.milOn ?? null };
}

module.exports = { loadPersistedFaultEvidence, selectPredictionFaultEvidence };
