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
      driverPin: sanitizeString(driverPinRaw || "", 20).replace(/\D+/g, "").slice(0, 6)
    };
  }

  function normalizeCompanyCode(value) {
    return String(value || "")
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");
  }

  // Non-secret projection of a pairing for operator-facing reads. rowToPairing
  // includes driverPin, so any response built straight from it leaks the PIN.
  // Anything shown to a dashboard goes through here.
  function publicPairingView(pairing) {
    if (!pairing) return null;
    return {
      id: pairing.id,
      vehicleId: pairing.vehicleId,
      driverId: pairing.driverId,
      deviceId: pairing.deviceId,
      deviceLabel: pairing.deviceLabel,
      orgId: pairing.orgId,
      status: pairing.status,
      expiresAt: pairing.expiresAt,
      claimedAt: pairing.claimedAt,
      revokedAt: pairing.revokedAt,
      createdAt: pairing.createdAt,
      hasDriverPin: Boolean(pairing.driverPin)
    };
  }

  // Constant-time PIN comparison. `!==` short-circuits on the first differing
  // character, so response time leaks how many leading digits were correct —
  // which turns a 6-digit PIN into roughly 60 guesses instead of a million.
  // The rate limiter made that hard to exploit; it should not be the only
  // thing standing in the way.
  function timingSafeEquals(a, b) {
    const bufA = Buffer.from(String(a ?? ""), "utf8");
    const bufB = Buffer.from(String(b ?? ""), "utf8");
    // timingSafeEqual throws on length mismatch, which would itself leak length.
    // Hash both sides to a fixed width first, then compare.
    const hashA = crypto.createHash("sha256").update(bufA).digest();
    const hashB = crypto.createHash("sha256").update(bufB).digest();
    return crypto.timingSafeEqual(hashA, hashB);
  }

  function driverDisplayName(driver) {
    if (!driver) return "";
    return `${driver.firstName || ""} ${driver.lastName || ""}`.trim();
  }

  function pairingClaimPayload(pairing, input, deviceToken, vehicle, driver, debugMode) {
    const driverName = driverDisplayName(driver) || pairing.driverId || "Driver";
    return {
      ok: true,
      deviceToken,
      pairingCode: pairing.pairingCode,
      assignmentId: pairing.id,
      deviceId: pairing.deviceId || input.deviceId,
      deviceLabel: pairing.deviceLabel || input.deviceName || "",
      serverTime: nowIso(),
      tenantId: pairing.orgId || "",
      orgId: pairing.orgId || "",
      vehicle: { vehicleId: pairing.vehicleId, name: vehicle?.unitName || pairing.vehicleId || "" },
      driver: { driverId: pairing.driverId, name: driverName },
      vehicleId: pairing.vehicleId || "",
      driverId: pairing.driverId || "",
      driverName,
      status: pairing.status,
      ...(debugMode ? { debug: { route: input.route || "pairing-claim" } } : {})
    };
  }

  function customerOrgId(req) {
    return sanitizeString(req.customer?.orgId || "", 80);
  }

  function denyCustomerOrgMismatch(req, res, targetOrgId) {
    const actingOrgId = customerOrgId(req);
    const normalizedTarget = sanitizeString(targetOrgId || "", 80);
    if (actingOrgId && (!normalizedTarget || actingOrgId !== normalizedTarget)) {
      res.status(403).json({ ok: false, error: "cross_org_access_denied" });
      return true;
    }
    return false;
  }

  function resolvePairingOrg(vehicle, driver) {
    const vehicleOrgId = sanitizeString(vehicle?.orgId || "", 80);
    const driverOrgId = sanitizeString(driver?.orgId || "", 80);
    if (!vehicleOrgId || !driverOrgId || vehicleOrgId !== driverOrgId) return "";
    return vehicleOrgId;
  }

  async function loadPairingTargets(req, res, vehicleId, driverId) {
    const [vehicle, driver] = await Promise.all([
      db.getVehicleByVehicleId(vehicleId),
      db.getDriverByDriverId(driverId)
    ]);
    if (!vehicle || !driver) {
      res.status(404).json({ ok: false, error: "vehicle_or_driver_not_found" });
      return null;
    }
    const orgId = resolvePairingOrg(vehicle, driver);
    if (!orgId) {
      res.status(409).json({ ok: false, error: "vehicle_driver_org_mismatch" });
      return null;
    }
    if (denyCustomerOrgMismatch(req, res, orgId)) return null;
    return { vehicle, driver, orgId };
  }

  // Allocates a pairing code that is not currently in use.
  //
  // The previous loop ran `while (inUse && attempts < 5)` and then used
  // whatever code it last produced — so on five consecutive collisions it
  // issued a DUPLICATE. findPairingByCode does findFirst, so a duplicate means
  // a device claiming that code can be bound to the wrong vehicle. It also only
  // guarded the generate path; handlePairCodeReplace created codes with no
  // uniqueness check at all.
  //
  // Now: more attempts, and a hard failure instead of a silent collision. A
  // caller seeing PAIRING_CODE_ALLOCATION_FAILED can retry; a driver sent to
  // the wrong truck cannot.
  async function allocateUniquePairingCode(maxAttempts = 12) {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const candidate = generateDigits(6);
      if (!(await db.isPairingCodeInUse(candidate))) return candidate;
    }
    const err = new Error("Could not allocate an unused pairing code");
    err.code = "PAIRING_CODE_ALLOCATION_FAILED";
    throw err;
  }

  // Builds the field set for a new pairing. The caller supplies a code that has
  // already been checked for uniqueness — both creation paths now do this.
  function createPairingFields({ vehicleId, driverId, orgId, pairingCode }) {
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
      const targets = await loadPairingTargets(req, res, vehicleId, driverId);
      if (!targets) return;
      const now = nowIso();
      const samePairings = await db.findActivePairingsForPair(vehicleId, driverId);
      let replacedAssignmentId = null;
      for (const p of samePairings) {
        await db.updatePairing(p.id, { status: "expired", expiresAt: now });
        replacedAssignmentId = replacedAssignmentId || p.id;
      }

      const pairingCode = await allocateUniquePairingCode();
      const fields = createPairingFields({ vehicleId, driverId, orgId: targets.orgId, pairingCode });
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
        expiresAt: pairing.expiresAt,
        replacedAssignmentId: payload.replacedAssignmentId || null
      });
      pushPairingDebug(pairingDebug.generated, {
        time: nowIso(), orgId: pairing.orgId, vehicleId, driverId, pairId: pairing.id, expiresAt: pairing.expiresAt, status: pairing.status
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
      if (denyCustomerOrgMismatch(req, res, pairing.orgId)) return;
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
      const targets = await loadPairingTargets(req, res, vehicleId, driverId);
      if (!targets) return;
      const toReplace = await db.findNonExpiredPairingsForVehicleOrDriver(vehicleId, driverId);
      const now = nowIso();
      for (const p of toReplace) {
        await db.updatePairing(p.id, { status: "replaced", expiresAt: now });
      }
      const pairingCode = await allocateUniquePairingCode();
      const fields = createPairingFields({ vehicleId, driverId, orgId: targets.orgId, pairingCode });
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
        time: nowIso(), orgId: pairing.orgId, vehicleId, driverId, pairId: pairing.id, expiresAt: pairing.expiresAt, status: pairing.status, replaced: true
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
        log("[PAIR-CLAIM] not_found", { deviceId: input.deviceId });
        pushPairingDebug(pairingDebug.claims, { time: nowIso(), deviceId: input.deviceId, status: "not_found" });
        return res.status(404).json({ ok: false, error: "PAIRING_CODE_INVALID_OR_EXPIRED", message: "Invalid or expired pairing code", legacyError: "Invalid code", ...(debugMode ? { debug: { normalized: input } } : {}) });
      }
      if (isExpired(pairing.expiresAt) || isExpired(pairing.driverPinExpiresAt)) {
        log("[PAIR-CLAIM] expired", { pairingId: pairing.id, deviceId: input.deviceId });
        await db.updatePairing(pairing.id, { status: "expired" });
        pushPairingDebug(pairingDebug.claims, { time: nowIso(), orgId: pairing.orgId, pairId: pairing.id, vehicleId: pairing.vehicleId, driverId: pairing.driverId, status: "expired" });
        return res.status(410).json({ ok: false, error: "PAIRING_CODE_INVALID_OR_EXPIRED", message: "Pairing code expired", legacyError: "Expired code", ...(debugMode ? { debug: { route: req.path } } : {}) });
      }
      // A PIN is required for both a first claim and same-device recovery.
      // Otherwise anyone who learned a claimed code and device ID could mint a
      // replacement device token without knowing the driver's PIN.
      if (pairing.driverPin) {
        if (!input.driverPin) {
          log("[PAIR-CLAIM] pin_required", { pairingId: pairing.id, deviceId: input.deviceId });
          pushPairingDebug(pairingDebug.claims, { time: nowIso(), orgId: pairing.orgId, pairId: pairing.id, vehicleId: pairing.vehicleId, driverId: pairing.driverId, status: "pin_required" });
          return res.status(401).json({ ok: false, error: "PIN_REQUIRED", message: "Driver PIN required to claim this pairing.", ...(debugMode ? { debug: { route: req.path } } : {}) });
        }
        if (!timingSafeEquals(input.driverPin, pairing.driverPin)) {
          log("[PAIR-CLAIM] pin_mismatch", { pairingId: pairing.id, deviceId: input.deviceId });
          pushPairingDebug(pairingDebug.claims, { time: nowIso(), orgId: pairing.orgId, pairId: pairing.id, vehicleId: pairing.vehicleId, driverId: pairing.driverId, status: "pin_mismatch" });
          return res.status(401).json({ ok: false, error: "PIN_INVALID", message: "Driver PIN does not match.", ...(debugMode ? { debug: { route: req.path } } : {}) });
        }
      }
      if (pairing.status === "active") {
        if (pairing.deviceId && pairing.deviceId !== input.deviceId) {
          log("[PAIR-CLAIM] already_claimed", { pairingId: pairing.id, deviceId: input.deviceId, existingDeviceId: pairing.deviceId });
          pushPairingDebug(pairingDebug.claims, { time: nowIso(), orgId: pairing.orgId, pairId: pairing.id, vehicleId: pairing.vehicleId, driverId: pairing.driverId, status: "already_claimed" });
          return res.status(409).json({ ok: false, error: "ALREADY_CLAIMED", message: "Pairing code already claimed by another device", conflict: { assignmentId: pairing.id, status: pairing.status }, ...(debugMode ? { debug: { route: req.path } } : {}) });
        }
        const recovered = pairing.deviceId ? pairing : await db.updatePairing(pairing.id, {
          deviceId: input.deviceId,
          deviceLabel: input.deviceName || pairing.deviceLabel || `Tablet-${input.deviceId.slice(-4) || "UNK"}`
        });
        const deviceToken = await db.issueDeviceToken(recovered.id);
        const [vehicle, driver] = await Promise.all([db.getVehicleByVehicleId(recovered.vehicleId), db.getDriverByDriverId(recovered.driverId)]);
        pushPairingDebug(pairingDebug.claims, { time: nowIso(), orgId: recovered.orgId, pairId: recovered.id, vehicleId: recovered.vehicleId, driverId: recovered.driverId, status: "same_device_recovered" });
        return res.json(pairingClaimPayload(recovered, { ...input, route: req.path }, deviceToken, vehicle, driver, debugMode));
      }
      if (pairing.status && pairing.status !== "pending") {
        log("[PAIR-CLAIM] status_invalid", { pairingId: pairing.id, deviceId: input.deviceId, status: pairing.status });
        pushPairingDebug(pairingDebug.claims, { time: nowIso(), orgId: pairing.orgId, pairId: pairing.id, vehicleId: pairing.vehicleId, driverId: pairing.driverId, status: pairing.status });
        return res.status(409).json({ ok: false, error: "PAIRING_CODE_ALREADY_CLAIMED", message: "Pairing code already used", legacyError: "Code already used", ...(debugMode ? { debug: { normalized: input } } : {}) });
      }
      const fallbackLabel = `Tablet-${input.deviceId.slice(-4) || "UNK"}`;
      const deviceLabel = input.deviceName || pairing.deviceLabel || fallbackLabel;
      const updated = await db.updatePairing(pairing.id, {
        status: "active",
        deviceId: input.deviceId,
        deviceLabel,
        claimedAt: nowIso()
      });
      log("[PAIR-CLAIM] success", { pairingId: updated.id, deviceId: updated.deviceId });
      pushPairingDebug(pairingDebug.claims, { time: nowIso(), orgId: updated.orgId, pairId: updated.id, vehicleId: updated.vehicleId, driverId: updated.driverId, status: updated.status });
      // Issue the device session token. The raw value is returned only to the
      // claiming tablet; only its hash is persisted. A same-device recovery
      // mints a replacement and invalidates the previous token.
      const deviceToken = await db.issueDeviceToken(updated.id);
      const [vehicle, driver] = await Promise.all([db.getVehicleByVehicleId(updated.vehicleId), db.getDriverByDriverId(updated.driverId)]);
      res.json(pairingClaimPayload(updated, { ...input, route: req.path }, deviceToken, vehicle, driver, debugMode));
    } catch (err) {
      next(err);
    }
  }

  // Route name says "active" but this has always meant "pending" — preserved
  // as-is (see db.js listPendingUnexpiredPairings for the full explanation).
  async function handlePairingsActive(req, res, next) {
    try {
      const actingOrgId = customerOrgId(req);
      const activePairings = await db.listPendingUnexpiredPairings();
      const scoped = actingOrgId ? activePairings.filter((pairing) => pairing.orgId === actingOrgId) : activePairings;
      res.json(scoped.map(publicPairingView));
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
      const actingOrgId = customerOrgId(req);
      const active = await db.listClaimedActivePairings();
      const scopedActive = actingOrgId ? active.filter((pairing) => pairing.orgId === actingOrgId) : active;
      const sanitizeDebugEntry = (entry) => ({
        time: entry.time,
        orgId: entry.orgId,
        vehicleId: entry.vehicleId,
        driverId: entry.driverId,
        pairId: entry.pairId,
        status: entry.status,
        expiresAt: entry.expiresAt
      });
      const scopeDebug = (entries) => entries
        .filter((entry) => !actingOrgId || entry.orgId === actingOrgId)
        .map(sanitizeDebugEntry);
      res.json({ ok: true, generated: scopeDebug(pairingDebug.generated), claims: scopeDebug(pairingDebug.claims), active: scopedActive.map(publicPairingView) });
    } catch (err) {
      res.status(500).json({ ok: false, error: "debug_error", message: err?.message || String(err) });
    }
  });

  // These three are aliases of the SAME privileged handler as /api/pair-code
  // below and were registered with no auth at all: an unauthenticated caller
  // could mint a pairing code for any vehicle+driver and read the driver PIN
  // straight out of the response. Verified by probe: /api/pair-code returned
  // 401 while these reached the database and returned 404.
  app.post("/pairings/generate", requireEmployeeOrCustomerApi, handlePairingGenerate);
  app.post("/api/pairings/generate", requireEmployeeOrCustomerApi, handlePairingGenerate);
  app.post("/api/pairing/generate", requireEmployeeOrCustomerApi, handlePairingGenerate);
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

  // Returned pending pairings — pairing code AND driver PIN included — with no
  // credentials. Operator-only now.
  app.get("/pairings/active", requireEmployeeOrCustomerApi, handlePairingsActive);
  app.get("/api/pairings/active", requireEmployeeOrCustomerApi, handlePairingsActive);

  async function handleDriverLogin(req, res, next) {
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
      // The token returned here used to be a fresh random string that was
      // never stored and never verified — the Android client sent it as a
      // bearer token and no route checked it. It is now a real device session
      // bound to this pairing, so it can actually authorise later requests.
      // Requires the pairing to be claimed; PIN alone does not grant a session.
      if (pairing.status !== "active") {
        return res.status(409).json({
          error: "DEVICE_NOT_PAIRED",
          message: "Claim the pairing code on this device before signing in."
        });
      }
      const token = await db.issueDeviceToken(pairing.id);
      res.json({
        tenantId: resolvedTenantId,
        driverId: driver.driverId,
        vehicleId: pairing.vehicleId,
        pairingCode: pairing.pairingCode,
        token,
        driverName: driverDisplayName(driver) || driver.driverId
      });
    } catch (err) {
      next(err);
    }
  }

  // Both aliases register the same handler directly. This previously mutated
  // req.url and called app.handle() to re-enter the router, which re-ran the
  // ENTIRE middleware stack for the second path — including pairingClaimLimiter,
  // so a single login consumed two of the caller's ten allowed attempts per
  // minute and could rate-limit a legitimate driver at half the intended
  // threshold.
  app.post("/auth/driverLogin", pairingClaimLimiter, handleDriverLogin);
  app.post("/api/auth/driverLogin", pairingClaimLimiter, handleDriverLogin);

  app.post("/api/pairing/create", requireEmployeeOrCustomerApi, async (req, res, next) => {
    const { vehicleId, driverId } = req.body || {};
    if (!vehicleId || !driverId) return res.status(400).json({ error: "vehicleId and driverId required" });
    try {
      const targets = await loadPairingTargets(req, res, vehicleId, driverId);
      if (!targets) return;
      const pairingCode = await allocateUniquePairingCode();
      const fields = createPairingFields({ vehicleId, driverId, orgId: targets.orgId, pairingCode });
      const pairing = await db.createPairing(fields);
      res.json({ ok: true, pairingId: pairing.id, pairingCode: pairing.pairingCode, driverPin: pairing.driverPin, expiresAt: pairing.expiresAt });
    } catch (err) {
      next(err);
    }
  });

  // REMOVED: POST /api/pairing/activate
  //
  // This was an unauthenticated second door onto the same state transition as
  // /api/pairings/claim — it took a pairing code plus a deviceId and flipped
  // the pairing to "active" WITHOUT ever checking the driver PIN, while the
  // claim handler carefully enforces it (401 PIN_REQUIRED / PIN_INVALID). Any
  // party holding only a pairing code could bypass the PIN entirely by calling
  // this route instead, which made the PIN decorative.
  //
  // Devices must use POST /api/pairings/claim, which validates the PIN, is rate
  // limited, and now issues a device session token. No client in this repo
  // referenced /api/pairing/activate (tablet and Android both claim), so this
  // is a removal rather than a redirect.

  // Operator-facing pairing status. Was unauthenticated and returned the whole
  // pairing row, which includes driverPin (see rowToPairing in server/db.js) —
  // anyone who could guess a vehicleId could read that truck's driver PIN.
  // Now operator-gated AND stripped to non-secret fields.
  app.get("/api/pairing/status", requireEmployeeOrCustomerApi, async (req, res, next) => {
    try {
      const vehicleId = sanitizeString(req.query.vehicleId || "", 80);
      const vehicle = await db.getVehicleByVehicleId(vehicleId);
      if (!vehicle) return res.status(404).json({ ok: false, error: "vehicle_not_found" });
      if (denyCustomerOrgMismatch(req, res, vehicle.orgId)) return;
      const pairing = await db.getActivePairingForVehicle(vehicleId);
      res.json({ ok: true, pairing: publicPairingView(pairing) });
    } catch (err) {
      next(err);
    }
  });

  return { pairingDebug };
}

module.exports = {
  registerLegacyPairingRoutes
};
