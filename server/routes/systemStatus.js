const db = require("../db");

function registerSystemStatusRoutes(app, deps) {
  const {
    healthPayload,
    readData,
    DATA_PATH,
    SETUP_ALLOWED,
    SETUP_KEY,
    requireSuperAdmin,
    getDataLoadStatus,
    getDataLoadError,
    getDataLoadNote,
    getLastDataWriteAt,
    DATA_SCHEMA_VERSION,
    getWatchdogInstance,
    getTelemetryLastSeen,
    getTelemetryState,
    getTelemetryLatestSize,
    getTelemetryLatestEntries,
    nowIso,
    isExpired
  } = deps;

  function requireSystemDiagnostics(req, res, next) {
    const expected = String(deps.watchdogInternalToken || "");
    const presented = String(req.headers?.["x-fleetai-watchdog-token"] || "");
    if (expected && presented && expected.length === presented.length) {
      const crypto = require("crypto");
      if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(presented))) return next();
    }
    return requireSuperAdmin(req, res, next);
  }

  app.get("/health", async (req, res) => {
    res.status(200).json(await healthPayload());
  });

  app.get("/api/auth/health", async (req, res) => {
    try {
      await readData();
      res.status(200).json({
        ok: true,
        service: "auth",
        status: getDataLoadStatus().dataLoadStatus === "error" ? "degraded" : "ok"
      });
    } catch (err) {
      res.status(503).json({ ok: false, error: "auth_health_unavailable" });
    }
  });

  app.get("/version", (req, res) => {
    res.status(200).json({
      ok: true,
      version: deps.APP_VERSION,
      timestamp: new Date().toISOString()
    });
  });

  app.get("/whoami", requireSuperAdmin, (req, res) => {
    res.status(200).json({
      ip: req.ip,
      ips: req.ips,
      method: req.method,
      path: req.path,
      hostHeader: req.headers.host,
      userAgent: req.headers["user-agent"],
      origin: req.headers.origin,
      referer: req.headers.referer,
      headersSubset: {
        accept: req.headers.accept,
        "accept-language": req.headers["accept-language"],
        "x-forwarded-for": req.headers["x-forwarded-for"]
      }
    });
  });

  app.get("/api/admin/config-status", requireSuperAdmin, (req, res) => {
    res.json({
      ok: true,
      data: {
        status: getDataLoadStatus().dataLoadStatus,
        lastError: getDataLoadError(),
        note: getDataLoadNote(),
        lastWriteAt: getLastDataWriteAt()
      },
      schemaVersion: DATA_SCHEMA_VERSION,
      dataPath: DATA_PATH
    });
  });

  app.get("/api/system/watchdog", requireSystemDiagnostics, (req, res) => {
    const watchdogInstance = getWatchdogInstance();
    if (!watchdogInstance) {
      return res.json({ ok: false, error: "watchdog_not_started" });
    }
    return res.json({ ok: true, ...watchdogInstance.getState() });
  });

  app.get("/api/system/telemetry/status", requireSystemDiagnostics, (req, res) => {
    const telemetryLastSeen = getTelemetryLastSeen();
    const telemetryState = getTelemetryState();
    const lastTelemetryAt = telemetryLastSeen?.ts || telemetryState.lastSampleAt || null;
    const ageMs = lastTelemetryAt ? Date.now() - new Date(lastTelemetryAt).getTime() : null;
    res.json({
      ok: true,
      connectedDevicesCount: getTelemetryLatestSize(),
      lastTelemetryAt,
      telemetryRecent: ageMs !== null && ageMs < 30000,
      telemetryAgeMs: ageMs
    });
  });

  app.get("/api/system/pairing/status", requireSystemDiagnostics, async (req, res) => {
    try {
      const { lastPairCodeCreatedAt, activeClaimsCount } = await db.getPairingStatusSummary();
      res.json({
        ok: true,
        pairingEnabled: true,
        lastPairCodeCreatedAt,
        activeClaimsCount
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: "pairing_status_error" });
    }
  });

  function buildActiveStatusPayload() {
    const entries = Array.isArray(getTelemetryLatestEntries()) ? getTelemetryLatestEntries() : [];
    const now = Date.now();
    let latest = null;
    entries.forEach(([, snap]) => {
      if (!snap || !snap.ts) return;
      const ts = new Date(snap.ts).getTime();
      if (!ts) return;
      if (!latest || ts > latest.tsMs) {
        latest = {
          tsMs: ts,
          vehicleId: snap.vehicleId || null,
          driverId: snap.driverId || null,
          deviceId: snap.deviceId || null
        };
      }
    });
    const ageMs = latest ? now - latest.tsMs : null;
    return {
      ok: true,
      serverTime: nowIso(),
      serverUptimeSec: Math.round(process.uptime()),
      connected: ageMs !== null && ageMs < 10000,
      lastTelemetryAt: latest ? new Date(latest.tsMs).toISOString() : null,
      ageMs,
      source: "tablet",
      activePair: latest ? { connected: true, lastTelemetryAt: new Date(latest.tsMs).toISOString() } : null
    };
  }

  app.get("/api/active", (req, res) => {
    res.set({
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      Pragma: "no-cache",
      Expires: "0",
      "Surrogate-Control": "no-store",
      "Content-Type": "application/json"
    });
    res.json({ ok: true, service: "fleet-ai", status: "reachable" });
  });

  app.get("/active", (req, res) => {
    res.set({
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      Pragma: "no-cache",
      Expires: "0",
      "Surrogate-Control": "no-store",
      "Content-Type": "application/json"
    });
    res.json({ ok: true, service: "fleet-ai", status: "reachable" });
  });

  app.get("/api/system/active", requireSuperAdmin, (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(buildActiveStatusPayload());
  });
}

module.exports = {
  registerSystemStatusRoutes
};
