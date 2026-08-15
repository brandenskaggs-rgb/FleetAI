const db = require("../db");

const { requireOperatorOrDevice: buildOperatorOrDevice, requireDevice } = require("../middleware/deviceAuth");

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

  // Accepts either an operator session or a paired-device token.
  const requireOperatorOrDevice = buildOperatorOrDevice(requireEmployeeOrCustomerApi);

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

  function denyCustomerOrgMismatch(req, res, targetOrgId) {
    const customerOrgId = sanitizeString(req.customer?.orgId || "", 80);
    const normalizedTarget = sanitizeString(targetOrgId || "", 80);
    if (customerOrgId && (!normalizedTarget || customerOrgId !== normalizedTarget)) {
      res.status(403).json({ ok: false, error: "cross_org_access_denied" });
      return true;
    }
    return false;
  }

  async function telemetryItemsForRequest(req, items) {
    if (!req.customer?.orgId) return items;
    const customerOrgId = sanitizeString(req.customer.orgId, 80);
    const scoped = await Promise.all(items.map(async (item) => {
      const orgId = await db.getVehicleOrgId(item?.vehicleId, "").catch(() => "");
      return orgId === customerOrgId ? item : null;
    }));
    return scoped.filter(Boolean);
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
      if (denyCustomerOrgMismatch(req, res, existing.orgId)) return;
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
      if (denyCustomerOrgMismatch(req, res, existing.orgId)) return;
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

  app.get("/api/pairing/options", requireEmployeeOrCustomerApi, async (req, res, next) => {
    try {
      const orgId = await resolveRequestOrgId(req);
      if (!orgId && req.customer) return res.status(403).json({ ok: false, error: "org_scope_required" });
      const [vehicles, drivers] = await Promise.all([
        db.listVehicles({ orgId: orgId || undefined }),
        db.listDrivers({ orgId: orgId || undefined })
      ]);
      res.json({ ok: true, vehicles, drivers });
    } catch (err) {
      next(err);
    }
  });

  // Telemetry ingest. Was completely unauthenticated with no ownership check on
  // vehicleId, so anyone could inject fabricated readings for any truck — those
  // flow into triggerTelemetryPipeline and the ML scorer, which means an
  // attacker could manufacture alerts or, worse, mask a developing failure.
  //
  // A paired device now authenticates with its session token, and the vehicle
  // is taken FROM THE PAIRING, never from the request body: a device can only
  // ever report for the truck it was paired to. Operators may still ingest
  // (backfills, integrations) and for them the body value is honoured.
  app.post("/api/telemetry/ingest", requireOperatorOrDevice, async (req, res, next) => {
    try {
      const payload = req.body || {};
      const bodyVehicleId = sanitizeString(payload.vehicleId || payload.vehicle_id || "", 80);
      const vehicleId = req.device ? req.device.vehicleId : bodyVehicleId;
      if (!vehicleId) {
        return res.status(400).json({ ok: false, error: "vehicle_id required" });
      }
      if (req.device && bodyVehicleId && bodyVehicleId !== req.device.vehicleId) {
        return res.status(403).json({
          ok: false,
          error: "VEHICLE_MISMATCH",
          message: "This device is not paired to that vehicle."
        });
      }
      if (!req.device) {
        const vehicleOrgId = await db.getVehicleOrgId(vehicleId, "");
        if (denyCustomerOrgMismatch(req, res, vehicleOrgId)) return;
        const bodyDriverId = sanitizeString(payload.driverId || payload.driver_id || "", 80);
        if (bodyDriverId && req.customer) {
          const driver = await db.getDriverByDriverId(bodyDriverId);
          if (!driver || denyCustomerOrgMismatch(req, res, driver.orgId)) return;
        }
      }
      const metrics = normalizeMetrics(payload.metrics || payload.data || payload);
      // The Android tablet sends `timestamp`; only `ts` was read, so every
      // reading was stamped with server receive time instead of the moment it
      // came off the bus. Over a cellular link that is seconds of skew on data
      // whose whole value is when it happened.
      const ts = payload.ts || payload.timestamp || nowIso();
      const snapshot = {
        vehicleId,
        driverId: req.device
          ? (req.device.driverId || "")
          : sanitizeString(payload.driverId || payload.driver_id || "", 80),
        deviceId: req.device
          ? (req.device.deviceId || "")
          : sanitizeString(payload.deviceId || payload.device_id || "", 120),
        ts,
        metrics,
        // Link state from the tablet: lets the dashboard tell "reporting
        // normally" apart from "tablet online but OBD adapter unplugged",
        // which otherwise both look like silence.
        obdConnected: payload.obdConnected !== undefined ? Boolean(payload.obdConnected) : null,
        lastObdPacketAt: payload.lastObdPacketAt || null,
        protocol: sanitizeString(payload.protocol || "", 24) || null
      };
      if (vehicleId) {
        telemetryLatest.set(vehicleId, snapshot);
      }
      await storeNormalizedSnapshot({ vehicleId, driverId: snapshot.driverId, deviceId: snapshot.deviceId, ts, metrics });
      await triggerTelemetryPipeline({ vehicleId, driverId: snapshot.driverId, deviceId: snapshot.deviceId, ts, metrics });

      // Fan out to the fleet manager's dashboard in real time. Resolved from
      // the pairing for a device, otherwise looked up from the vehicle, so a
      // snapshot is only ever delivered inside its owning organisation.
      let snapshotOrgId = req.device ? (req.device.orgId || null) : null;
      if (!snapshotOrgId) {
        snapshotOrgId = await db.getVehicleOrgId(vehicleId).catch(() => null);
      }
      broadcastTelemetry(snapshot, snapshotOrgId);

      res.json({ ok: true, stored: true, snapshot });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/telemetry", requireOperatorOrDevice, async (req, res, next) => {
    try {
      const vehicleId = req.device
        ? req.device.vehicleId
        : sanitizeString(req.query.vehicle_id || req.query.vehicleId || "", 80);
      if (!vehicleId) return res.status(400).json({ error: "vehicle_id required" });
      if (!req.device) {
        const vehicleOrgId = await db.getVehicleOrgId(vehicleId, "");
        if (denyCustomerOrgMismatch(req, res, vehicleOrgId)) return;
      }
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

  // Was public. With no vehicleId it returned `items` = EVERY vehicle's latest
  // telemetry across ALL orgs — a cross-tenant leak in a multi-tenant product.
  // A device may only read its own vehicle; the fleet-wide listing is operator
  // only.
  app.get("/api/telemetry/latest", requireOperatorOrDevice, async (req, res, next) => {
    try {
      const requested = sanitizeString(req.query.vehicleId || req.query.vehicle_id || "", 80);
      if (req.device) {
        if (requested && requested !== req.device.vehicleId) {
          return res.status(403).json({ ok: false, error: "VEHICLE_MISMATCH" });
        }
        const own = telemetryLatest.get(req.device.vehicleId);
        return res.json({ ok: true, data: own || null });
      }
      if (requested) {
        const vehicleOrgId = await db.getVehicleOrgId(requested, "");
        if (denyCustomerOrgMismatch(req, res, vehicleOrgId)) return;
        const cached = telemetryLatest.get(requested);
        return res.json({ ok: true, data: cached || null });
      }
      const allLatest = Array.from(telemetryLatest.values()).sort((a, b) => new Date(b.ts || 0) - new Date(a.ts || 0));
      const latest = await telemetryItemsForRequest(req, allLatest);
      res.json({ ok: true, data: latest[0] || null, items: latest });
    } catch (err) {
      next(err);
    }
  });

  // Fleet-wide telemetry dump — operator only (was public).
  app.get("/api/telemetry/active", requireEmployeeOrCustomerApi, async (req, res, next) => {
    try {
      const allItems = Array.from(telemetryLatest.values()).sort((a, b) => new Date(b.ts || 0) - new Date(a.ts || 0));
      const items = await telemetryItemsForRequest(req, allItems);
      res.json({ ok: true, data: items, count: items.length, lastSeen: getTelemetryLastSeen() });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/telemetry/health", (req, res) => {
    const state = getTelemetryState();
    res.json({ ok: true, status: state.status, lastSampleAt: state.lastSampleAt, ageMs: state.ageMs, subscribers: telemetrySubscribers.size });
  });

  const historyMetricPaths = {
    rpm: ["engine.rpm", "rpm"],
    speed: ["vehicle.speedKph", "speedKph", "speed"],
    coolant_temp: ["engine.coolantTempC", "coolantTempC", "coolant_temp"],
    battery_voltage: ["electrical.batteryVoltageV", "batteryVoltageV", "battery_voltage"],
    engine_load: ["engine.engineLoadPct", "engineLoadPct", "engine_load"],
    fuel_level: ["fuel.fuelLevelPct", "fuelLevelPct", "fuel_level"]
  };

  function metricValue(metrics, paths) {
    for (const path of paths) {
      const value = path.split(".").reduce((current, key) => current == null ? undefined : current[key], metrics);
      if (value !== undefined && value !== null) return value;
    }
    return null;
  }

  async function handleTelemetryHistory(req, res, next) {
    try {
      const vehicleId = sanitizeString(req.params?.vehicleId || req.query.vehicleId || req.query.vehicle_id || "", 80);
      if (!vehicleId) return res.status(400).json({ ok: false, error: "vehicleId required" });
      const vehicleOrgId = await db.getVehicleOrgId(vehicleId, "");
      if (!vehicleOrgId) return res.status(404).json({ ok: false, error: "vehicle_not_found" });
      if (denyCustomerOrgMismatch(req, res, vehicleOrgId)) return;
      const metric = sanitizeString(req.query.metric || "rpm", 40);
      const paths = historyMetricPaths[metric];
      if (!paths) return res.status(400).json({ ok: false, error: "unsupported_metric" });
      const rangeMs = { "1h": 3600000, "6h": 21600000, "24h": 86400000, "7d": 604800000 }[req.query.range] || 86400000;
      const samples = await db.getSamplesForVehicle(vehicleId, { limit: 5000, since: new Date(Date.now() - rangeMs) });
      const data = samples.map((sample) => ({
        id: sample.id,
        vehicleId,
        timestamp: sample.ts,
        metric,
        value: metricValue(sample.metrics || {}, paths),
        quality: sample.raw?.quality || "normalized"
      })).filter((sample) => sample.value !== null);
      res.json({ ok: true, data });
    } catch (err) {
      next(err);
    }
  }

  app.get("/api/telemetry/history", requireEmployeeOrCustomerApi, handleTelemetryHistory);
  app.get("/api/vehicles/:vehicleId/metrics/history", requireEmployeeOrCustomerApi, handleTelemetryHistory);


  // Push a snapshot to every entitled live subscriber.
  //
  // This did not exist. /api/telemetry/stream added subscribers to the set and
  // sent them a hello plus a heartbeat every 15s, but NOTHING ever wrote
  // telemetry to them — so the dashboard connected, displayed "Connected", and
  // received only heartbeats forever. The tablet -> backend -> dashboard
  // real-time path terminated one hop short of the screen.
  //
  // Delivery is filtered by the scope captured at subscribe time, so a device
  // only ever receives its own vehicle and an operator only receives vehicles
  // belonging to their organisation.
  function broadcastTelemetry(snapshot, orgId) {
    if (!snapshot || !telemetrySubscribers.size) return;
    const frame = `data: ${JSON.stringify(snapshot)}\n\n`;
    for (const sub of telemetrySubscribers) {
      const scope = sub.__fleetScope;
      if (scope) {
        if (scope.kind === "device" && scope.vehicleId !== snapshot.vehicleId) continue;
        // An operator with no resolvable org sees nothing rather than
        // everything: failing closed is the correct default for a leak that
        // would otherwise be silent.
        if (scope.kind === "operator") {
          if (!scope.orgId) continue;
          if (orgId && scope.orgId !== orgId) continue;
          if (!orgId) continue;
        }
      } else {
        continue;
      }
      try {
        sub.write(frame);
      } catch (_) {
        telemetrySubscribers.delete(sub);
      }
    }
  }

  // SSE feed of all telemetry — was public, so anyone could subscribe to the
  // whole fleet in real time. EventSource cannot set headers, so the device
  // token may also arrive as ?deviceToken= (see middleware/deviceAuth.js).
  app.get("/api/telemetry/stream", requireOperatorOrDevice, (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      Connection: "keep-alive",
      // Proxies buffer text/event-stream by default, holding events until the
      // buffer fills — the stream looks connected and silent.
      "X-Accel-Buffering": "no"
    });
    if (typeof res.flushHeaders === "function") res.flushHeaders();

    // Scope the subscription. A device sees only the truck it is paired to; an
    // operator sees only their own organisation's vehicles. Without this the
    // feed is fleet-wide across every tenant — the same cross-tenant leak the
    // REST telemetry routes had.
    res.__fleetScope = req.device
      ? { kind: "device", vehicleId: req.device.vehicleId, orgId: req.device.orgId || null }
      : { kind: "operator", vehicleId: null, orgId: null };
    if (!req.device) {
      resolveRequestOrgId(req)
        .then((orgId) => { res.__fleetScope.orgId = orgId || null; })
        .catch(() => {});
    }

    res.write(`event: hello\ndata: ${JSON.stringify({ ok: true, now: nowIso(), scope: res.__fleetScope.kind })}\n\n`);
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
