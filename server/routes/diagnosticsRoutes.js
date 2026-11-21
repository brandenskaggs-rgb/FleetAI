/**
 * On-board diagnostics: sensor visibility and fault-code scanning.
 *
 * Two audiences, one source of truth:
 *   Driver   — runs a scan from the tablet, sees plain-English faults and an
 *              unambiguous instruction (keep driving / get to a shop / stop).
 *   Manager  — every scan is persisted, and anything above "info" raises an
 *              Alert plus a fleet-manager Notification without the driver
 *              having to remember to phone it in.
 *
 * Worth noting from the competitive research: Motive does not surface fault
 * codes in its driver app at all — they are visible only on the fleet
 * dashboard. Putting the decoded fault in the cab, with a driveability verdict,
 * is the point of this module.
 *
 * Device requests are authenticated by the pairing session (see
 * middleware/deviceAuth.js) and the vehicle is taken FROM THE PAIRING, so a
 * tablet can only ever scan and report for the truck it is paired to.
 */

const db = require("../db");
const { scopedSnapshot } = require("../lib/snapshotScope");
const { decodeCode, summarize, driverGuidance } = require("../telematics/diagnostics/dtcCatalog");
const { buildSensorView, SENSORS, GROUPS } = require("../telematics/diagnostics/sensorCatalog");
const { requireOperatorOrDevice: buildOperatorOrDevice, requireDevice } = require("../middleware/deviceAuth");
const { diagnosticReadStatus } = require("../telematics/diagnostics/obdFaultRead");
const { describeCodes } = require("../services/diagnosticIncident");
const { makeScanReport } = require("../services/scanEvidenceReport");

