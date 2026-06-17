const crypto = require("crypto");
const { createRateLimiter } = require("../middleware/rateLimiter");

// Tight limiter on pairing-code claim — defends against brute force of 6-digit codes.
// 10 attempts / minute / IP. Generation endpoints are still gated by employee auth.
const pairingClaimLimiter = createRateLimiter({ windowMs: 60000, max: 10, keyPrefix: "pair-claim" });

function registerLegacyPairingRoutes(app, deps) {
  const {
    readData,
    writeData,
    requireEmployeeOrCustomerApi,
    sanitizeString,
    nowIso,
    makeId,
    generateDigits,
    generateDriverPin,
    isExpired,
    normalizeMetrics,
    storeNormalizedSnapshot,
    triggerTelemetryPipeline,
    resolveOrgIdForVehicle,
    telemetryLatest,
    lastDataWriteAtRef,
    createPairingRouter,
    pairingRouterDeps,
    log = console.log
  } = deps;

  // Local helpers — defensive array access for in-memory store.
  const getVehicles = (data) => (Array.isArray(data?.vehicles) ? data.vehicles : []);
  const getDrivers = (data) => (Array.isArray(data?.drivers) ? data.drivers : []);
  const getPairings = (data) => {
    if (!Array.isArray(data?.pairings)) data.pairings = [];
    return data.pairings;
  };

  function findPairConflict(data, vehicleId, driverId) {
    const pairings = Array.isArray(data.pairings) ? data.pairings : [];
    const now = Date.now();
    pairings.forEach((p) => {
      const expired = (p.expiresAt && new Date(p.expiresAt).getTime() <= now)
        || (p.driverPinExpiresAt && new Date(p.driverPinExpiresAt).getTime() <= now);
      if (expired && p.status !== "expired") p.status = "expired";
    });
    const activeVehicle = pairings.find((p) => p.vehicleId === vehicleId && p.status === "active");
    if (activeVehicle) return { reason: "VEHICLE_ALREADY_ASSIGNED", pairing: activeVehicle };
    const activeDriver = pairings.find((p) => p.driverId === driverId && p.status === "active");
    if (activeDriver) return { reason: "DRIVER_ALREADY_ASSIGNED", pairing: activeDriver };
    const pendingVehicle = pairings.find((p) => p.vehicleId === vehicleId && p.status === "pending" && !isExpired(p.expiresAt));
    if (pendingVehicle) return { reason: "UNEXPIRED_CODE", pairing: pendingVehicle };
    const pendingDriver = pairings.find((p) => p.driverId === driverId && p.status === "pending" && !isExpired(p.expiresAt));
    if (pendingDriver) return { reason: "UNEXPIRED_CODE", pairing: pendingDriver };
    return null;
  }

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

  function buildCompanyCodeCandidates(data, pairing) {
    const vehicleOrgId = pairing?.vehicleId ? resolveOrgIdForVehicle(data, pairing.vehicleId, "") : "";
    const orgId = sanitizeString(pairing?.orgId || vehicleOrgId || "", 80);
    const orgs = Array.isArray(data.orgs) ? data.orgs : [];
    const org = orgs.find((entry) => {
      const entryId = sanitizeString(entry?.orgId || entry?.id || "", 80);
      return Boolean(entryId) && entryId === orgId;
    }) || null;
    const candidates = [
      orgId,
      org?.orgId,
      org?.id,
      org?.name,
      org?.companyCode,
      org?.company_code,
      org?.tenantId,
      org?.tenant_id,
    ];
    return Array.from(new Set(candidates.map(normalizeCompanyCode).filter(Boolean)));
  }

  function createDriverAuthToken() {
    return `drv_${crypto.randomBytes(24).toString("hex")}`;
  }

  function createPairingRecord({ vehicleId, driverId, orgId, vehicleName, driverName }) {
    const pairingCode = generateDigits(6);
    const driverPin = generateDriverPin();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60000).toISOString();
    return {
      id: makeId("PAIR"),
      orgId: sanitizeString(orgId || "ORG_DEFAULT", 80),
      pairingCode,
      pairCode: pairingCode,
      driverPin,
      vehicleId,
      driverId,
      vehicleName: sanitizeString(vehicleName || "", 120),
      driverName: sanitizeString(driverName || "", 120),
      status: "pending",
      expiresAt,
      driverPinExpiresAt: expiresAt,
      createdAt: nowIso()
    };
  }

  async function handlePairCodeGenerate(req, res, next) {
    const { vehicleId, driverId } = req.body || {};
    const requestId = process.env.DEBUG_PAIRING === "1" ? require("crypto").randomBytes(6).toString("hex") : null;
    const logPrefix = requestId ? `[PAIR ${requestId}]` : "[PAIR]";
    const localLog = (...args) => log(logPrefix, ...args);
    if (!vehicleId || !driverId) {
      return res.status(400).json({ ok: false, error: "missing_vehicle_or_driver" });
    }
    try {
      const data = await readData();
      const vehicle = getVehicles(data).find((v) => v.vehicleId === vehicleId);
      const driver = getDrivers(data).find((d) => d.driverId === driverId);
      if (!vehicle || !driver) {
        return res.status(404).json({ ok: false, error: "vehicle_or_driver_not_found" });
      }
      const now = nowIso();
      const pairings = getPairings(data);
      const samePairings = pairings.filter(
        (p) => (p.vehicleId === vehicleId && p.driverId === driverId) && (p.status === "pending" || p.status === "active")
      );
      let replacedAssignmentId = null;
      if (samePairings.length) {
        samePairings.forEach((p) => {
          p.status = "expired";
          p.replacedAt = now;
          p.expiresAt = now;
          p.driverPinExpiresAt = now;
          replacedAssignmentId = replacedAssignmentId || p.id;
        });
      }
      let pairingCode;
      let attempts = 0;
      do {
        pairingCode = generateDigits(6);
        attempts += 1;
      } while (
        pairings.some((p) => {
          const digitsStored = normalizePairingCodeDigits(p.pairingCode || p.code).digits;
          const pending = p.status === "pending" || p.status === "active";
          return pending && digitsStored === pairingCode && !isExpired(p.expiresAt);
        }) && attempts < 5
      );
      const pairing = createPairingRecord({
        vehicleId,
        driverId,
        orgId: req.body?.orgId,
        vehicleName: vehicle.unitName || vehicle.name || vehicle.vehicleId,
        driverName: `${driver.firstName || ""} ${driver.lastName || ""}`.trim()
      });
      pairing.pairingCode = pairingCode;
      pairing.pairCode = pairingCode;
      getPairings(data).push(pairing);
      await writeData(data);
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
      const data = await readData();
      const pairing = (data.pairings || []).find((p) => p.id === pairId);
      if (!pairing) return res.status(404).json({ ok: false, error: "pair_not_found" });
      pairing.status = "expired";
      pairing.expiresAt = nowIso();
      pairing.driverPinExpiresAt = nowIso();
      await writeData(data);
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
      const data = await readData();
      const vehicle = getVehicles(data).find((v) => v.vehicleId === vehicleId);
      const driver = getDrivers(data).find((d) => d.driverId === driverId);
      getPairings(data).forEach((p) => {
        if ((p.vehicleId === vehicleId || p.driverId === driverId) && p.status !== "expired") {
          p.status = "replaced";
          p.expiresAt = nowIso();
          p.driverPinExpiresAt = nowIso();
        }
      });
      const pairing = createPairingRecord({
        vehicleId,
        driverId,
        orgId: req.body?.orgId,
        vehicleName: vehicle?.unitName || vehicle?.name || vehicleId,
        driverName: `${driver?.firstName || ""} ${driver?.lastName || ""}`.trim()
      });
      getPairings(data).push(pairing);
      await writeData(data);
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
      const data = await readData();
      const pairing = (data.pairings || []).find((p) => normalizePairingCodeDigits(p.pairingCode || p.code).digits === input.pairingCode);
      if (!pairing) {
        log("[PAIR-CLAIM] not_found", { pairingCode: input.pairingCode, deviceId: input.deviceId });
        pushPairingDebug(pairingDebug.claims, { time: nowIso(), pairingCode: input.pairingCode, deviceId: input.deviceId, status: "not_found" });
        return res.status(404).json({ ok: false, error: "PAIRING_CODE_INVALID_OR_EXPIRED", message: "Invalid or expired pairing code", legacyError: "Invalid code", ...(debugMode ? { debug: { normalized: input } } : {}) });
      }
      const normalizedStored = normalizePairingCodeDigits(pairing.pairingCode || pairing.code).digits;
      if (normalizedStored && normalizedStored !== pairing.pairingCode) pairing.pairingCode = normalizedStored;
      if (pairing.status === "active") {
        if (pairing.deviceId && pairing.deviceId !== input.deviceId) {
          log("[PAIR-CLAIM] already_claimed", { pairingCode: pairing.pairingCode, deviceId: input.deviceId, existingDeviceId: pairing.deviceId });
          pushPairingDebug(pairingDebug.claims, { time: nowIso(), pairingCode: pairing.pairingCode, deviceId: input.deviceId, status: "already_claimed", existingDeviceId: pairing.deviceId });
          return res.status(409).json({ ok: false, error: "ALREADY_CLAIMED", message: "Pairing code already claimed by another device", conflict: { pairingCode: pairing.pairingCode, assignmentId: pairing.id, deviceId: pairing.deviceId, status: pairing.status }, claimedByDeviceId: pairing.deviceId, ...(debugMode ? { debug: { normalized: input } } : {}) });
        }
        return res.json({ ok: true, pairingCode: pairing.pairingCode, driverPin: pairing.driverPin, pinExpiresAt: pairing.driverPinExpiresAt, assignmentId: pairing.id, deviceId: pairing.deviceId || input.deviceId, deviceLabel: pairing.deviceLabel || input.deviceName || "", serverTime: nowIso(), vehicle: { vehicleId: pairing.vehicleId, name: pairing.vehicleName || "" }, driver: { driverId: pairing.driverId, name: pairing.driverName || "" }, vehicleId: pairing.vehicleId, driverId: pairing.driverId, status: pairing.status, ...(debugMode ? { debug: { normalized: input, route: req.path } } : {}) });
      }
      if (pairing.status && pairing.status !== "pending") {
        log("[PAIR-CLAIM] status_invalid", { pairingCode: pairing.pairingCode, deviceId: input.deviceId, status: pairing.status });
        pushPairingDebug(pairingDebug.claims, { time: nowIso(), pairingCode: pairing.pairingCode, deviceId: input.deviceId, status: pairing.status });
        return res.status(409).json({ ok: false, error: "PAIRING_CODE_ALREADY_CLAIMED", message: "Pairing code already used", legacyError: "Code already used", ...(debugMode ? { debug: { normalized: input } } : {}) });
      }
      if (isExpired(pairing.expiresAt) || isExpired(pairing.driverPinExpiresAt)) {
        log("[PAIR-CLAIM] expired", { pairingCode: pairing.pairingCode, deviceId: input.deviceId });
        pairing.status = "expired";
        await writeData(data);
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
      pairing.status = "active";
      pairing.deviceId = input.deviceId;
      const fallbackLabel = `Tablet-${input.deviceId.slice(-4) || "UNK"}`;
      pairing.deviceLabel = input.deviceName || pairing.deviceLabel || fallbackLabel;
      pairing.claimedAt = nowIso();
      pairing.lastSeen = nowIso();
      await writeData(data);
      log("[PAIR-CLAIM] success", { pairingCode: pairing.pairingCode, deviceId: pairing.deviceId, assignmentId: pairing.id });
      pushPairingDebug(pairingDebug.claims, { time: nowIso(), pairingCode: pairing.pairingCode, deviceId: pairing.deviceId, status: pairing.status, assignmentId: pairing.id });
      res.json({ ok: true, pairingCode: pairing.pairingCode, driverPin: pairing.driverPin, pinExpiresAt: pairing.driverPinExpiresAt, assignmentId: pairing.id, deviceId: pairing.deviceId, deviceLabel: pairing.deviceLabel, serverTime: nowIso(), vehicle: { vehicleId: pairing.vehicleId, name: pairing.vehicleName || "" }, driver: { driverId: pairing.driverId, name: pairing.driverName || "" }, vehicleId: pairing.vehicleId, driverId: pairing.driverId, status: pairing.status, ...(debugMode ? { debug: { normalized: input, route: req.path } } : {}) });
    } catch (err) {
      next(err);
    }
  }

  async function handlePairingsActive(req, res, next) {
    try {
      const data = await readData();
      const now = Date.now();
      (data.pairings || []).forEach((p) => {
        if (p.status === "pending" && p.expiresAt) {
          const expired = new Date(p.expiresAt).getTime() <= now;
          if (expired) p.status = "expired";
        }
        if (p.driverPinExpiresAt) {
          const pinExpired = new Date(p.driverPinExpiresAt).getTime() <= now;
          if (pinExpired && p.status !== "expired") p.status = "expired";
        }
      });
      const activePairings = (data.pairings || [])
        .filter((p) => p && p.status === "pending")
        .filter((p) => p.pairingCode && p.driverPin && (p.orgId || "").trim())
        .filter((p) => !isExpired(p.expiresAt) && !isExpired(p.driverPinExpiresAt))
        .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
      await writeData(data);
      res.json(activePairings);
    } catch (err) {
      next(err);
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

  app.get("/api/pairings/health", (req, res) => {
    readData().then((data) => {
      const active = (data.pairings || []).filter((p) => p.status === "active" && !isExpired(p.expiresAt));
      const pending = (data.pairings || []).filter((p) => p.status === "pending" && !isExpired(p.expiresAt));
      res.json({ ok: true, time: nowIso(), version: "pairing-v1", active: active.length, pending: pending.length, lastWriteAt: lastDataWriteAtRef() });
    }).catch((err) => {
      res.status(500).json({ ok: false, error: "health_error", message: err?.message || String(err) });
    });
  });

  app.get("/api/pairing/health", (req, res) => {
    readData().then((data) => {
      const active = (data.pairings || []).filter((p) => p.status === "active" && !isExpired(p.expiresAt));
      const pending = (data.pairings || []).filter((p) => p.status === "pending" && !isExpired(p.expiresAt));
      res.json({ ok: true, time: nowIso(), version: "pairing-v1", active: active.length, pending: pending.length, lastWriteAt: lastDataWriteAtRef() });
    }).catch((err) => {
      res.status(500).json({ ok: false, error: "health_error", message: err?.message || String(err) });
    });
  });

  app.get("/api/pairings/debug", requireEmployeeOrCustomerApi, async (req, res) => {
    try {
      const data = await readData();
      const active = (data.pairings || []).filter((p) => p.status === "active" && !isExpired(p.expiresAt));
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
      const data = await readData();
      // Build a lookup: orgId -> companyCode for all orgs
      const orgCompanyCodeMap = {};
      (data.orgs || []).forEach((o) => {
        const oid = normalizeCompanyCode(o.orgId || o.id || '');
        if (oid && o.companyCode) orgCompanyCodeMap[oid] = normalizeCompanyCode(o.companyCode);
      });

      const pairing = (data.pairings || []).find((p) => {
        if (p.driverPin !== normalizedDriverPin) return false;
        const pairingOrgId = normalizeCompanyCode(p.orgId || 'ORG_DEFAULT');
        // Match by raw orgId OR by org's friendly companyCode
        const friendlyCode = orgCompanyCodeMap[pairingOrgId] || '';
        return pairingOrgId === normalizedCompanyCode || friendlyCode === normalizedCompanyCode;
      });
      if (!pairing) return res.status(401).json({ error: "Invalid credentials" });
      if (isExpired(pairing.driverPinExpiresAt) || isExpired(pairing.expiresAt)) {
        pairing.status = "expired";
        await writeData(data);
        return res.status(410).json({ error: "PIN expired" });
      }
      const allowedCompanyCodes = buildCompanyCodeCandidates(data, pairing);
      // Also allow what the driver typed (they already matched via pairing find above)
      const allCodes = Array.from(new Set([...allowedCompanyCodes, normalizedCompanyCode]));
      if (!allCodes.includes(normalizedCompanyCode)) {
        return res.status(401).json({ error: "Invalid credentials" });
      }
      const drivers = Array.isArray(data.drivers) ? data.drivers : [];
      const driver = drivers.find((d) => d.driverId === pairing.driverId);
      if (!driver) {
        return res.status(404).json({ error: "Driver not found" });
      }
      const orgForTenant = (Array.isArray(data.orgs) ? data.orgs : []).find((o) => { const oid = normalizeCompanyCode(o.orgId || o.id || ""); return oid === normalizeCompanyCode(pairing.orgId || ""); }); const resolvedTenantId = (orgForTenant?.companyCode ? normalizeCompanyCode(orgForTenant.companyCode) : null) || allowedCompanyCodes[0] || normalizedCompanyCode;
      res.json({
        tenantId: resolvedTenantId,
        driverId: driver.driverId,
        vehicleId: pairing.vehicleId,
        pairingCode: pairing.pairingCode,
        token: createDriverAuthToken(),
        driverName: `${driver.firstName || ""} ${driver.lastName || ""}`.trim() || driver.driverId
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
      const data = await readData();
      const vehicle = getVehicles(data).find((v) => v.vehicleId === vehicleId);
      const driver = getDrivers(data).find((d) => d.driverId === driverId);
      if (!vehicle || !driver) return res.status(404).json({ error: "Vehicle or driver not found" });
      const pairing = createPairingRecord({ vehicleId, driverId, orgId: req.body?.orgId, vehicleName: vehicle.unitName || vehicle.name || vehicle.vehicleId, driverName: `${driver.firstName || ""} ${driver.lastName || ""}`.trim() });
      getPairings(data).push(pairing);
      await writeData(data);
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
      const data = await readData();
      const pairing = (data.pairings || []).find((p) => (pairingId && p.id === pairingId) || (pairingCode && normalizePairingCode(p.pairingCode || p.code) === pairingCode));
      if (!pairing) return res.status(404).json({ ok: false, error: "Invalid pairing" });
      if (isExpired(pairing.expiresAt)) {
        pairing.status = "expired";
        await writeData(data);
        return res.status(410).json({ ok: false, error: "Expired code" });
      }
      pairing.status = "active";
      pairing.deviceId = deviceId;
      pairing.deviceLabel = deviceLabel || pairing.deviceLabel || "";
      pairing.claimedAt = nowIso();
      pairing.lastSeen = nowIso();
      await writeData(data);
      res.json({ ok: true, pairing });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/pairing/status", async (req, res, next) => {
    try {
      const data = await readData();
      const vehicleId = sanitizeString(req.query.vehicleId || "", 80);
      const pairing = (data.pairings || []).find((p) => p.vehicleId === vehicleId && p.status === "active");
      res.json({ ok: true, pairing: pairing || null });
    } catch (err) {
      next(err);
    }
  });

  const pairingRouter = createPairingRouter(pairingRouterDeps);
  app.use("/api/pairing", pairingRouter);

  return {
    findPairConflict,
    pairingDebug
  };
}

module.exports = {
  registerLegacyPairingRoutes
};
