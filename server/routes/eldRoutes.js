"use strict";

const db = require("../db");
const { attachDevice, requireDevice } = require("../middleware/deviceAuth");
const { LOGIN_CODE } = require("../eld/constants");
const { buildEldOutputFile } = require("../eld/outputFile");

function pemFromEnv(value) {
  return String(value || "").replace(/\\n/g, "\n").trim();
}

function registerEldRoutes(app, deps) {
  const { eldService, requireEmployeeOrCustomerApi, requireSuperAdmin } = deps;

  function operatorOrgId(req) {
    return req.customer?.orgId || req.employee?.orgId || req.user?.orgId || req.session?.orgId || "";
  }

  function requireOperator(req, res, next) {
    return requireEmployeeOrCustomerApi(req, res, next);
  }

  function requireOperatorAdmin(req, res, next) {
    return requireOperator(req, res, () => {
      const role = String(req.customer?.role || req.employee?.role || "").toUpperCase();
      if (!["ORG_ADMIN", "CUSTOMER_ADMIN", "ADMIN", "SUPER_ADMIN"].includes(role)) {
        return res.status(403).json({ ok: false, error: "ELD_ADMIN_REQUIRED" });
      }
      return next();
    });
  }

  app.get("/api/eld/readiness", requireOperator, async (req, res, next) => {
    try {
      const orgId = operatorOrgId(req);
      if (!orgId) return res.status(403).json({ ok: false, error: "ORG_SCOPE_REQUIRED" });
      res.json({ ok: true, ...(await eldService.readiness(orgId)) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/eld/carrier-config", requireOperator, async (req, res, next) => {
    try {
      const orgId = operatorOrgId(req);
      if (!orgId) return res.status(403).json({ ok: false, error: "ORG_SCOPE_REQUIRED" });
      const config = await eldService.getCarrierConfig(orgId);
      res.json({ ok: true, configured: Boolean(config), config });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/eld/carrier-config", requireOperatorAdmin, async (req, res, next) => {
    try {
      const orgId = operatorOrgId(req);
      if (!orgId) return res.status(403).json({ ok: false, error: "ORG_SCOPE_REQUIRED" });
      const config = await eldService.configureCarrier(orgId, req.body || {});
      res.json({ ok: true, config });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/eld/drivers/:driverId/config", requireOperatorAdmin, async (req, res, next) => {
    try {
      const orgId = operatorOrgId(req);
      if (!orgId) return res.status(403).json({ ok: false, error: "ORG_SCOPE_REQUIRED" });
      const driver = await eldService.configureDriver(orgId, req.params.driverId, req.body || {});
      res.json({
        ok: true,
        driver: {
          driverId: driver.driverId,
          eldUsername: driver.eldUsername,
          licenseState: driver.licenseState,
          eldExempt: driver.eldExempt
        }
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/admin/eld/provider-config/:orgId", requireSuperAdmin, async (req, res, next) => {
    try {
      const config = await eldService.configureProviderIdentity(String(req.params.orgId || ""), req.body || {});
      res.json({ ok: true, config });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/eld/devices/:deviceId/enable", requireOperatorAdmin, async (req, res, next) => {
    try {
      const orgId = operatorOrgId(req);
      const pairing = await db.getPrisma().pairing.findFirst({
        where: {
          orgId,
          deviceId: String(req.params.deviceId || ""),
          status: { in: ["claimed", "active"] }
        },
        orderBy: { claimedAt: "desc" }
      });
      if (!pairing?.deviceId || !pairing.vehicleId) {
        return res.status(404).json({ ok: false, error: "PAIRED_DEVICE_NOT_FOUND" });
      }
      const state = await eldService.enableDevice({
        pairingId: pairing.id,
        deviceId: pairing.deviceId,
        vehicleId: pairing.vehicleId,
        driverId: pairing.driverId,
        orgId: pairing.orgId
      }, req.body?.enabled !== false);
      res.json({ ok: true, enabled: state.enabled });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/eld/device/status", requireDevice, async (req, res, next) => {
    try {
      const context = await eldService.getDeviceContext(req.device);
      const state = context.state ? {
        currentDutyCode: context.state.currentDutyCode,
        specialDrivingCode: context.state.specialDrivingCode,
        vehicleMoving: context.state.vehicleMoving,
        ignitionOn: context.state.ignitionOn,
        lastTelemetryAt: context.state.lastTelemetryAt,
        lastRecordAt: context.state.lastRecordAt,
        lastEngineSyncAt: context.state.lastEngineSyncAt,
        lastPositionAt: context.state.lastPositionAt,
        unidentifiedDrivingMinutes: context.state.unidentifiedDrivingMinutes
      } : null;
      res.json({
        ok: true,
        enabled: context.state?.enabled === true,
        productionAuthorized: process.env.ELD_PRODUCTION_ENABLED === "true",
        driverLoggedIn: Boolean(context.state?.currentDriverId && context.state.currentDriverId === req.device.driverId),
        state,
        carrierConfigured: Boolean(context.config),
        driverConfigured: Boolean(context.driver?.eldUsername && context.driver?.licenseNum && context.driver?.licenseState),
        activeDiagnostics: context.diagnostics
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/eld/hos/status", requireDevice, async (req, res, next) => {
    try {
      const status = await eldService.getHosStatus(req.device);
      res.json({ ok: true, ...status });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/eld/login", requireDevice, async (req, res, next) => {
    try {
      const event = await eldService.createLoginLogout(req.device, LOGIN_CODE.LOGIN, req.body || {});
      res.json({ ok: true, success: true, event });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/eld/logout", requireDevice, async (req, res, next) => {
    try {
      const event = await eldService.createLoginLogout(req.device, LOGIN_CODE.LOGOUT, req.body || {});
      res.json({ ok: true, success: true, event });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/eld/duty-status", requireDevice, async (req, res, next) => {
    try {
      const event = await eldService.createDutyStatus(req.device, req.body || {});
      res.json({ ok: true, event });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/eld/special-driving", requireDevice, async (req, res, next) => {
    try {
      const event = await eldService.setSpecialDriving(req.device, req.body || {});
      res.json({ ok: true, event });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/eld/records", requireDevice, async (req, res, next) => {
    try {
      const events = await eldService.listRecords(req.device, req.query || {});
      res.json({ ok: true, events });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/eld/records/:eventId/edit", requireDevice, async (req, res, next) => {
    try {
      const event = await eldService.driverEdit(req.device, req.params.eventId, req.body || {});
      res.json({ ok: true, event });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/eld/certifications", requireDevice, async (req, res, next) => {
    try {
      const event = await eldService.certifyRecords(req.device, req.body?.recordDate, req.body?.annotation);
      res.json({ ok: true, success: true, event });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/eld/output-file", requireDevice, async (req, res, next) => {
    try {
      const context = await eldService.getDeviceContext(req.device);
      const events = await eldService.listRecords(req.device, {
        from: req.body?.from || Date.now() - 8 * 24 * 60 * 60 * 1000,
        to: req.body?.to || new Date(),
        limit: 5000
      });
      const result = buildEldOutputFile({
        config: context.config,
        driver: context.driver,
        vehicle: context.vehicle,
        events,
        outputFileComment: req.body?.outputFileComment || "",
        filenameSuffix: req.body?.filenameSuffix,
        privateKeyPem: pemFromEnv(process.env.FMCSA_ELD_AUTH_PRIVATE_KEY)
      });
      const attempt = await db.getPrisma().eldTransferAttempt.create({
        data: {
          orgId: req.device.orgId,
          driverId: req.device.driverId,
          deviceId: req.device.deviceId,
          method: "FILE_GENERATION",
          outputFileName: result.filename,
          outputFileComment: String(req.body?.outputFileComment || "").slice(0, 60),
          fileDataCheck: result.fileDataCheck,
          status: "GENERATED"
        }
      });
      res.json({
        ok: true,
        transferAttemptId: attempt.id,
        filename: result.filename,
        fileDataCheck: result.fileDataCheck,
        content: result.content
      });
    } catch (error) {
      next(error);
    }
  });

  // Operator read access is deliberately separate from the device endpoint so
  // a customer can audit records without ever being able to impersonate a cab.
  app.get("/api/eld/audit/records", requireOperator, async (req, res, next) => {
    try {
      const orgId = operatorOrgId(req);
      const driverId = String(req.query.driverId || "").trim();
      if (!orgId || !driverId) return res.status(400).json({ ok: false, error: "driverId required" });
      const events = await db.getPrisma().eldEvent.findMany({
        where: { orgId, driverId },
        orderBy: [{ occurredAt: "desc" }, { sequenceEpoch: "desc" }, { sequenceId: "desc" }],
        take: Math.min(5000, Math.max(1, Number(req.query.limit) || 1000))
      });
      res.json({ ok: true, events });
    } catch (error) {
      next(error);
    }
  });

  // attachDevice is referenced here to keep route-order behavior explicit and
  // prevent future generic /api/eld handlers from accidentally accepting an
  // unverified bearer token.
  void attachDevice;
}

module.exports = { registerEldRoutes };