function registerDiagnosticsRoutes(app, deps) {
  const {
    requireEmployeeOrCustomerApi,
    sanitizeString,
    nowIso,
    telemetryLatest
  } = deps;

  const requireOperatorOrDevice = buildOperatorOrDevice(requireEmployeeOrCustomerApi);

  // Resolve which vehicle a request may act on. A device is pinned to its
  // pairing; an operator may name one.
  function resolveVehicleId(req) {
    if (req.device) return req.device.vehicleId;
    return sanitizeString(req.params?.vehicleId || req.query.vehicleId || req.body?.vehicleId || "", 80);
  }

  async function authorizeVehicle(req, res) {
    const vehicleId = resolveVehicleId(req);
    if (!vehicleId) {
      res.status(400).json({ ok: false, error: "vehicleId required" });
      return null;
    }
    const orgId = req.device?.orgId || await db.getVehicleOrgId(vehicleId, "").catch(() => "");
    if (!orgId) {
      res.status(404).json({ ok: false, error: "vehicle_not_found" });
      return null;
    }
    if (req.customer && req.customer.orgId !== orgId) {
      res.status(403).json({ ok: false, error: "cross_org_vehicle_denied" });
      return null;
    }
    return { vehicleId, orgId };
  }

  // ── Sensor catalog ─────────────────────────────────────────────────────────
  // Static description of every signal the platform can read. Useful on its own
  // (the tablet renders the full list even before a snapshot arrives) and it
  // documents the CAN vocabulary in one place.
  app.get("/api/diagnostics/sensors/catalog", requireOperatorOrDevice, (req, res) => {
    res.json({
      ok: true,
      groups: GROUPS,
      sensors: SENSORS.map((s) => ({
        key: s.key, path: s.path, label: s.label, unit: s.unit, group: s.group,
        spn: s.spn, pid: s.pid, normal: s.normal, boolean: Boolean(s.boolean)
      }))
    });
  });

  // ── Live sensor view ───────────────────────────────────────────────────────
  // Every signal with its current value and nominal/watch/critical state.
  // Signals the bus does not expose are returned marked unsupported rather than
  // omitted — "this truck cannot report DPF soot" is information the driver
  // needs, and a silently shorter list hides it.
  app.get("/api/diagnostics/sensors", requireOperatorOrDevice, async (req, res, next) => {
    try {
      const scope = await authorizeVehicle(req, res);
      if (!scope) return;
      const { vehicleId } = scope;

      const snapshot = scopedSnapshot(telemetryLatest.get(vehicleId), scope.orgId, vehicleId);
      // telemetryLatest holds the normalized shape written by the ingest route.
      const normalized = snapshot?.metrics || null;
      const capturedAt = snapshot?.lastObdPacketAt || (snapshot?.busDataActive ? snapshot.ts : null);
      const now = Date.now();
      const packetAgeMs = capturedAt ? now - new Date(capturedAt).getTime() : null;
      const elapsedMs = snapshot?.ts ? now - new Date(snapshot.ts).getTime() : NaN;
      const connectionLive = snapshot?.busDataActive === true && Number.isFinite(packetAgeMs)
        && packetAgeMs >= -5000 && packetAgeMs <= 15_000
        && Number.isFinite(elapsedMs) && elapsedMs >= -5000;
      const view = buildSensorView(normalized, snapshot?.deviceDiagnostics || normalized?.meta || {}, { elapsedMs, connectionLive });

      res.json({
        ok: true,
        vehicleId,
        capturedAt,
        stale: !connectionLive,
        connectionState: snapshot?.connectionState || "offline",
        busDataActive: connectionLive,
        ...view
      });
    } catch (err) {
      next(err);
    }
  });

  // ── Run / submit a scan ────────────────────────────────────────────────────
  // The tablet reads codes off the bus and posts them here. Decoding happens
  // server-side on purpose: the catalog can be corrected or extended without
  // shipping a new tablet build, and the manager's view and the driver's view
  // are guaranteed to agree because they are the same computation.
  app.post("/api/diagnostics/scan", requireOperatorOrDevice, async (req, res, next) => {
    try {
      const scope = await authorizeVehicle(req, res);
      if (!scope) return;
      const { vehicleId, orgId } = scope;

      if (!Array.isArray(req.body?.codes)) {
        return res.status(400).json({ ok: false, error: "CODES_REQUIRED", message: "An explicit code-read result is required. Missing data is not a clean scan." });
      }
      const rawCodes = req.body.codes;
      if (rawCodes.length > 200) {
        return res.status(400).json({ ok: false, error: "TOO_MANY_CODES", message: "A scan may report at most 200 codes." });
      }

      const decoded = rawCodes.map(item => {
        const code = decodeCode(item);
        return ["pending","confirmed","permanent"].includes(item?.codeStatus) ? {...code,codeStatus:item.codeStatus} : code;
      });
      const summary = summarize(decoded.filter(c=>c.codeStatus!=="permanent"));
      const guidance = driverGuidance(summary);
      const scannedAt = nowIso();
      const source = req.device ? "device" : "operator";

      const driverId = req.device?.driverId || sanitizeString(req.body?.driverId || "", 80) || null;

      // Persist the scan itself so a manager can see history, not just the
      // latest state, and so a clean scan is recorded as evidence too.
      const scanId = await db.insertDiagnosticScan({
        vehicleId, orgId, driverId,
        deviceId: req.device?.deviceId || null,
        source,
        scannedAt,
        codes: decoded,
        summary
      });


      res.json({ ok: true, scanId, vehicleId, scannedAt, codes: decoded, summary, guidance, reportedToFleet: summary.total > 0 && summary.severity !== "info" });
    } catch (err) {
      next(err);
    }
  });

  // ── Scan history ───────────────────────────────────────────────────────────
  app.get("/api/diagnostics/scans", requireOperatorOrDevice, async (req, res, next) => {
    try {
      const scope = await authorizeVehicle(req, res);
      if (!scope) return;
      const { vehicleId } = scope;
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
      const scans = await db.listDiagnosticScans(vehicleId, { limit, orgId: scope.orgId });
      res.json({ ok: true, vehicleId, scans });
    } catch (err) {
      next(err);
    }
  });

  // Latest scan only — what the tablet shows on open.
  app.get("/api/diagnostics/latest", requireOperatorOrDevice, async (req, res, next) => {
    try {
      const scope = await authorizeVehicle(req, res);
      if (!scope) return;
      const { vehicleId } = scope;
      const scans = await db.listDiagnosticScans(vehicleId, { limit: 1, orgId: scope.orgId });
      const latest = scans[0] || null;
      const [lastPositive] = await db.listDiagnosticScans(vehicleId, { limit: 1, orgId: scope.orgId, positiveOnly: true });
      res.json({
        ok: true,
        vehicleId,
        scan: latest,
        diagnosticStatus: diagnosticReadStatus(latest),
        lastPositiveScan: lastPositive || null,
        guidance: latest ? driverGuidance(latest.summary || {}) : null
      });
    } catch (err) {
      next(err);
    }
  });

  // ── Clear codes ────────────────────────────────────────────────────────────
  // Records the intent to clear; it does NOT write to the vehicle bus. Clearing
  // a live ECU is a physical act with real consequences (it erases readiness
  // monitors and can mask an intermittent fault), so it stays a logged,
  // operator-authorised event rather than something a tablet can do silently.
  app.post("/api/diagnostics/clear", requireEmployeeOrCustomerApi, async (req, res, next) => {
    try {
      const scope = await authorizeVehicle(req, res);
      if (!scope) return;
      const { vehicleId, orgId } = scope;
      await db.logAudit({
        orgId,
        event: "DIAGNOSTIC_CODES_CLEAR_REQUESTED",
        detail: `${vehicleId} by ${req.customer?.userId || req.employee?.userId || "operator"}`
      }).catch(() => {});
      res.json({
        ok: true,
        vehicleId,
        cleared: false,
        message: "Clear request logged. Codes must be cleared with a shop tool — clearing from here would erase emissions readiness monitors and can hide an intermittent fault."
      });
    } catch (err) {
      next(err);
    }
  });

  async function handleDtcHistory(req, res, next) {
    try {
      const scope = await authorizeVehicle(req, res);
      if (!scope) return;
      const [latest] = await db.listDiagnosticScans(scope.vehicleId, { limit: 1, orgId: scope.orgId });
      const scans = await db.listDiagnosticScans(scope.vehicleId, { limit: 100, orgId: scope.orgId, positiveOnly: true });
      const rows = scans.flatMap((scan) => describeCodes(scan.codes).map((code) => ({
        scanId: scan.id,
        vehicleId: scope.vehicleId,
        code: code.code || "",
        codeStatus: code.codeStatus || "recorded",
        description: code.parameter || code.description || "",
        severity: code.severity || scan.severity || "unknown",
        firstSeen: scan.scannedAt,
        lastSeen: scan.scannedAt,
        storedAt: scan.createdAt,
        source: scan.source
      })));
      res.json({ ok: true, data: rows, diagnosticStatus: diagnosticReadStatus(latest), latestPositiveAt: scans[0]?.scannedAt || null });
    } catch (err) {
      next(err);
    }
  }

  app.get("/api/dtc-history", requireEmployeeOrCustomerApi, handleDtcHistory);
  app.get("/api/vehicles/:vehicleId/diagnostic-report.pdf", requireEmployeeOrCustomerApi, async (req,res,next) => {
    try {
      const scope = await authorizeVehicle(req,res);
      if (!scope) return;
      const stamp = new Date(String(req.query.at || ""));
      if (!Number.isFinite(stamp.getTime())) return res.status(400).json({error:"scan_time_required"});
      const ref = typeof req.query.ref==="string" && /^[A-Za-z0-9_-]{1,120}$/.test(req.query.ref) ? req.query.ref : null;
      const pdf = await makeScanReport(db.getPrisma(), scope, stamp, ref, req.query.kind==="model");
      if (!pdf) return res.status(404).json({error:"scan_not_found"});
      res.set("Cache-Control","private, no-store").type("application/pdf").send(pdf);
    } catch (e) { next(e); }
  });
  app.get("/api/vehicles/:vehicleId/dtc-history", requireEmployeeOrCustomerApi, handleDtcHistory);
}

module.exports = { registerDiagnosticsRoutes };
