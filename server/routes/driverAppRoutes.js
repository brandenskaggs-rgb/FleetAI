/**
 * Driver-app API surface.
 *
 * The Android ELD calls ten endpoints. Three did not exist anywhere on the
 * server (/api/drivers/me, /api/vehicles/select, /api/logs/hos) and would have
 * 404'd on a real device, and /api/vehicles existed but answered in a shape the
 * app's Moshi models cannot parse. This module closes both gaps.
 *
 * Everything here is device-authenticated: the tablet presents the session
 * token issued when it claimed its pairing, and the vehicle/driver/org come
 * FROM THE PAIRING rather than from the request. A tablet can therefore only
 * ever read and write for the truck it is physically paired to, which is the
 * property that makes a multi-tenant ELD safe.
 *
 * Response shapes below match driver_app/.../network/NetworkModels.kt exactly.
 * Moshi is strict about missing non-nullable fields, so a shape drift here
 * surfaces as a parse exception in the cab rather than a clear error — the
 * contract is asserted by tests/driver-app-contract.test.js.
 */

const db = require("../db");
const { requireDevice, attachDevice } = require("../middleware/deviceAuth");

function registerDriverAppRoutes(app, deps) {
  const { sanitizeString, nowIso, log = console.log, eldService = null } = deps;

  // ── GET /api/drivers/me ────────────────────────────────────────────────────
  // DriverProfileResponse(tenantId, driverId, driverName) — all non-null.
  app.get("/api/drivers/me", requireDevice, async (req, res, next) => {
    try {
      const candidate = req.device.driverId ? await db.getDriverByDriverId(req.device.driverId) : null;
      const driver = candidate && candidate.orgId === req.device.orgId ? candidate : null;
      const name = driver
        ? `${driver.firstName || ""} ${driver.lastName || ""}`.trim()
        : "";
      res.json({
        tenantId: req.device.orgId || "",
        driverId: req.device.driverId || "",
        // Never null: Moshi's non-null String would throw on the device.
        driverName: name || req.device.driverId || "Driver"
      });
    } catch (err) {
      next(err);
    }
  });

  // ── GET /api/vehicles (device) ─────────────────────────────────────────────
  // Registered BEFORE the operator handler in fleetOpsRoutes. A device token
  // gets the wrapped, field-mapped shape its models expect; anything else
  // falls through via next() to the operator endpoint, whose bare-array
  // response the dashboard already depends on.
  //
  // The app's VehicleDto is (id, unitNumber, vin, make, model) — all non-null —
  // while the database row is (vehicleId, unitName, vin, make, model) with
  // nullables. Mapping and null-coalescing happen here rather than being left
  // to blow up in Moshi.
  app.get("/api/vehicles", attachDevice, async (req, res, next) => {
    if (!req.device) return next();
    try {
      const orgId = req.device.orgId || undefined;
      const vehicles = await db.listVehicles({ orgId });
      res.json({
        vehicles: vehicles.map((v) => ({
          id: v.vehicleId || v.id || "",
          unitNumber: v.unitName || v.vehicleId || "",
          vin: v.vin || "",
          make: v.make || "",
          model: v.model || ""
        }))
      });
    } catch (err) {
      next(err);
    }
  });

  // ── POST /api/vehicles/select ──────────────────────────────────────────────
  // A driver confirming which truck they are in. The pairing already binds the
  // device to a vehicle, so this validates agreement rather than reassigning:
  // silently re-pointing a device at another truck from an unauthenticated body
  // field would let one tablet report as any vehicle in the fleet.
  app.post("/api/vehicles/select", requireDevice, async (req, res, next) => {
    try {
      const requested = sanitizeString(req.body?.vehicleId || "", 80);
      if (!requested) {
        return res.status(400).json({ success: false, error: "vehicleId required" });
      }
      if (requested !== req.device.vehicleId) {
        return res.status(403).json({
          success: false,
          error: "VEHICLE_MISMATCH",
          message: "This device is paired to a different vehicle. Re-pair to change trucks."
        });
      }
      await db.logAudit({
        orgId: req.device.orgId,
        event: "DRIVER_VEHICLE_CONFIRMED",
        detail: `${requested} by ${req.device.driverId || "unknown"} on ${req.device.deviceId || "device"}`
      }).catch(() => {});
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  });

  // ── Hours of Service ───────────────────────────────────────────────────────
  // Duty-status events are the legally significant part of an ELD. They are
  // stored as Events (type HOS_STATUS) so they inherit the existing org
  // scoping and retention rather than needing a parallel store.
  app.post("/api/logs/hos", requireDevice, async (req, res, next) => {
    try {
      const b = req.body || {};
      const rawDutyStatus = sanitizeString(b.dutyStatus || "", 32).toUpperCase();
      const dutyStatus = rawDutyStatus === "OFF"
        ? "OFF_DUTY"
        : rawDutyStatus === "ON" ? "ON_DUTY" : rawDutyStatus;
      // FMCSA duty statuses. An unrecognised value is rejected rather than
      // stored, because an un-decodable status in a log is a compliance defect.
      const VALID = ["OFF_DUTY", "SLEEPER", "DRIVING", "ON_DUTY", "YARD_MOVE", "PERSONAL_CONVEYANCE"];
      if (!VALID.includes(dutyStatus)) {
        return res.status(400).json({
          success: false,
          error: "INVALID_DUTY_STATUS",
          message: `dutyStatus must be one of: ${VALID.join(", ")}`
        });
      }
      if (eldService) {
        const context = await eldService.getDeviceContext(req.device);
        if (context.state?.enabled) {
          if (["YARD_MOVE", "PERSONAL_CONVEYANCE"].includes(dutyStatus)) {
            return res.status(409).json({
              success: false,
              error: "USE_ELD_SPECIAL_DRIVING_ENDPOINT",
              message: "Special driving categories must be started through the ELD special-driving workflow."
            });
          }
          const event = await eldService.createDutyStatus(req.device, {
            dutyStatus,
            occurredAt: b.startTime || nowIso(),
            annotation: b.notes || "",
            locationDescription: b.locationDescription || "",
            totalVehicleMiles: b.totalVehicleMiles,
            totalEngineHours: b.totalEngineHours,
            latitude: b.latitude,
            longitude: b.longitude
          });
          return res.json({ success: true, eventId: event.id, sequenceId: event.sequenceId });
        }
      }
      await db.insertEvent({
        orgId: req.device.orgId,
        vehicleId: req.device.vehicleId,
        type: "HOS_STATUS",
        severity: "info",
        payload: {
          driverId: req.device.driverId,
          deviceId: req.device.deviceId,
          date: sanitizeString(b.date || "", 32),
          startTime: sanitizeString(b.startTime || "", 32),
          endTime: sanitizeString(b.endTime || "", 32),
          dutyStatus,
          notes: sanitizeString(b.notes || "", 500)
        },
        createdAt: nowIso()
      });
      log("[HOS]", { vehicleId: req.device.vehicleId, driverId: req.device.driverId, dutyStatus });
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  });

  // HosLogResponse(events: [HosLogEventDto(status, notes, timestamp)])
  app.get("/api/logs/hos", requireDevice, async (req, res, next) => {
    try {
      const date = sanitizeString(req.query.date || "", 32);
      if (eldService) {
        const context = await eldService.getDeviceContext(req.device);
        if (context.state?.enabled) {
          const events = await eldService.listRecords(req.device, { limit: 5000 });
          return res.json({
            events: events
              .filter((event) => event.eventType === 1 && (!date || event.eventDate === date.replaceAll("-", "").slice(2)))
              .map((event) => ({
                id: event.id,
                sequenceId: event.sequenceId,
                status: ({ 1: "OFF_DUTY", 2: "SLEEPER", 3: "DRIVING", 4: "ON_DUTY" })[event.eventCode] || "",
                notes: event.annotation || "",
                timestamp: event.occurredAt,
                recordStatus: event.recordStatus,
                recordOrigin: event.recordOrigin,
                certified: false
              }))
          });
        }
      }
      const events = await db.listEventsForVehicle(req.device.vehicleId, {
        type: "HOS_STATUS",
        limit: 200
      });
      const mine = events.filter((e) => {
        const p = e.payload || {};
        if (req.device.driverId && p.driverId && p.driverId !== req.device.driverId) return false;
        return !date || p.date === date;
      });
      res.json({
        events: mine.map((e) => ({
          status: (e.payload && e.payload.dutyStatus) || "",
          notes: (e.payload && e.payload.notes) || "",
          timestamp: e.createdAt || ""
        }))
      });
    } catch (err) {
      next(err);
    }
  });

  // ── GET /api/vehicle/dtcs ──────────────────────────────────────────────────
  // Registered before server.js's stub, which unconditionally answered
  // { dtcs: [] } — so the app's diagnostics screen was permanently empty even
  // with active faults. Serves the decoded codes from the latest scan.
  app.get("/api/vehicle/dtcs", attachDevice, async (req, res, next) => {
    if (!req.device) return next();
    try {
      const scans = await db.listDiagnosticScans(req.device.vehicleId, { limit: 1 });
      const codes = (scans[0] && scans[0].codes) || [];
      res.json({
        dtcs: codes.map((c) => ({
          code: c.code || "",
          description: c.parameter || "",
          severity: c.severity || "unknown"
        }))
      });
    } catch (err) {
      next(err);
    }
  });
}

module.exports = { registerDriverAppRoutes };
