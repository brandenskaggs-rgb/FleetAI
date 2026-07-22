const db = require("../db");

function registerFleetOpsRoutes(app, deps) {
  const {
    readData,
    sanitizeString,
    parseNumberField,
    nowIso,
    generateDigits,
    requireEmployeeOrCustomerApi,
    telemetryLatest,
    telemetrySubscribers,
    getTelemetryLastSeen,
    getTelemetryState,
    triggerTelemetryPipeline,
    storeNormalizedSnapshot,
    normalizeMetrics
  } = deps;

  // Resolves the acting org for a request: explicit orgId (session/route/body/query)
  // wins; otherwise falls back to the logged-in user's own orgId from Postgres.
  async function resolveRequestOrgId(req) {
    const customerOrgId = sanitizeString(req.customer?.orgId || "", 80);
    const routeOrgId = sanitizeString(req.params?.orgId || "", 80);
    const bodyOrgId = sanitizeString(req.body?.orgId || req.query?.orgId || "", 80);
    if (customerOrgId || routeOrgId || bodyOrgId) {
      return customerOrgId || routeOrgId || bodyOrgId;
    }
    const customerUserId = sanitizeString(req.customer?.userId || "", 80);
    if (customerUserId) {
      const user = await db.getUserById(customerUserId);
      if (user?.orgId) return user.orgId;
    }
    return "";
  }

  async function handleListVehicles(req, res, next) {
    try {
      const orgId = await resolveRequestOrgId(req);
      const vehicles = await db.listVehicles({ orgId: orgId || undefined });
      if (req.path.startsWith("/api/orgs/")) {
        return res.json({ ok: true, data: vehicles });
      }
      return res.json(vehicles);
    } catch (err) {
      next(err);
    }
  }

  async function handleCreateVehicle(req, res, next) {
    const { vehicleId, unitName, vin, type } = req.body || {};
    if (!vehicleId || !unitName || !vin || !type) {
      return res.status(400).json({ error: "vehicleId, unitName, vin, type required" });
    }
    try {
      const normalizedOrgId = await resolveRequestOrgId(req);
      if (!normalizedOrgId) {
        return res.status(400).json({ error: "orgId required" });
      }
      const existing = await db.getVehicleByVehicleId(vehicleId);
      if (existing) {
        return res.status(409).json({ error: "Vehicle already exists" });
      }
      const vehicle = await db.createVehicle({
        vehicleId,
        unitName,
        vin,
        type,
        orgId: normalizedOrgId,
        year: parseNumberField(req.body?.year, null),
        make: sanitizeString(req.body?.make || "", 80),
        model: sanitizeString(req.body?.model || "", 80)
      });
      await db.logAudit({ orgId: normalizedOrgId, event: "VEHICLE_CREATED", detail: vehicle.vehicleId });
      if (req.path.startsWith("/api/orgs/")) {
        return res.json({ ok: true, data: vehicle });
      }
      return res.json({ ok: true, data: vehicle });
    } catch (err) {
      next(err);
    }
  }

  async function handleDeleteVehicle(req, res, next) {
    try {
      const orgId = sanitizeString(req.params.orgId || "", 80);
      const vehicleId = sanitizeString(req.params.vehicleId || "", 80);
      const existing = await db.getVehicleByVehicleId(vehicleId);
      if (!existing || (orgId && existing.orgId && existing.orgId !== orgId)) {
        return res.status(404).json({ error: "Vehicle not found" });
      }
      const removed = await db.deleteVehicleByVehicleId(vehicleId);
      await db.logAudit({ orgId: existing.orgId, event: "VEHICLE_DELETED", detail: vehicleId });
      return res.json({ ok: true, data: removed });
    } catch (err) {
      next(err);
    }
  }

  async function handleListDrivers(req, res, next) {
    try {
      const orgId = await resolveRequestOrgId(req);
      const drivers = await db.listDrivers({ orgId: orgId || undefined });
      if (req.path.startsWith("/api/orgs/")) {
        return res.json({ ok: true, data: drivers });
      }
      return res.json(drivers);
    } catch (err) {
      next(err);
    }
  }

  async function handleCreateDriver(req, res, next) {
    const { firstName, lastName, phone } = req.body || {};
    if (!firstName || !lastName || !phone) {
      return res.status(400).json({ error: "firstName, lastName, phone required" });
    }
    try {
      const normalizedOrgId = await resolveRequestOrgId(req);
      if (!normalizedOrgId) {
        return res.status(400).json({ error: "orgId required" });
      }
      const id = sanitizeString(req.body?.driverId || "", 80) || `DRIVER_${generateDigits(5)}`;
      const existing = await db.getDriverByDriverId(id);
      if (existing) {
        return res.status(409).json({ error: "Driver already exists" });
      }
      const driver = await db.createDriver({
        driverId: id,
        orgId: normalizedOrgId,
        firstName,
        lastName,
        phone
      });
      await db.logAudit({ orgId: normalizedOrgId, event: "DRIVER_CREATED", detail: driver.driverId });
      if (req.path.startsWith("/api/orgs/")) {
        return res.json({ ok: true, data: driver });
      }
      return res.json({ ok: true, data: driver });
    } catch (err) {
      next(err);
    }
  }

  async function handleDeleteDriver(req, res, next) {
    try {
      const orgId = sanitizeString(req.params.orgId || "", 80);
      const driverId = sanitizeString(req.params.driverId || "", 80);
      const existing = await db.getDriverByDriverId(driverId);
      if (!existing || (orgId && existing.orgId && existing.orgId !== orgId)) {
        return res.status(404).json({ error: "Driver not found" });
      }
      const removed = await db.deleteDriverByDriverId(driverId);
      await db.logAudit({ orgId: existing.orgId, event: "DRIVER_DELETED", detail: driverId });
      return res.json({ ok: true, data: removed });
    } catch (err) {
      next(err);
    }
  }

  app.get("/vehicles", requireEmployeeOrCustomerApi, handleListVehicles);
  app.get("/api/vehicles", requireEmployeeOrCustomerApi, handleListVehicles);
  app.post("/vehicles/create", requireEmployeeOrCustomerApi, handleCreateVehicle);
  app.post("/api/vehicles/create", requireEmployeeOrCustomerApi, handleCreateVehicle);
  app.post("/api/vehicles", requireEmployeeOrCustomerApi, handleCreateVehicle);
  app.get("/api/orgs/:orgId/vehicles", requireEmployeeOrCustomerApi, handleListVehicles);
  app.post("/api/orgs/:orgId/vehicles", requireEmployeeOrCustomerApi, handleCreateVehicle);
  app.delete("/api/orgs/:orgId/vehicles/:vehicleId", requireEmployeeOrCustomerApi, handleDeleteVehicle);

  app.get("/drivers", requireEmployeeOrCustomerApi, handleListDrivers);
  app.get("/api/drivers", requireEmployeeOrCustomerApi, handleListDrivers);
  app.post("/drivers/create", requireEmployeeOrCustomerApi, handleCreateDriver);
  app.post("/api/drivers/create", requireEmployeeOrCustomerApi, handleCreateDriver);
  app.post("/api/drivers", requireEmployeeOrCustomerApi, handleCreateDriver);
  app.get("/api/orgs/:orgId/drivers", requireEmployeeOrCustomerApi, handleListDrivers);
  app.post("/api/orgs/:orgId/drivers", requireEmployeeOrCustomerApi, handleCreateDriver);
  app.delete("/api/orgs/:orgId/drivers/:driverId", requireEmployeeOrCustomerApi, handleDeleteDriver);

  app.get("/api/orgs/:orgId/public-profile", async (req, res, next) => {
    try {
      const orgId = sanitizeString(req.params.orgId || "", 80);
      const org = await db.getOrg(orgId);
      res.json({ ok: true, data: { orgId, name: org?.name || "", status: org?.status || "unknown" } });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/pairing/options", async (req, res, next) => {
    try {
      const orgId = sanitizeString(req.query.orgId || "", 80);
      const [vehicles, drivers] = await Promise.all([
        db.listVehicles({ orgId: orgId || undefined }),
        db.listDrivers({ orgId: orgId || undefined })
      ]);
      res.json({ ok: true, vehicles, drivers });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/telemetry/ingest", async (req, res, next) => {
    try {
      const payload = req.body || {};
      const vehicleId = sanitizeString(payload.vehicleId || payload.vehicle_id || "", 80);
      const metrics = normalizeMetrics(payload.metrics || payload.data || payload);
      const ts = payload.ts || nowIso();
      const snapshot = {
        vehicleId,
        driverId: sanitizeString(payload.driverId || payload.driver_id || "", 80),
        deviceId: sanitizeString(payload.deviceId || payload.device_id || "", 120),
        ts,
        metrics
      };
      if (vehicleId) {
        telemetryLatest.set(vehicleId, snapshot);
      }
      await storeNormalizedSnapshot({ vehicleId, driverId: snapshot.driverId, deviceId: snapshot.deviceId, ts, metrics });
      await triggerTelemetryPipeline({ vehicleId, driverId: snapshot.driverId, deviceId: snapshot.deviceId, ts, metrics });
      res.json({ ok: true, stored: true, snapshot });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/telemetry", async (req, res, next) => {
    try {
      const vehicleId = sanitizeString(req.query.vehicle_id || req.query.vehicleId || "", 80);
      if (!vehicleId) return res.status(400).json({ error: "vehicle_id required" });
      const cached = telemetryLatest.get(vehicleId);
      if (cached) return res.json(cached);
      const data = await readData();
      const snapshots = data.telemetrySnapshots || [];
      const snapshot = [...snapshots].reverse().find((snap) => snap.vehicleId === vehicleId) || {};
      res.json(snapshot);
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/telemetry/latest", async (req, res, next) => {
    try {
      const vehicleId = sanitizeString(req.query.vehicleId || req.query.vehicle_id || "", 80);
      if (vehicleId) {
        const cached = telemetryLatest.get(vehicleId);
        return res.json({ ok: true, data: cached || null });
      }
      const latest = Array.from(telemetryLatest.values()).sort((a, b) => new Date(b.ts || 0) - new Date(a.ts || 0));
      res.json({ ok: true, data: latest[0] || null, items: latest });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/telemetry/active", (req, res) => {
    const items = Array.from(telemetryLatest.values()).sort((a, b) => new Date(b.ts || 0) - new Date(a.ts || 0));
    res.json({ ok: true, data: items, count: items.length, lastSeen: getTelemetryLastSeen() });
  });

  app.get("/api/telemetry/health", (req, res) => {
    const state = getTelemetryState();
    res.json({ ok: true, status: state.status, lastSampleAt: state.lastSampleAt, ageMs: state.ageMs, subscribers: telemetrySubscribers.size });
  });

  app.get("/api/telemetry/stream", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      Connection: "keep-alive"
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ ok: true, now: nowIso() })}\n\n`);
    telemetrySubscribers.add(res);
    const heartbeat = setInterval(() => {
      try {
        res.write(`event: heartbeat\ndata: ${JSON.stringify({ ok: true, now: nowIso() })}\n\n`);
      } catch (_) {}
    }, 15000);
    req.on("close", () => {
      clearInterval(heartbeat);
      telemetrySubscribers.delete(res);
    });
  });
}

module.exports = {
  registerFleetOpsRoutes
};
