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
const { decodeCode, summarize, driverGuidance } = require("../telematics/diagnostics/dtcCatalog");
const { buildSensorView, SENSORS, GROUPS } = require("../telematics/diagnostics/sensorCatalog");
const { requireOperatorOrDevice: buildOperatorOrDevice, requireDevice } = require("../middleware/deviceAuth");

// Severity → the shape the rest of the platform already speaks.
const ALERT_SEVERITY = { critical: "critical", warning: "warning", info: "info", unknown: "warning" };

function registerDiagnosticsRoutes(app, deps) {
  const {
    requireEmployeeOrCustomerApi,
    sanitizeString,
    nowIso,
    telemetryLatest,
    log = console.log
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
    if (req.customer?.orgId && req.customer.orgId !== orgId) {
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
        key: s.key, label: s.label, unit: s.unit, group: s.group,
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

      const snapshot = telemetryLatest.get(vehicleId) || null;
      // telemetryLatest holds the normalized shape written by the ingest route.
      const normalized = snapshot?.metrics || null;
      const view = buildSensorView(normalized, normalized?.meta || {});

      res.json({
        ok: true,
        vehicleId,
        capturedAt: snapshot?.ts || null,
        stale: snapshot?.ts ? (Date.now() - new Date(snapshot.ts).getTime()) > 120000 : true,
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

      const rawCodes = Array.isArray(req.body?.codes) ? req.body.codes : [];
      if (rawCodes.length > 200) {
        return res.status(400).json({ ok: false, error: "TOO_MANY_CODES", message: "A scan may report at most 200 codes." });
      }

      const decoded = rawCodes.map(decodeCode);
      const summary = summarize(decoded);
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

      // Anything above info reaches the fleet manager without the driver having
      // to report it. A clean scan does not generate noise.
      if (summary.total > 0 && summary.severity !== "info") {
        const worst = decoded
          .filter((d) => d.severity === summary.severity)
          .slice(0, 3)
          .map((d) => `${d.code} — ${d.parameter}`)
          .join("; ");

        const title = summary.driveability === "stop"
          ? `Stop-driving fault on ${vehicleId}`
          : `${summary.criticalCount + summary.warningCount} fault code(s) on ${vehicleId}`;
        const body = `${guidance.headline}. ${worst}${summary.total > 3 ? ` (+${summary.total - 3} more)` : ""}.`;

        await db.insertAlert({
          id: `DIAG_${scanId}`,
          orgId,
          vehicleId,
          type: "diagnostic_scan",
          severity: ALERT_SEVERITY[summary.severity] || "warning",
          explanation: body,
          recommendedChecks: decoded.slice(0, 10).map((d) => `${d.code}: ${d.parameter}`),
          createdAt: scannedAt
        }).catch((err) => log("[DIAG] alert insert failed:", err.message));

        await db.createNotification({
          orgId,
          vehicleId,
          recipientType: "fleet_manager",
          title,
          body,
          severity: ALERT_SEVERITY[summary.severity] || "warning"
        }).catch((err) => log("[DIAG] notification failed:", err.message));

        log("[DIAG] scan", { vehicleId, source, total: summary.total, severity: summary.severity, driveability: summary.driveability });
      }

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
      const scans = await db.listDiagnosticScans(vehicleId, { limit });
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
      const scans = await db.listDiagnosticScans(vehicleId, { limit: 1 });
      const latest = scans[0] || null;
      res.json({
        ok: true,
        vehicleId,
        scan: latest,
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
      const scans = await db.listDiagnosticScans(scope.vehicleId, { limit: 100 });
      const rows = scans.flatMap((scan) => (scan.codes || []).map((code) => ({
        scanId: scan.id,
        vehicleId: scope.vehicleId,
        code: code.code || "",
        description: code.parameter || code.description || "",
        severity: code.severity || scan.severity || "unknown",
        firstSeen: scan.scannedAt,
        lastSeen: scan.scannedAt,
        source: scan.source
      })));
      res.json({ ok: true, data: rows });
    } catch (err) {
      next(err);
    }
  }

  app.get("/api/dtc-history", requireEmployeeOrCustomerApi, handleDtcHistory);
  app.get("/api/vehicles/:vehicleId/dtc-history", requireEmployeeOrCustomerApi, handleDtcHistory);
}

module.exports = { registerDiagnosticsRoutes };
