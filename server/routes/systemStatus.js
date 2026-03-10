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
    isExpired
  } = deps;

  app.get("/health", async (req, res) => {
    res.status(200).json(await healthPayload(req));
  });

  app.get("/api/health", async (req, res) => {
    res.status(200).json(await healthPayload(req));
  });

  app.get("/api/auth/health", async (req, res) => {
    try {
      const data = await readData();
      const users = Array.isArray(data.users) ? data.users : [];
      const bootstrapAllowed = SETUP_ALLOWED && Boolean(SETUP_KEY);
      res.status(200).json({
        ok: true,
        usersLoaded: users.length,
        authStorePath: DATA_PATH,
        lastLoadedAt: getDataLoadStatus().lastDataLoadAt,
        dataLoadStatus: getDataLoadStatus().dataLoadStatus,
        dataLoadError: getDataLoadError(),
        bootstrapAllowed,
        emailExists: req.query?.email
          ? users.some((u) => String(u.email || "").toLowerCase() === String(req.query.email || "").toLowerCase())
          : undefined
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || "auth_health_error" });
    }
  });

  app.get("/version", (req, res) => {
    res.status(200).json({
      ok: true,
      version: deps.APP_VERSION,
      timestamp: new Date().toISOString()
    });
  });

  app.get("/whoami", (req, res) => {
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

  app.get("/api/system/watchdog", (req, res) => {
    const watchdogInstance = getWatchdogInstance();
    if (!watchdogInstance) {
      return res.json({ ok: false, error: "watchdog_not_started" });
    }
    return res.json({ ok: true, ...watchdogInstance.getState() });
  });

  app.get("/api/system/telemetry/status", (req, res) => {
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

  app.get("/api/system/pairing/status", async (req, res) => {
    try {
      const data = await readData();
      const pairings = Array.isArray(data.pairings) ? data.pairings : [];
      let lastPairCodeCreatedAt = null;
      let activeClaimsCount = 0;
      pairings.forEach((p) => {
        if (p?.createdAt) {
          if (!lastPairCodeCreatedAt || new Date(p.createdAt) > new Date(lastPairCodeCreatedAt)) {
            lastPairCodeCreatedAt = p.createdAt;
          }
        }
        if (p?.status === "active" && !isExpired(p.expiresAt)) activeClaimsCount += 1;
      });
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
}

module.exports = {
  registerSystemStatusRoutes
};
