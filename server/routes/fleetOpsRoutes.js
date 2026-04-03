function registerFleetOpsRoutes(app, deps) {
  const {
    readData,
    writeData,
    sanitizeString,
    parseNumberField,
    nowIso,
    makeId,
    generateDigits,
    addAudit,
    requireEmployeeOrCustomerApi,
    resolveOrgIdForVehicle,
    telemetryLatest,
    telemetrySubscribers,
    getTelemetryLastSeen,
    getTelemetryState,
    triggerTelemetryPipeline,
    storeNormalizedSnapshot,
    normalizeMetrics
  } = deps;

  function resolveRequestOrgId(req) {
    const customerOrgId = sanitizeString(req.customer?.orgId || "", 80);
    const routeOrgId = sanitizeString(req.params?.orgId || "", 80);
    const bodyOrgId = sanitizeString(req.body?.orgId || req.query?.orgId || "", 80);
    return customerOrgId || routeOrgId || bodyOrgId;
  }

  function ensureFleetCollections(data) {
    data.vehicles = Array.isArray(data.vehicles) ? data.vehicles : [];
    data.drivers = Array.isArray(data.drivers) ? data.drivers : [];
    data.pairings = Array.isArray(data.pairings) ? data.pairings : [];
    return data;
  }

  async function handleListVehicles(req, res, next) {
    try {
      const data = ensureFleetCollections(await readData());
      const orgId = resolveRequestOrgId(req);
      const vehicles = orgId
        ? (data.vehicles || []).filter((v) => (v.orgId || "") === orgId)
        : (data.vehicles || []);
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
      const data = ensureFleetCollections(await readData());
      const normalizedOrgId = resolveRequestOrgId(req);
      if (!normalizedOrgId) {
        return res.status(400).json({ error: "orgId required" });
      }
      const exists = (data.vehicles || []).some((v) => v.vehicleId === vehicleId);
      if (exists) {
        return res.status(409).json({ error: "Vehicle already exists" });
      }
      const vehicle = {
        id: makeId("VEH"),
        vehicleId,
        unitName,
        vin,
        type,
        orgId: normalizedOrgId,
        year: parseNumberField(req.body?.year, null),
        make: sanitizeString(req.body?.make || "", 80),
        model: sanitizeString(req.body?.model || "", 80),
        createdAt: nowIso()
      };
      data.vehicles.push(vehicle);
      addAudit(data, "VEHICLE_CREATED", vehicle.vehicleId || vehicle.id || "vehicle");
      await writeData(data);
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
      const data = await readData();
      const orgId = sanitizeString(req.params.orgId || "", 80);
      const vehicleId = sanitizeString(req.params.vehicleId || "", 80);
      const idx = (data.vehicles || []).findIndex((v) => (v.vehicleId === vehicleId || v.id === vehicleId) && (!orgId || !v.orgId || v.orgId === orgId));
      if (idx < 0) return res.status(404).json({ error: "Vehicle not found" });
      const [removed] = data.vehicles.splice(idx, 1);
      addAudit(data, "VEHICLE_DELETED", removed.vehicleId || removed.id || vehicleId);
      await writeData(data);
      return res.json({ ok: true, data: removed });
    } catch (err) {
      next(err);
    }
  }

  async function handleListDrivers(req, res, next) {
    try {
      const data = ensureFleetCollections(await readData());
      const orgId = resolveRequestOrgId(req);
      const drivers = orgId
        ? (data.drivers || []).filter((d) => (d.orgId || "") === orgId)
        : (data.drivers || []);
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
      const data = ensureFleetCollections(await readData());
      const normalizedOrgId = resolveRequestOrgId(req);
      if (!normalizedOrgId) {
        return res.status(400).json({ error: "orgId required" });
      }
      const id = sanitizeString(req.body?.driverId || "", 80) || `DRIVER_${generateDigits(5)}`;
      if ((data.drivers || []).some((d) => d.driverId === id)) {
        return res.status(409).json({ error: "Driver already exists" });
      }
      const driver = {
        id: makeId("DRV"),
        driverId: id,
        orgId: normalizedOrgId,
        firstName,
        lastName,
        phone,
        createdAt: nowIso()
      };
      data.drivers.push(driver);
      addAudit(data, "DRIVER_CREATED", driver.driverId || driver.id || id);
      await writeData(data);
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
      const data = await readData();
      const orgId = sanitizeString(req.params.orgId || "", 80);
      const driverId = sanitizeString(req.params.driverId || "", 80);
      const idx = (data.drivers || []).findIndex((d) => (d.driverId === driverId || d.id === driverId) && (!orgId || !d.orgId || d.orgId === orgId));
      if (idx < 0) return res.status(404).json({ error: "Driver not found" });
      const [removed] = data.drivers.splice(idx, 1);
      addAudit(data, "DRIVER_DELETED", removed.driverId || removed.id || driverId);
      await writeData(data);
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
      const data = await readData();
      const orgId = sanitizeString(req.params.orgId || "", 80);
      const org = (data.orgs || []).find((item) => String(item.id || "") === orgId);
      res.json({ ok: true, data: { orgId, name: org?.name || "", status: org?.status || "unknown" } });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/pairing/options", async (req, res, next) => {
    try {
      const data = await readData();
      const orgId = sanitizeString(req.query.orgId || "", 80);
      const vehicles = orgId ? (data.vehicles || []).filter((v) => (v.orgId || "") === orgId) : (data.vehicles || []);
      const drivers = orgId ? (data.drivers || []).filter((d) => (d.orgId || "") === orgId) : (data.drivers || []);
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
