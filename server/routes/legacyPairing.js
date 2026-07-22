const crypto = require("crypto");
const { createRateLimiter } = require("../middleware/rateLimiter");
const db = require("../db");

// Tight limiter on pairing-code claim — defends against brute force of 6-digit codes.
// 10 attempts / minute / IP. Generation endpoints are still gated by employee auth.
const pairingClaimLimiter = createRateLimiter({ windowMs: 60000, max: 10, keyPrefix: "pair-claim" });

function registerLegacyPairingRoutes(app, deps) {
  const {
    requireEmployeeOrCustomerApi,
    sanitizeString,
    nowIso,
    generateDigits,
    generateDriverPin,
    isExpired,
    lastDataWriteAtRef,
    log = console.log
  } = deps;

  const pairingDebug = {
    generated: [],
    claims: []
  };

  function pushPairingDebug(list, entry) {
    list.unshift(entry);
    if (list.length > 50) list.length = 50;
  }

  function normalizePairingCode(value) {
    if (!value) return "";
    return String(value).trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  }

  function normalizePairingCodeDigits(value) {
    if (!value) return { digits: "", hadNonDigit: false };
    const raw = String(value).trim();
    const digits = raw.replace(/[^0-9]/g, "");
    const hadNonDigit = /[^0-9]/.test(raw);
    return { digits, hadNonDigit };
  }

  function normalizePairingClaimInput(req) {
    const body = req.body || {};
    const query = req.query || {};
    const pairingCodeRaw = body.pairingCode
      || body.code
      || body.pair_code
      || body.pairing_code
      || body.pairCode
      || body.companyCode
      || body.company_code
      || query.pairingCode
      || query.code
      || query.companyCode
      || query.company_code
      || "";
    const deviceIdRaw = body.deviceId
      || body.device_id
      || body.id
      || body.uuid
      || query.deviceId
      || query.device_id
      || query.id
      || query.uuid
      || req.headers["x-device-id"]
      || "";
    const deviceNameRaw = body.deviceName || body.device_name || body.deviceLabel || body.device_label || query.deviceName || query.device_name || "";
    const driverPinRaw = body.driverPin || body.pin || body.driver_pin || query.driverPin || query.pin || "";
    return {
      pairingCode: normalizePairingCode(pairingCodeRaw),
      deviceId: sanitizeString(deviceIdRaw || "", 120),
      deviceName: sanitizeString(deviceNameRaw || "", 120),
      driverPin: sanitizeString(driverPinRaw || "", 20)
    };
  }

  function normalizeCompanyCode(value) {
    return String(value || "")
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");
  }

  function createDriverAuthToken() {
    return `drv_${crypto.randomBytes(24).toString("hex")}`;
  }

  function driverDisplayName(driver) {
    if (!driver) return "";
    return `${driver.firstName || ""} ${driver.lastName || ""}`.trim();
  }

  // Builds the field set for a new pairing. pairingCode is a single
  // generateDigits(6) call with no uniqueness check here — handlePairCodeGenerate
  // overwrites it with a collision-checked code afterward; handlePairCodeReplace
  // does not (this asymmetry matches the original implementation exactly).
  function createPairingFields({ vehicleId, driverId, orgId }) {
    const pairingCode = generateDigits(6);
    const driverPin = generateDriverPin();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60000).toISOString();
    return {
      orgId: sanitizeString(orgId || "ORG_DEFAULT", 80),
      pairingCode,
      driverPin,
      vehicleId,
      driverId,
      status: "pending",
      expiresAt
    };
  }

  async function handlePairCodeGenerate(req, res, next) {
    const { vehicleId, driverId } = req.body || {};
    const requestId = process.env.DEBUG_PAIRING === "1" ? crypto.randomBytes(6).toString("hex") : null;
    const logPrefix = requestId ? `[PAIR ${requestId}]` : "[PAIR]";
    const localLog = (...args) => log(logPrefix, ...args);
    if (!vehicleId || !driverId) {
      return res.status(400).json({ ok: false, error: "missing_vehicle_or_driver" });
    }
    try {
      const [vehicle, driver] = await Promise.all([
        db.getVehicleByVehicleId(vehicleId),
        db.getDriverByDriverId(driverId)
      ]);
      if (!vehicle || !driver) {
        return res.status(404).json({ ok: false, error: "vehicle_or_driver_not_found" });
      }
      const now = nowIso();
      const samePairings = await db.findActivePairingsForPair(vehicleId, driverId);
      let replacedAssignmentId = null;
      for (const p of samePairings) {
        await db.updatePairing(p.id, { status: "expired", expiresAt: now });
        replacedAssignmentId = replacedAssignmentId || p.id;
      }

      let pairingCode;
      let attempts = 0;
      do {
        pairingCode = generateDigits(6);
        attempts += 1;
      } while (await db.isPairingCodeInUse(pairingCode) && attempts < 5);

      const fields = createPairingFields({ vehicleId, driverId, orgId: req.body?.orgId });
      fields.pairingCode = pairingCode;
      const pairing = await db.createPairing(fields);

      const payload = {
        ok: true,
        pairId: pairing.id,
        code: pairing.pairingCode,
        pairCode: pairing.pairingCode,
        pairingCode: pairing.pairingCode,
        expiresAt: pairing.expiresAt,
        expiresInSeconds: Math.max(0, Math.round((new Date(pairing.expiresAt).getTime() - Date.now()) / 1000)),
        driverPin: pairing.driverPin,
        driverPinExpiresAt: pairing.driverPinExpiresAt,
        vehicleId,
        driverId,
        orgId: pairing.orgId,
        status: "PENDING",
        replacedAssignmentId
      };
      if (requestId) payload.debug = { requestId };
      localLog("generated", {
        vehicleId,
        driverId,
        pairId: pairing.id,
        pairingCode: pairing.pairingCode,
        expiresAt: pairing.expiresAt,
        replacedAssignmentId: payload.replacedAssignmentId || null
      });
      pushPairingDebug(pairingDebug.generated, {
        time: nowIso(), vehicleId, driverId, pairId: pairing.id, pairingCode: pairing.pairingCode, expiresAt: pairing.expiresAt, status: pairing.status
      });
      return res.json(payload);
    } catch (err) {
      next(err);
    }
  }

  async function handlePairCodeExpire(req, res, next) {
    const pairId = req.params.pairId;
    if (!pairId) return res.status(400).json({ ok: false, error: "missing_pair_id" });
    try {
      const pairing = await db.findPairingById(pairId);
      if (!pairing) return res.status(404).json({ ok: false, error: "pair_not_found" });
      const now = nowIso();
      await db.updatePairing(pairId, { status: "expired", expiresAt: now });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  }

  async function handlePairCodeReplace(req, res, next) {
    const { vehicleId, driverId } = req.body || {};
    if (!vehicleId || !driverId) {
      return res.status(400).json({ ok: false, error: "missing_vehicle_or_driver" });
    }
    try {
      const toReplace = await db.findNonExpiredPairingsForVehicleOrDriver(vehicleId, driverId);
      const now = nowIso();
      for (const p of toReplace) {
        await db.updatePairing(p.id, { status: "replaced", expiresAt: now });
      }
      const fields = createPairingFields({ vehicleId, driverId, orgId: req.body?.orgId });
      const pairing = await db.createPairing(fields);
      res.json({
        ok: true,
        pairId: pairing.id,
        code: pairing.pairingCode,
        pairingCode: pairing.pairingCode,
        expiresAt: pairing.expiresAt,
        expiresInSeconds: Math.round((new Date(pairing.expiresAt).getTime() - Date.now()) / 1000),
        driverPin: pairing.driverPin,
        driverPinExpiresAt: pairing.driverPinExpiresAt,
        vehicleId,
        driverId,
        status: "PENDING"
      });
      pushPairingDebug(pairingDebug.generated, {
        time: nowIso(), vehicleId, driverId, pairId: pairing.id, pairingCode: pairing.pairingCode, expiresAt: pairing.expiresAt, status: pairing.status, replaced: true
      });
    } catch (err) {
      next(err);
    }
  }

  async function handlePairingGenerate(req, res, next) {
    return handlePairCodeGenerate(req, res, next);
  }

  async function handlePairingClaim(req, res, next) {
    const input = normalizePairingClaimInput(req);
    const debugMode = req.headers["x-debug"] === "1";
    const normalizedDigits = normalizePairingCodeDigits(input.pairingCode);
    if (normalizedDigits.hadNonDigit) {
      return res.status(400).json({ ok: false, error: "INVALID_CODE_FORMAT", message: "Pairing code must be numeric.", ...(debugMode ? { debug: { normalized: input } } : {}) });
    }
    input.pairingCode = normalizedDigits.digits;
    if (!input.pairingCode) {
      return res.status(400).json({ ok: false, error: "MISSING_CODE", message: "pairingCode required", ...(debugMode ? { debug: { normalized: input } } : {}) });
    }
    if (input.pairingCode.length < 4 || input.pairingCode.length > 10) {
      return res.status(400).json({ ok: false, error: "INVALID_CODE_FORMAT", message: "pairingCode must be 4-10 characters", ...(debugMode ? { debug: { normalized: input } } : {}) });
    }
    if (!input.deviceId) {
      return res.status(400).json({ ok: false, error: "MISSING_DEVICE", message: "deviceId required" });
    }
    try {
      const pairing = await db.findPairingByCode(input.pairingCode);
      if (!pairing) {
        log("[PAIR-CLAIM] not_found", { pairingCode: input.pairingCode, deviceId: input.deviceId });
        pushPairingDebug(pairingDebug.claims, { time: nowIso(), pairingCode: input.pairingCode, deviceId: input.deviceId, status: "not_found" });
        return res.status(404).json({ ok: false, error: "PAIRING_CODE_INVALID_OR_EXPIRED", message: "Invalid or expired pairing code", legacyError: "Invalid code", ...(debugMode ? { debug: { normalized: input } } : {}) });
      }
      if (pairing.status === "active") {
        if (pairing.deviceId && pairing.deviceId !== input.deviceId) {
          log("[PAIR-CLAIM] already_claimed", { pairingCode: pairing.pairingCode, deviceId: input.deviceId, existingDeviceId: pairing.deviceId });
          pushPairingDebug(pairingDebug.claims, { time: nowIso(), pairingCode: pairing.pairingCode, deviceId: input.deviceId, status: "already_claimed", existingDeviceId: pairing.deviceId });
          return res.status(409).json({ ok: false, error: "ALREADY_CLAIMED", message: "Pairing code already claimed by another device", conflict: { pairingCode: pairing.pairingCode, assignmentId: pairing.id, deviceId: pairing.deviceId, status: pairing.status }, claimedByDeviceId: pairing.deviceId, ...(debugMode ? { debug: { normalized: input } } : {}) });
        }
        const [vehicle, driver] = await Promise.all([db.getVehicleByVehicleId(pairing.vehicleId), db.getDriverByDriverId(pairing.driverId)]);
        return res.json({ ok: true, pairingCode: pairing.pairingCode, driverPin: pairing.driverPin, pinExpiresAt: pairing.driverPinExpiresAt, assignmentId: pairing.id, deviceId: pairing.deviceId || input.deviceId, deviceLabel: pairing.deviceLabel || input.deviceName || "", serverTime: nowIso(), vehicle: { vehicleId: pairing.vehicleId, name: vehicle?.unitName || "" }, driver: { driverId: pairing.driverId, name: driverDisplayName(driver) }, vehicleId: pairing.vehicleId, driverId: pairing.driverId, status: pairing.status, ...(debugMode ? { debug: { normalized: input, route: req.path } } : {}) });
      }
      if (pairing.status && pairing.status !== "pending") {
        log("[PAIR-CLAIM] status_invalid", { pairingCode: pairing.pairingCode, deviceId: input.deviceId, status: pairing.status });
        pushPairingDebug(pairingDebug.claims, { time: nowIso(), pairingCode: pairing.pairingCode, deviceId: input.deviceId, status: pairing.status });
        return res.status(409).json({ ok: false, error: "PAIRING_CODE_ALREADY_CLAIMED", message: "Pairing code already used", legacyError: "Code already used", ...(debugMode ? { debug: { normalized: input } } : {}) });
      }
      if (isExpired(pairing.expiresAt) || isExpired(pairing.driverPinExpiresAt)) {
        log("[PAIR-CLAIM] expired", { pairingCode: pairing.pairingCode, deviceId: input.deviceId });
        await db.updatePairing(pairing.id, { status: "expired" });
        pushPairingDebug(pairingDebug.claims, { time: nowIso(), pairingCode: pairing.pairingCode, deviceId: input.deviceId, status: "expired" });
        return res.status(410).json({ ok: false, error: "PAIRING_CODE_INVALID_OR_EXPIRED", message: "Pairing code expired", legacyError: "Expired code", ...(debugMode ? { debug: { normalized: input } } : {}) });
      }
      // PIN check — required when the pairing has a PIN. Driver app must supply it.
      if (pairing.driverPin) {
        if (!input.driverPin) {
          log("[PAIR-CLAIM] pin_required", { pairingCode: pairing.pairingCode, deviceId: input.deviceId });
          pushPairingDebug(pairingDebug.claims, { time: nowIso(), pairingCode: pairing.pairingCode, deviceId: input.deviceId, status: "pin_required" });
          return res.status(401).json({ ok: false, error: "PIN_REQUIRED", message: "Driver PIN required to claim this pairing.", ...(debugMode ? { debug: { normalized: input } } : {}) });
        }
        if (input.driverPin !== pairing.driverPin) {
          log("[PAIR-CLAIM] pin_mismatch", { pairingCode: pairing.pairingCode, deviceId: input.deviceId });
          pushPairingDebug(pairingDebug.claims, { time: nowIso(), pairingCode: pairing.pairingCode, deviceId: input.deviceId, status: "pin_mismatch" });
          return res.status(401).json({ ok: false, error: "PIN_INVALID", message: "Driver PIN does not match.", ...(debugMode ? { debug: { normalized: input } } : {}) });
        }
      }
      const fallbackLabel = `Tablet-${input.deviceId.slice(-4) || "UNK"}`;
      const deviceLabel = input.deviceName || pairing.deviceLabel || fallbackLabel;
      const updated = await db.updatePairing(pairing.id, {
        status: "active",
        deviceId: input.deviceId,
        deviceLabel,
        claimedAt: nowIso()
      });
      log("[PAIR-CLAIM] success", { pairingCode: updated.pairingCode, deviceId: updated.deviceId, assignmentId: updated.id });
      pushPairingDebug(pairingDebug.claims, { time: nowIso(), pairingCode: updated.pairingCode, deviceId: updated.deviceId, status: updated.status, assignmentId: updated.id });
      const [vehicle, driver] = await Promise.all([db.getVehicleByVehicleId(updated.vehicleId), db.getDriverByDriverId(updated.driverId)]);
      res.json({ ok: true, pairingCode: updated.pairingCode, driverPin: updated.driverPin, pinExpiresAt: updated.driverPinExpiresAt, assignmentId: updated.id, deviceId: updated.deviceId, deviceLabel: updated.deviceLabel, serverTime: nowIso(), vehicle: { vehicleId: updated.vehicleId, name: vehicle?.unitName || "" }, driver: { driverId: updated.driverId, name: driverDisplayName(driver) }, vehicleId: updated.vehicleId, driverId: updated.driverId, status: updated.status, ...(debugMode ? { debug: { normalized: input, route: req.path } } : {}) });
    } catch (err) {
      next(err);
    }
  }

  // Route name says "active" but this has always meant "pending" — preserved
  // as-is (see db.js listPendingUnexpiredPairings for the full explanation).
  async function handlePairingsActive(req, res, next) {
    try {
      const activePairings = await db.listPendingUnexpiredPairings();
      res.json(activePairings);
    } catch (err) {
      next(err);
    }
  }

  async function pairingHealthHandler(req, res) {
    try {
      const counts = await db.getPairingHealthCounts();
      res.json({ ok: true, time: nowIso(), version: "pairing-v1", active: counts.active, pending: counts.pending, lastWriteAt: lastDataWriteAtRef() });
    } catch (err) {
      res.status(500).json({ ok: false, error: "health_error", message: err?.message || String(err) });
    }
  }

  function pairingRequestLogger(req, res, next) {
    const keys = Object.keys(req.body || {});
    const safeQuery = req.query || {};
    const start = Date.now();
    res.on("finish", () => {
      log("[PAIR-REQ]", { method: req.method, path: req.path, query: safeQuery, bodyKeys: keys, status: res.statusCode, ms: Date.now() - start });
    });
    next();
  }

  app.use(["/api/pairings", "/pairings", "/api/pairing"], pairingRequestLogger);

  app.get("/api/pairings/health", pairingHealthHandler);
  app.get("/api/pairing/health", pairingHealthHandler);

  app.get("/api/pairings/debug", requireEmployeeOrCustomerApi, async (req, res) => {
    try {
      const active = await db.listClaimedActivePairings();
      res.json({ ok: true, generated: pairingDebug.generated, claims: pairingDebug.claims, active });
    } catch (err) {
      res.status(500).json({ ok: false, error: "debug_error", message: err?.message || String(err) });
    }
  });

  app.post("/pairings/generate", handlePairingGenerate);
  app.post("/api/pairings/generate", handlePairingGenerate);
  app.post("/api/pairing/generate", handlePairingGenerate);
  app.post("/api/pair-code", requireEmployeeOrCustomerApi, handlePairCodeGenerate);
  app.post("/api/pair-code/generate", requireEmployeeOrCustomerApi, handlePairCodeGenerate);
  app.post("/api/pair-code/replace", requireEmployeeOrCustomerApi, handlePairCodeReplace);
  app.post("/api/pair-code/:pairId/expire", requireEmployeeOrCustomerApi, handlePairCodeExpire);
  app.post("/api/pair-code/expire-and-generate", requireEmployeeOrCustomerApi, handlePairCodeReplace);

  app.post("/pairings/claim", pairingClaimLimiter, handlePairingClaim);
  app.post("/api/pairings/claim", pairingClaimLimiter, handlePairingClaim);
  app.post("/api/pairing/claim", pairingClaimLimiter, handlePairingClaim);
  app.post("/pairing/claim", pairingClaimLimiter, handlePairingClaim);
  app.post("/api/pairings/claim-device", pairingClaimLimiter, handlePairingClaim);
  app.post("/api/pairing/claim-device", pairingClaimLimiter, handlePairingClaim);
  app.post("/pairing/claim-device", pairingClaimLimiter, handlePairingClaim);

  app.get("/pairings/active", handlePairingsActive);
  app.get("/api/pairings/active", handlePairingsActive);

  app.post("/auth/driverLogin", pairingClaimLimiter, async (req, res, next) => {
    const { companyCode, driverPin } = req.body || {};
    const normalizedCompanyCode = normalizeCompanyCode(companyCode);
    const normalizedDriverPin = sanitizeString(driverPin || "", 20).replace(/\D+/g, "").slice(0, 6);
    if (!normalizedCompanyCode || !normalizedDriverPin) {
      return res.status(400).json({ error: "companyCode and driverPin required" });
    }
    try {
      const found = await db.findDriverLoginPairing({ companyCode, driverPin: normalizedDriverPin, normalizeCode: normalizeCompanyCode });
      if (!found) return res.status(401).json({ error: "Invalid credentials" });
      const { pairing, org } = found;
      if (isExpired(pairing.driverPinExpiresAt) || isExpired(pairing.expiresAt)) {
        await db.updatePairing(pairing.id, { status: "expired" });
        return res.status(410).json({ error: "PIN expired" });
      }
      const driver = await db.getDriverByDriverId(pairing.driverId);
      if (!driver) {
        return res.status(404).json({ error: "Driver not found" });
      }
      const resolvedTenantId = (org?.companyCode ? normalizeCompanyCode(org.companyCode) : null)
        || normalizeCompanyCode(pairing.orgId || "ORG_DEFAULT")
        || normalizedCompanyCode;
      res.json({
        tenantId: resolvedTenantId,
        driverId: driver.driverId,
        vehicleId: pairing.vehicleId,
        pairingCode: pairing.pairingCode,
        token: createDriverAuthToken(),
        driverName: driverDisplayName(driver) || driver.driverId
      });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/auth/driverLogin", (req, res, next) => {
    req.url = "/auth/driverLogin";
    app.handle(req, res, next);
  });

  app.post("/api/pairing/create", async (req, res, next) => {
    const { vehicleId, driverId } = req.body || {};
    if (!vehicleId || !driverId) return res.status(400).json({ error: "vehicleId and driverId required" });
    try {
      const [vehicle, driver] = await Promise.all([db.getVehicleByVehicleId(vehicleId), db.getDriverByDriverId(driverId)]);
      if (!vehicle || !driver) return res.status(404).json({ error: "Vehicle or driver not found" });
      const fields = createPairingFields({ vehicleId, driverId, orgId: req.body?.orgId });
      const pairing = await db.createPairing(fields);
      res.json({ ok: true, pairingId: pairing.id, pairingCode: pairing.pairingCode, driverPin: pairing.driverPin, expiresAt: pairing.expiresAt });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/pairing/activate", async (req, res, next) => {
    const pairingId = req.body?.pairingId || "";
    const pairingCode = normalizePairingCode(req.body?.pairingCode || req.body?.code || "");
    const deviceId = sanitizeString(req.body?.deviceId || req.body?.device_id || "", 120);
    const deviceLabel = sanitizeString(req.body?.deviceLabel || req.body?.deviceName || req.body?.device_name || "", 120);
    if ((!pairingId && !pairingCode) || !deviceId) {
      return res.status(400).json({ ok: false, error: "pairingId or pairingCode and deviceId required" });
    }
    try {
      const pairing = pairingId ? await db.findPairingById(pairingId) : await db.findPairingByCode(pairingCode);
      if (!pairing) return res.status(404).json({ ok: false, error: "Invalid pairing" });
      if (isExpired(pairing.expiresAt)) {
        await db.updatePairing(pairing.id, { status: "expired" });
        return res.status(410).json({ ok: false, error: "Expired code" });
      }
      const updated = await db.updatePairing(pairing.id, {
        status: "active",
        deviceId,
        deviceLabel: deviceLabel || pairing.deviceLabel || "",
        claimedAt: nowIso()
      });
      res.json({ ok: true, pairing: updated });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/pairing/status", async (req, res, next) => {
    try {
      const vehicleId = sanitizeString(req.query.vehicleId || "", 80);
      const pairing = await db.getActivePairingForVehicle(vehicleId);
      res.json({ ok: true, pairing: pairing || null });
    } catch (err) {
      next(err);
    }
  });

  return { pairingDebug };
}

module.exports = {
  registerLegacyPairingRoutes
};
