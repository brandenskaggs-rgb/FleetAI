const COVERAGE = "Generic OBD engine/emissions only. TPMS and ABS module coverage is not established.";
function sanitizeObdFaultRead(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const captured = typeof input.capturedAt === "string" ? Date.parse(input.capturedAt) : NaN;
  if (!Number.isFinite(captured)) return null;
  const result = { capturedAt: new Date(captured).toISOString(), coverage: COVERAGE };
  for (const mode of ["confirmed", "pending", "permanent"]) {
    const codes = input[mode];
    result[mode] = Array.isArray(codes) && codes.length <= 255 && codes.every(code => typeof code === "string" && /^[PCBU][0-3][0-9a-f]{3}$/i.test(code))
      ? [...new Set(codes.map(code => code.toUpperCase()))].sort() : null;
  }
  result.milOn = typeof input.milOn === "boolean" ? input.milOn : null;
  result.reportedCodeCount = Number.isInteger(input.reportedCodeCount) && input.reportedCodeCount >= 0 && input.reportedCodeCount <= 127 ? input.reportedCodeCount : null;
  const inconsistent = result.confirmed !== null && ((result.milOn === true && result.confirmed.length === 0)
    || (result.reportedCodeCount !== null && result.reportedCodeCount > result.confirmed.length));
  result.status = inconsistent ? "inconsistent" : [result.confirmed, result.pending, result.permanent, result.milOn, result.reportedCodeCount].some(value => value === null) ? "partial" : "read";
  return result;
}

function faultReadCodes(read) {
  return ["confirmed", "pending", "permanent"].flatMap(codeStatus => (read?.[codeStatus] || []).map(code => ({ code, codeStatus })));
}

function diagnosticReadStatus(scan, now = Date.now()) {
  const read = sanitizeObdFaultRead(scan?.summary?.obdFaultRead);
  const capturedAt = read?.capturedAt || scan?.scannedAt || null;
  const age = capturedAt == null ? NaN : now - new Date(capturedAt).getTime();
  const freshness = !Number.isFinite(age) ? "not_read" : age < -5000 ? "invalid_time" : age > 120000 ? "historical" : "recent";
  return { freshness, capturedAt, completeness: read?.status || (scan ? "legacy_read" : "not_read"),
    milOn: read?.milOn ?? null, reportedCodeCount: read?.reportedCodeCount ?? null,
    modes: Object.fromEntries(["confirmed", "pending", "permanent"].map(mode => [mode, read?.[mode] == null ? "not_verified" : "read"])),
    coverage: read?.coverage || "Only uploaded codes are shown. Complete module coverage, including TPMS/ABS, is not verified.",
    message: read?.status === "inconsistent" ? "Check-engine status and returned codes disagree. Do not treat this as a clean scan."
      : read?.status === "partial" ? "Some diagnostic requests had no valid response. Missing results do not mean no faults."
        : scan ? "These are recorded diagnostic results, not proof that the vehicle has no faults." : "No verified fault-code read is available. A warning light still needs investigation." };
}
module.exports = { COVERAGE, sanitizeObdFaultRead, faultReadCodes, diagnosticReadStatus };
