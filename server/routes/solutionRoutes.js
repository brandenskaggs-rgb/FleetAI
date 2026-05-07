function registerSolutionRoutes(app, deps) {
  const {
    readData,
    writeData,
    sanitizeString,
    parseNumberField,
    nowIso,
    makeId,
    addAudit,
    requireEmployeeOrCustomerApi
  } = deps;

  function ensureCollections(data) {
    data.vehicles = Array.isArray(data.vehicles) ? data.vehicles : [];
    data.drivers = Array.isArray(data.drivers) ? data.drivers : [];
    data.dvirRecords = Array.isArray(data.dvirRecords) ? data.dvirRecords : [];
    data.dispatchJobs = Array.isArray(data.dispatchJobs) ? data.dispatchJobs : [];
    data.parts = Array.isArray(data.parts) ? data.parts : [];
    return data;
  }

  function resolveRequestOrgId(req, data) {
    const customerOrgId = sanitizeString(req.customer?.orgId || "", 80);
    const routeOrgId = sanitizeString(req.params?.orgId || "", 80);
    const bodyOrgId = sanitizeString(req.body?.orgId || req.query?.orgId || "", 80);
    if (customerOrgId || routeOrgId || bodyOrgId) return customerOrgId || routeOrgId || bodyOrgId;

    const customerUserId = sanitizeString(req.customer?.userId || "", 80);
    if (customerUserId && Array.isArray(data?.users)) {
      const user = data.users.find((u) => sanitizeString(u?.id || "", 80) === customerUserId);
      const userOrgId = sanitizeString(user?.orgId || "", 80);
      if (userOrgId) return userOrgId;
    }
    return "";
  }

  function matchesOrg(item, orgId) {
    return !orgId || sanitizeString(item?.orgId || "", 80) === orgId;
  }

  function findVehicle(data, orgId, vehicleId) {
    const id = sanitizeString(vehicleId || "", 80);
    if (!id) return null;
    return data.vehicles.find((v) => matchesOrg(v, orgId) && (v.vehicleId === id || v.id === id)) || null;
  }

  function findDriver(data, orgId, driverId) {
    const id = sanitizeString(driverId || "", 80);
    if (!id) return null;
    return data.drivers.find((d) => matchesOrg(d, orgId) && (d.driverId === id || d.id === id)) || null;
  }

  function personName(driver) {
    return [driver?.firstName, driver?.lastName].filter(Boolean).join(" ").trim();
  }

  function parseDateValue(value) {
    const raw = sanitizeString(value || "", 80);
    if (!raw) return nowIso();
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? nowIso() : parsed.toISOString();
  }

  function normalizeStatus(value, allowed, fallback) {
    const raw = sanitizeString(value || "", 40).toLowerCase().replace(/\s+/g, "_");
    return allowed.includes(raw) ? raw : fallback;
  }

  function summarizeDvir(records) {
    const now = Date.now();
    const last24h = records.filter((record) => {
      const ts = new Date(record.submittedAt || record.inspectedAt || 0).getTime();
      return Number.isFinite(ts) && now - ts <= 24 * 60 * 60 * 1000;
    });
    const withDefects = records.filter((record) => record.defectStatus === "defects_noted" || sanitizeString(record.defects || "", 1000));
    const lastSubmittedAt = records
      .map((record) => record.submittedAt || record.inspectedAt || "")
      .filter(Boolean)
      .sort()
      .reverse()[0] || null;
    const compliancePct = records.length ? Math.max(0, Math.round(((records.length - withDefects.length) / records.length) * 100)) : 0;
    return {
      total: records.length,
      last24h: last24h.length,
      withDefects: withDefects.length,
      satisfactory: records.length - withDefects.length,
      compliancePct,
      lastSubmittedAt
    };
  }

  function partStatus(part) {
    const qty = Number(part.quantityOnHand || 0);
    const reorderAt = Number(part.reorderAt || 0);
    return qty <= reorderAt ? "reorder" : "ok";
  }

  app.get("/api/dvir", requireEmployeeOrCustomerApi, async (req, res, next) => {
    try {
      const data = ensureCollections(await readData());
      const orgId = resolveRequestOrgId(req, data);
      if (!orgId) return res.status(400).json({ error: "orgId required" });

      const vehicleId = sanitizeString(req.query.vehicleId || "", 80);
      const driverId = sanitizeString(req.query.driverId || "", 80);
      const type = sanitizeString(req.query.type || "", 20);
      const limit = Math.min(Math.max(parseNumberField(req.query.limit, 100) || 100, 1), 500);
      let records = data.dvirRecords.filter((record) => matchesOrg(record, orgId));
      if (vehicleId) records = records.filter((record) => record.vehicleId === vehicleId);
      if (driverId) records = records.filter((record) => record.driverId === driverId);
      if (type) records = records.filter((record) => record.type === type);
      records = records
        .slice()
        .sort((a, b) => new Date(b.submittedAt || 0) - new Date(a.submittedAt || 0))
        .slice(0, limit);
      res.json({ ok: true, data: records });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/dvir", requireEmployeeOrCustomerApi, async (req, res, next) => {
    try {
      const data = ensureCollections(await readData());
      const orgId = resolveRequestOrgId(req, data);
      if (!orgId) return res.status(400).json({ error: "orgId required" });

      const vehicleId = sanitizeString(req.body?.vehicleId || req.body?.vehicle || "", 80);
      const driverId = sanitizeString(req.body?.driverId || req.body?.driver || "", 80);
      const vehicle = findVehicle(data, orgId, vehicleId);
      const driver = findDriver(data, orgId, driverId);
      if (!vehicle) return res.status(400).json({ error: "Valid vehicleId required" });
      if (!driver) return res.status(400).json({ error: "Valid driverId required" });

      const inspectedItems = Array.isArray(req.body?.inspectedItems)
        ? req.body.inspectedItems.map((item) => sanitizeString(item, 120)).filter(Boolean)
        : [];
      const signature = sanitizeString(req.body?.signature || "", 160);
      if (!signature) return res.status(400).json({ error: "signature required" });
      if (!inspectedItems.length) return res.status(400).json({ error: "At least one inspected item required" });

      const record = {
        id: makeId("DVIR"),
        orgId,
        vehicleId,
        vehicleLabel: sanitizeString(vehicle.unitName || vehicle.vehicleId || vehicleId, 160),
        driverId,
        driverLabel: personName(driver) || driver.driverId || driverId,
        type: normalizeStatus(req.body?.type, ["pre", "post"], "pre"),
        odometer: parseNumberField(req.body?.odometer, null),
        inspectedAt: parseDateValue(req.body?.inspectedAt || req.body?.dateTime),
        inspectedItems,
        defects: sanitizeString(req.body?.defects || req.body?.notes || "", 2000),
        defectStatus: sanitizeString(req.body?.defects || req.body?.notes || "", 2000) ? "defects_noted" : "satisfactory",
        signature,
        submittedAt: nowIso()
      };
      data.dvirRecords.push(record);
      addAudit(data, "DVIR_SUBMITTED", `${record.vehicleId}:${record.type}`);
      await writeData(data);
      res.status(201).json({ ok: true, data: record });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/dispatch/jobs", requireEmployeeOrCustomerApi, async (req, res, next) => {
    try {
      const data = ensureCollections(await readData());
      const orgId = resolveRequestOrgId(req, data);
      if (!orgId) return res.status(400).json({ error: "orgId required" });
      const status = sanitizeString(req.query.status || "", 40);
      let jobs = data.dispatchJobs.filter((job) => matchesOrg(job, orgId));
      if (status) jobs = jobs.filter((job) => job.status === status);
      jobs = jobs.slice().sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
      res.json({ ok: true, data: jobs });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/dispatch/jobs", requireEmployeeOrCustomerApi, async (req, res, next) => {
    try {
      const data = ensureCollections(await readData());
      const orgId = resolveRequestOrgId(req, data);
      if (!orgId) return res.status(400).json({ error: "orgId required" });

      const origin = sanitizeString(req.body?.origin || "", 240);
      const destination = sanitizeString(req.body?.destination || "", 240);
      if (!origin || !destination) return res.status(400).json({ error: "origin and destination required" });

      const vehicleId = sanitizeString(req.body?.vehicleId || "", 80);
      const driverId = sanitizeString(req.body?.driverId || "", 80);
      const vehicle = vehicleId ? findVehicle(data, orgId, vehicleId) : null;
      const driver = driverId ? findDriver(data, orgId, driverId) : null;
      if (vehicleId && !vehicle) return res.status(400).json({ error: "Valid vehicleId required" });
      if (driverId && !driver) return res.status(400).json({ error: "Valid driverId required" });

      const jobId = sanitizeString(req.body?.jobId || "", 80) || makeId("JOB");
      if (data.dispatchJobs.some((job) => matchesOrg(job, orgId) && job.jobId === jobId)) {
        return res.status(409).json({ error: "Dispatch job already exists" });
      }
      const job = {
        id: makeId("DSP"),
        jobId,
        orgId,
        vehicleId: vehicleId || "",
        vehicleLabel: vehicle ? sanitizeString(vehicle.unitName || vehicle.vehicleId || vehicleId, 160) : "",
        driverId: driverId || "",
        driverLabel: driver ? personName(driver) || driver.driverId || driverId : "",
        origin,
        destination,
        status: normalizeStatus(req.body?.status, ["scheduled", "assigned", "in_progress", "delivered", "cancelled"], "scheduled"),
        eta: parseDateValue(req.body?.eta),
        cargoWeight: parseNumberField(req.body?.cargoWeight, null),
        deliveryStatus: normalizeStatus(req.body?.deliveryStatus, ["pending", "loaded", "in_transit", "delivered"], "pending"),
        notes: sanitizeString(req.body?.notes || "", 1200),
        createdAt: nowIso(),
        updatedAt: nowIso()
      };
      data.dispatchJobs.push(job);
      addAudit(data, "DISPATCH_JOB_CREATED", job.jobId);
      await writeData(data);
      res.status(201).json({ ok: true, data: job });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/parts", requireEmployeeOrCustomerApi, async (req, res, next) => {
    try {
      const data = ensureCollections(await readData());
      const orgId = resolveRequestOrgId(req, data);
      if (!orgId) return res.status(400).json({ error: "orgId required" });
      const parts = data.parts
        .filter((part) => matchesOrg(part, orgId))
        .map((part) => Object.assign({}, part, { status: partStatus(part) }))
        .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
      res.json({ ok: true, data: parts, reorderAlerts: parts.filter((part) => part.status === "reorder") });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/parts", requireEmployeeOrCustomerApi, async (req, res, next) => {
    try {
      const data = ensureCollections(await readData());
      const orgId = resolveRequestOrgId(req, data);
      if (!orgId) return res.status(400).json({ error: "orgId required" });

      const partNumber = sanitizeString(req.body?.partNumber || "", 80).toUpperCase();
      const name = sanitizeString(req.body?.name || "", 180);
      if (!partNumber || !name) return res.status(400).json({ error: "partNumber and name required" });
      if (data.parts.some((part) => matchesOrg(part, orgId) && sanitizeString(part.partNumber || "", 80).toUpperCase() === partNumber)) {
        return res.status(409).json({ error: "Part number already exists" });
      }

      const part = {
        id: makeId("PART"),
        orgId,
        partNumber,
        name,
        quantityOnHand: Math.max(0, parseNumberField(req.body?.quantityOnHand ?? req.body?.qty, 0) || 0),
        reorderAt: Math.max(0, parseNumberField(req.body?.reorderAt, 0) || 0),
        vendor: sanitizeString(req.body?.vendor || "", 180),
        lastOrderedAt: req.body?.lastOrderedAt ? parseDateValue(req.body.lastOrderedAt) : null,
        notes: sanitizeString(req.body?.notes || "", 800),
        createdAt: nowIso(),
        updatedAt: nowIso()
      };
      data.parts.push(part);
      addAudit(data, "PART_CREATED", part.partNumber);
      await writeData(data);
      res.status(201).json({ ok: true, data: Object.assign({}, part, { status: partStatus(part) }) });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/dot-compliance", requireEmployeeOrCustomerApi, async (req, res, next) => {
    try {
      const data = ensureCollections(await readData());
      const orgId = resolveRequestOrgId(req, data);
      if (!orgId) return res.status(400).json({ error: "orgId required" });
      const dvirRecords = data.dvirRecords.filter((record) => matchesOrg(record, orgId));
      const dvir = summarizeDvir(dvirRecords);
      const violations = dvir.withDefects
        ? [{ id: "DVIR_DEFECTS", type: "dvir", severity: "warning", message: `${dvir.withDefects} DVIR record(s) include defects.`, count: dvir.withDefects }]
        : [];
      res.json({
        ok: true,
        data: {
          dvir,
          hos: { status: "not_connected", violations: [], message: "HOS data is not connected yet." },
          violations
        }
      });
    } catch (err) {
      next(err);
    }
  });
}

module.exports = {
  registerSolutionRoutes
};
