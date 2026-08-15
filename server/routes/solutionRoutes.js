const db = require("../db");

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

  // Vehicles/drivers moved to Prisma this session (see server/db.js) — the flat
  // file's data.vehicles/data.drivers are now permanently empty, so every route
  // below that used to read them from `data` needs them fetched here instead.
  // Unfiltered (all orgs) to match the flat file's old shape exactly; each
  // route already applies its own matchesOrg(item, orgId) filter downstream.
  async function ensureCollections(data) {
    data.vehicles = await db.listVehicles();
    data.drivers = await db.listDrivers();
    data.dvirRecords = Array.isArray(data.dvirRecords) ? data.dvirRecords : [];
    data.dispatchJobs = Array.isArray(data.dispatchJobs) ? data.dispatchJobs : [];
    data.parts = Array.isArray(data.parts) ? data.parts : [];
    data.fleetAddons = Array.isArray(data.fleetAddons) ? data.fleetAddons : [];
    data.addonQuoteRequests = Array.isArray(data.addonQuoteRequests) ? data.addonQuoteRequests : [];
    data.recommendations = Array.isArray(data.recommendations) ? data.recommendations : [];
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

  function denyCustomerOrgMismatch(req, res, targetOrgId) {
    const customerOrgId = sanitizeString(req.customer?.orgId || "", 80);
    const normalizedTarget = sanitizeString(targetOrgId || "", 80);
    if (customerOrgId && (!normalizedTarget || customerOrgId !== normalizedTarget)) {
      res.status(403).json({ ok: false, error: "cross_org_access_denied" });
      return true;
    }
    return false;
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

  function normalizeAddons(raw) {
    const out = {};
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
    Object.entries(raw).forEach(([key, value]) => {
      const addonId = sanitizeString(key || "", 80);
      if (addonId) out[addonId] = Boolean(value);
    });
    return out;
  }

  app.get("/api/fleet/addons", requireEmployeeOrCustomerApi, async (req, res, next) => {
    try {
      const data = await ensureCollections(await readData());
      const orgId = resolveRequestOrgId(req, data);
      if (!orgId) return res.status(400).json({ error: "orgId required" });
      const existing = data.fleetAddons.find((row) => matchesOrg(row, orgId));
      res.json({
        ok: true,
        enabledAddons: existing?.enabledAddons || {},
        trailerCount: Number(existing?.trailerCount || 0),
        updatedAt: existing?.updatedAt || null
      });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/fleet/addons", requireEmployeeOrCustomerApi, async (req, res, next) => {
    try {
      const data = await ensureCollections(await readData());
      const orgId = resolveRequestOrgId(req, data);
      if (!orgId) return res.status(400).json({ error: "orgId required" });
      const record = {
        orgId,
        enabledAddons: normalizeAddons(req.body?.enabledAddons),
        trailerCount: Math.max(0, parseNumberField(req.body?.trailerCount, 0) || 0),
        updatedAt: nowIso()
      };
      const idx = data.fleetAddons.findIndex((row) => matchesOrg(row, orgId));
      if (idx >= 0) {
        data.fleetAddons[idx] = Object.assign({}, data.fleetAddons[idx], record);
      } else {
        data.fleetAddons.push(Object.assign({ id: makeId("ADDON"), createdAt: nowIso() }, record));
      }
      addAudit(data, "FLEET_ADDONS_UPDATED", orgId);
      await writeData(data);
      res.json({ ok: true, data: record });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/fleet/addons/request-quote", requireEmployeeOrCustomerApi, async (req, res, next) => {
    try {
      const data = await ensureCollections(await readData());
      const orgId = resolveRequestOrgId(req, data);
      if (!orgId) return res.status(400).json({ error: "orgId required" });
      const addonId = sanitizeString(req.body?.addonId || "", 80);
      if (!addonId) return res.status(400).json({ error: "addonId required" });
      const quote = {
        id: makeId("AQ"),
        orgId,
        addonId,
        notes: sanitizeString(req.body?.notes || "", 1200),
        status: "requested",
        createdAt: nowIso()
      };
      data.addonQuoteRequests.unshift(quote);
      addAudit(data, "ADDON_QUOTE_REQUESTED", addonId);
      await writeData(data);
      res.status(201).json({ ok: true, data: quote });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/predictive/recommendations", requireEmployeeOrCustomerApi, async (req, res, next) => {
    try {
      const data = await ensureCollections(await readData());
      const orgId = resolveRequestOrgId(req, data);
      if (!orgId) return res.status(400).json({ error: "orgId required" });
      const vehicleId = sanitizeString(req.query.vehicleId || "", 80);
      const limit = Math.min(Math.max(parseNumberField(req.query.limit, 20) || 20, 1), 100);
      let recommendations = data.recommendations.filter((rec) => matchesOrg(rec, orgId));
      if (vehicleId) recommendations = recommendations.filter((rec) => sanitizeString(rec.vehicleId || "", 80) === vehicleId);
      recommendations = recommendations
        .slice()
        .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
        .slice(0, limit);
      res.json({ ok: true, data: recommendations });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/dvir", requireEmployeeOrCustomerApi, async (req, res, next) => {
    try {
      const data = await ensureCollections(await readData());
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
      const data = await ensureCollections(await readData());
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
      const data = await ensureCollections(await readData());
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
      const data = await ensureCollections(await readData());
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
      const data = await ensureCollections(await readData());
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
      const data = await ensureCollections(await readData());
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
        unitCost: Math.max(0, parseNumberField(req.body?.unitCost, 0) || 0),
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
      const data = await ensureCollections(await readData());
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

  // ── NHTSA RECALL SYNC ──────────────────────────────────────────────────────
  app.get("/api/recalls", requireEmployeeOrCustomerApi, async (req, res, next) => {
    try {
      const data = await ensureCollections(await readData());
      const orgId = resolveRequestOrgId(req, data);
      data.recalls = Array.isArray(data.recalls) ? data.recalls : [];
      const recalls = orgId ? data.recalls.filter((r) => matchesOrg(r, orgId)) : data.recalls;
      res.json({ ok: true, data: recalls });
    } catch (err) { next(err); }
  });

  app.post("/api/recalls/sync", requireEmployeeOrCustomerApi, async (req, res, next) => {
    try {
      const data = await ensureCollections(await readData());
      const orgId = resolveRequestOrgId(req, data);
      if (!orgId) return res.status(400).json({ error: "orgId required" });
      data.recalls = Array.isArray(data.recalls) ? data.recalls : [];

      const vehicles = data.vehicles.filter((v) => matchesOrg(v, orgId) && v.vin);
      if (!vehicles.length) return res.json({ ok: true, synced: 0, added: 0, message: "No vehicles with VINs found." });

      const https = require("https");
      function fetchNhtsa(vin) {
        return new Promise((resolve) => {
          const url = `https://api.nhtsa.dot.gov/recalls/recallsByVehicle?vin=${encodeURIComponent(vin)}`;
          const target = new URL(url);
          https.get({ hostname: target.hostname, path: target.pathname + target.search, headers: { Accept: "application/json" } }, (r) => {
            let raw = "";
            r.on("data", (c) => (raw += c));
            r.on("end", () => {
              try { resolve(JSON.parse(raw)); } catch { resolve(null); }
            });
          }).on("error", () => resolve(null));
        });
      }

      let added = 0;
      for (const vehicle of vehicles) {
        const result = await fetchNhtsa(vehicle.vin);
        const items = result?.results || [];
        for (const item of items) {
          const recallId = sanitizeString(item.NHTSACampaignNumber || item.recallId || "", 80);
          if (!recallId) continue;
          const existing = data.recalls.find((r) => r.recallId === recallId && (r.vehicleId === vehicle.id || r.vehicleId === vehicle.vehicleId));
          if (existing) continue;
          data.recalls.push({
            id: makeId("RCL"),
            recallId,
            orgId,
            vehicleId: vehicle.vehicleId || vehicle.id,
            vehicleName: sanitizeString(vehicle.unitName || vehicle.name || vehicle.vin, 120),
            vin: vehicle.vin,
            title: sanitizeString(item.Subject || item.summary || "Safety Recall", 200),
            component: sanitizeString(item.Component || "", 200),
            consequence: sanitizeString(item.Consequence || "", 500),
            remedy: sanitizeString(item.Remedy || "", 500),
            status: "open",
            syncedAt: nowIso(),
            createdAt: nowIso()
          });
          added++;
        }
      }

      if (added > 0) await writeData(data);
      res.json({ ok: true, synced: vehicles.length, added, message: `Checked ${vehicles.length} vehicle(s). Found ${added} new recall(s).` });
    } catch (err) { next(err); }
  });

  app.patch("/api/recalls/:id", requireEmployeeOrCustomerApi, async (req, res, next) => {
    try {
      const data = await ensureCollections(await readData());
      data.recalls = Array.isArray(data.recalls) ? data.recalls : [];
      const recall = data.recalls.find((r) => r.id === req.params.id);
      if (!recall) return res.status(404).json({ error: "Recall not found" });
      if (denyCustomerOrgMismatch(req, res, recall.orgId)) return;
      const allowed = ["open", "in_progress", "resolved"];
      if (req.body.status) recall.status = normalizeStatus(req.body.status, allowed, recall.status);
      if (req.body.notes) recall.notes = sanitizeString(req.body.notes, 500);
      recall.updatedAt = nowIso();
      await writeData(data);
      res.json({ ok: true, data: recall });
    } catch (err) { next(err); }
  });

  // ── COST ANALYTICS ─────────────────────────────────────────────────────────
  app.get("/api/cost-analytics", requireEmployeeOrCustomerApi, async (req, res, next) => {
    try {
      const data = await ensureCollections(await readData());
      const orgId = resolveRequestOrgId(req, data);
      data.maintenanceLogs = Array.isArray(data.maintenanceLogs) ? data.maintenanceLogs : [];
      data.fuelEvents = Array.isArray(data.fuelEvents) ? data.fuelEvents : [];
      data.parts = Array.isArray(data.parts) ? data.parts : [];

      const vehicles = data.vehicles.filter((v) => matchesOrg(v, orgId));
      const result = vehicles.map((vehicle) => {
        const vid = vehicle.vehicleId || vehicle.id;
        const maintLogs = data.maintenanceLogs.filter((l) => (l.vehicleId === vid || l.vehicle_id === vid) && matchesOrg(l, orgId));
        const fuelLogs = data.fuelEvents.filter((f) => (f.vehicleId === vid || f.vehicle_id === vid) && matchesOrg(f, orgId));

        const maintCost = maintLogs.reduce((sum, l) => sum + parseNumberField(l.cost || l.laborCost || 0, 0, 999999), 0);
        const fuelCost = fuelLogs.reduce((sum, f) => sum + parseNumberField(f.cost || f.totalCost || 0, 0, 999999), 0);
        const totalMiles = fuelLogs.reduce((sum, f) => sum + parseNumberField(f.milesDriven || f.miles || 0, 0, 9999999), 0);
        const totalCost = maintCost + fuelCost;
        const costPerMile = totalMiles > 0 ? Math.round((totalCost / totalMiles) * 100) / 100 : null;

        return {
          vehicleId: vid,
          vehicleName: vehicle.unitName || vehicle.name || vid,
          maintCost: Math.round(maintCost * 100) / 100,
          fuelCost: Math.round(fuelCost * 100) / 100,
          totalCost: Math.round(totalCost * 100) / 100,
          totalMiles,
          costPerMile,
          maintEvents: maintLogs.length,
          fuelEvents: fuelLogs.length
        };
      });

      const fleet = {
        totalCost: Math.round(result.reduce((s, v) => s + v.totalCost, 0) * 100) / 100,
        totalMiles: result.reduce((s, v) => s + v.totalMiles, 0),
        avgCostPerMile: (() => {
          const withMiles = result.filter((v) => v.costPerMile !== null);
          if (!withMiles.length) return null;
          return Math.round((withMiles.reduce((s, v) => s + v.costPerMile, 0) / withMiles.length) * 100) / 100;
        })(),
        vehicles: result.length
      };

      res.json({ ok: true, data: { fleet, vehicles: result.sort((a, b) => b.totalCost - a.totalCost) } });
    } catch (err) { next(err); }
  });

  // ── DRIVER BEHAVIOR SCORING ────────────────────────────────────────────────
  app.get("/api/driver-scores", requireEmployeeOrCustomerApi, async (req, res, next) => {
    try {
      const data = await ensureCollections(await readData());
      const orgId = resolveRequestOrgId(req, data);
      data.telemetry = Array.isArray(data.telemetry) ? data.telemetry : [];

      const drivers = data.drivers.filter((d) => matchesOrg(d, orgId));
      const scores = drivers.map((driver) => {
        const did = driver.driverId || driver.id;
        const samples = data.telemetry.filter((t) => (t.driverId === did || t.driver_id === did) && matchesOrg(t, orgId));

        let harshBraking = 0, hardAccel = 0, speedingEvents = 0, idleMinutes = 0, totalSamples = samples.length;
        for (const s of samples) {
          const m = s.metrics || s.signals || {};
          if (parseNumberField(m.brakePressure || 0, 0, 999) > 80) harshBraking++;
          if (parseNumberField(m.rpm || 0, 0, 9999) > 4500) hardAccel++;
          if (parseNumberField(m.speed || m.vehicleSpeed || 0, 0, 200) > 75) speedingEvents++;
          if (parseNumberField(m.engineLoad || 0, 0, 100) < 5 && parseNumberField(m.rpm || 0, 0, 9999) > 400) idleMinutes++;
        }

        const base = 100;
        const deductions = Math.min(
          harshBraking * 3 + hardAccel * 2 + speedingEvents * 2 + Math.floor(idleMinutes / 10),
          70
        );
        const score = totalSamples === 0 ? null : Math.max(base - deductions, 30);

        return {
          driverId: did,
          driverName: [driver.firstName, driver.lastName].filter(Boolean).join(" ") || driver.name || did,
          score,
          grade: score === null ? "N/A" : score >= 90 ? "A" : score >= 75 ? "B" : score >= 60 ? "C" : score >= 45 ? "D" : "F",
          breakdown: { harshBraking, hardAccel, speedingEvents, idleMinutes, totalSamples }
        };
      });

      res.json({ ok: true, data: scores.sort((a, b) => (b.score ?? -1) - (a.score ?? -1)) });
    } catch (err) { next(err); }
  });

  // ── WEBHOOKS ───────────────────────────────────────────────────────────────
  app.get("/api/webhooks", requireEmployeeOrCustomerApi, async (req, res, next) => {
    try {
      const data = await ensureCollections(await readData());
      const orgId = resolveRequestOrgId(req, data);
      data.webhooks = Array.isArray(data.webhooks) ? data.webhooks : [];
      res.json({ ok: true, data: data.webhooks.filter((w) => matchesOrg(w, orgId)) });
    } catch (err) { next(err); }
  });

  app.post("/api/webhooks", requireEmployeeOrCustomerApi, async (req, res, next) => {
    try {
      const data = await ensureCollections(await readData());
      const orgId = resolveRequestOrgId(req, data);
      if (!orgId) return res.status(400).json({ error: "orgId required" });
      data.webhooks = Array.isArray(data.webhooks) ? data.webhooks : [];
      const url = sanitizeString(req.body.url || "", 500);
      if (!url || !url.startsWith("https://")) return res.status(400).json({ error: "Valid HTTPS URL required" });
      const events = Array.isArray(req.body.events) ? req.body.events.map((e) => sanitizeString(e, 80)).filter(Boolean) : ["alert.critical"];
      const webhook = { id: makeId("WHK"), orgId, url, events, active: true, createdAt: nowIso() };
      data.webhooks.push(webhook);
      await writeData(data);
      res.json({ ok: true, data: webhook });
    } catch (err) { next(err); }
  });

  app.delete("/api/webhooks/:id", requireEmployeeOrCustomerApi, async (req, res, next) => {
    try {
      const data = await ensureCollections(await readData());
      data.webhooks = Array.isArray(data.webhooks) ? data.webhooks : [];
      const webhook = data.webhooks.find((item) => item.id === req.params.id);
      if (!webhook) return res.status(404).json({ error: "Webhook not found" });
      if (denyCustomerOrgMismatch(req, res, webhook.orgId)) return;
      const before = data.webhooks.length;
      data.webhooks = data.webhooks.filter((w) => w.id !== req.params.id);
      if (data.webhooks.length === before) return res.status(404).json({ error: "Webhook not found" });
      await writeData(data);
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  // ── AI ADVISOR CHAT ────────────────────────────────────────────────────────
  app.post("/api/advisor/message", requireEmployeeOrCustomerApi, async (req, res, next) => {
    try {
      const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
      const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
      if (!OPENAI_API_KEY) {
        return res.json({ ok: true, reply: "AI Advisor is not configured. Add OPENAI_API_KEY to your .env file to enable it." });
      }

      const message = sanitizeString(req.body.message || req.body.content || "", 2000);
      if (!message) return res.status(400).json({ error: "message required" });

      const data = await ensureCollections(await readData());
      const orgId = resolveRequestOrgId(req, data);

      const vehicles = data.vehicles.filter((v) => matchesOrg(v, orgId)).slice(0, 20);
      const alerts = (Array.isArray(data.alerts) ? data.alerts : []).filter((a) => matchesOrg(a, orgId)).slice(0, 10);
      data.maintenanceLogs = Array.isArray(data.maintenanceLogs) ? data.maintenanceLogs : [];
      const recentMaint = data.maintenanceLogs.filter((l) => matchesOrg(l, orgId)).slice(0, 10);

      const context = {
        vehicles: vehicles.map((v) => ({ id: v.vehicleId || v.id, name: v.unitName || v.name, vin: v.vin, type: v.vehicleType })),
        activeAlerts: alerts.map((a) => ({ type: a.type, severity: a.severity, vehicleId: a.vehicleId, createdAt: a.createdAt })),
        recentMaintenance: recentMaint.map((l) => ({ vehicleId: l.vehicleId, type: l.serviceType || l.type, date: l.performedAt || l.createdAt, cost: l.cost }))
      };

      const https = require("https");
      const payload = JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          { role: "system", content: `You are the Fleet AI advisor — an expert fleet management assistant. Answer questions using the fleet data provided. Be concise, practical, and action-oriented. If data is insufficient, say so honestly. Fleet context: ${JSON.stringify(context)}` },
          { role: "user", content: message }
        ],
        temperature: 0.4,
        max_tokens: 600
      });

      const response = await new Promise((resolve, reject) => {
        const req2 = https.request({
          hostname: "api.openai.com",
          path: "/v1/chat/completions",
          method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload), Authorization: `Bearer ${OPENAI_API_KEY}` }
        }, (r) => {
          let raw = "";
          r.on("data", (c) => (raw += c));
          r.on("end", () => resolve({ status: r.statusCode, body: raw }));
        });
        req2.on("error", reject);
        req2.write(payload);
        req2.end();
      });

      if (response.status >= 200 && response.status < 300) {
        const parsed = JSON.parse(response.body || "{}");
        const reply = parsed?.choices?.[0]?.message?.content || "No response generated.";
        return res.json({ ok: true, reply: sanitizeString(reply, 3000) });
      }
      return res.json({ ok: true, reply: "The AI service is temporarily unavailable. Please try again shortly." });
    } catch (err) { next(err); }
  });

  app.post("/api/ai/chat", requireEmployeeOrCustomerApi, (req, res, next) => {
    req.url = "/api/advisor/message";
    app.handle(req, res, next);
  });

  // ── GPS LIVE POSITIONS ─────────────────────────────────────────────────────
  app.get("/api/gps/live", requireEmployeeOrCustomerApi, async (req, res, next) => {
    try {
      const data = await ensureCollections(await readData());
      const orgId = resolveRequestOrgId(req, data);
      if (!orgId) return res.status(400).json({ error: "orgId required" });
      const telemetry = Array.isArray(data.telemetrySnapshots) ? data.telemetrySnapshots : [];
      const latestByVehicle = {};
      for (const snap of telemetry) {
        const vid = sanitizeString(snap.vehicleId || snap.vehicle_id || "", 80);
        if (!vid || !matchesOrg(snap, orgId)) continue;
        if (!latestByVehicle[vid] || new Date(snap.timestamp || 0) > new Date(latestByVehicle[vid].timestamp || 0)) {
          latestByVehicle[vid] = snap;
        }
      }
      const vehicles = data.vehicles.filter((v) => matchesOrg(v, orgId));
      const positions = vehicles.map((v) => {
        const vid = v.vehicleId || v.id;
        const snap = latestByVehicle[vid];
        const metrics = snap?.metrics || snap?.signals || {};
        const lat = parseNumberField(metrics.latitude ?? metrics.lat, null);
        const lon = parseNumberField(metrics.longitude ?? metrics.lon, null);
        if (lat === null || lon === null) return null;
        return {
          vehicleId: vid,
          vehicleName: sanitizeString(v.unitName || v.name || vid, 120),
          lat,
          lon,
          speed: parseNumberField(metrics.speed || metrics.vehicleSpeed || 0, 0, 200) || 0,
          heading: parseNumberField(metrics.heading || 0, 0, 360) || 0,
          engineOn: Boolean(snap),
          updatedAt: snap?.timestamp || null
        };
      }).filter(Boolean);
      res.json({ ok: true, data: positions });
    } catch (err) { next(err); }
  });

  // ── ALERT SUBSCRIPTIONS (Email) ────────────────────────────────────────────
  app.get("/api/alert-subscriptions", requireEmployeeOrCustomerApi, async (req, res, next) => {
    try {
      const data = await ensureCollections(await readData());
      const orgId = resolveRequestOrgId(req, data);
      data.alertSubscriptions = Array.isArray(data.alertSubscriptions) ? data.alertSubscriptions : [];
      res.json({ ok: true, data: data.alertSubscriptions.filter((s) => matchesOrg(s, orgId)) });
    } catch (err) { next(err); }
  });

  app.post("/api/alert-subscriptions", requireEmployeeOrCustomerApi, async (req, res, next) => {
    try {
      const data = await ensureCollections(await readData());
      const orgId = resolveRequestOrgId(req, data);
      if (!orgId) return res.status(400).json({ error: "orgId required" });
      data.alertSubscriptions = Array.isArray(data.alertSubscriptions) ? data.alertSubscriptions : [];
      const email = sanitizeString(req.body.email || "", 200);
      if (!email || !email.includes("@")) return res.status(400).json({ error: "Valid email required" });
      const events = Array.isArray(req.body.events)
        ? req.body.events.map((e) => sanitizeString(e, 80)).filter(Boolean)
        : ["alert.critical"];
      const sub = { id: makeId("SUB"), orgId, email, events, active: true, createdAt: nowIso() };
      data.alertSubscriptions.push(sub);
      addAudit(data, "ALERT_SUBSCRIPTION_CREATED", email);
      await writeData(data);
      res.status(201).json({ ok: true, data: sub });
    } catch (err) { next(err); }
  });

  app.delete("/api/alert-subscriptions/:id", requireEmployeeOrCustomerApi, async (req, res, next) => {
    try {
      const data = await ensureCollections(await readData());
      data.alertSubscriptions = Array.isArray(data.alertSubscriptions) ? data.alertSubscriptions : [];
      const subscription = data.alertSubscriptions.find((item) => item.id === req.params.id);
      if (!subscription) return res.status(404).json({ error: "Subscription not found" });
      if (denyCustomerOrgMismatch(req, res, subscription.orgId)) return;
      const before = data.alertSubscriptions.length;
      data.alertSubscriptions = data.alertSubscriptions.filter((s) => s.id !== req.params.id);
      if (data.alertSubscriptions.length === before) return res.status(404).json({ error: "Subscription not found" });
      await writeData(data);
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  app.post("/api/alert-subscriptions/test", requireEmployeeOrCustomerApi, async (req, res, next) => {
    try {
      const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "";
      const email = sanitizeString(req.body.email || "", 200);
      if (!email || !email.includes("@")) return res.status(400).json({ error: "Valid email required" });
      if (!SENDGRID_API_KEY) {
        return res.json({ ok: true, sent: false, message: "SendGrid not configured. Add SENDGRID_API_KEY to .env to enable email alerts." });
      }
      const https = require("https");
      const payload = JSON.stringify({
        personalizations: [{ to: [{ email }] }],
        from: { email: process.env.SENDGRID_FROM_EMAIL || "alerts@fleetai.app", name: "Fleet AI Alerts" },
        subject: "Fleet AI — Test Alert",
        content: [{ type: "text/plain", value: "This is a test alert from Fleet AI. Your alert subscription is active and working correctly." }]
      });
      const response = await new Promise((resolve, reject) => {
        const req2 = https.request({
          hostname: "api.sendgrid.com",
          path: "/v3/mail/send",
          method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload), Authorization: `Bearer ${SENDGRID_API_KEY}` }
        }, (r) => {
          let raw = "";
          r.on("data", (c) => (raw += c));
          r.on("end", () => resolve({ status: r.statusCode }));
        });
        req2.on("error", reject);
        req2.write(payload);
        req2.end();
      });
      if (response.status >= 200 && response.status < 300) {
        return res.json({ ok: true, sent: true, message: `Test alert sent to ${email}` });
      }
      return res.json({ ok: true, sent: false, message: "SendGrid returned an error. Check your API key and sender address." });
    } catch (err) { next(err); }
  });

  // ── PREDICTIVE MAINTENANCE AUTO-SCHEDULER ─────────────────────────────────
  app.post("/api/predictive/run", requireEmployeeOrCustomerApi, async (req, res, next) => {
    try {
      const data = await ensureCollections(await readData());
      const orgId = resolveRequestOrgId(req, data);
      if (!orgId) return res.status(400).json({ error: "orgId required" });
      data.maintenanceLogs = Array.isArray(data.maintenanceLogs) ? data.maintenanceLogs : [];
      data.recommendations = Array.isArray(data.recommendations) ? data.recommendations : [];
      const mlScores = Array.isArray(data.mlPredictions) ? data.mlPredictions : [];
      const vehicles = data.vehicles.filter((v) => matchesOrg(v, orgId));

      let created = 0;
      const results = [];
      for (const vehicle of vehicles) {
        const vid = vehicle.vehicleId || vehicle.id;
        const ml = mlScores.find((p) => (p.vehicleId === vid || p.vehicle_id === vid) && matchesOrg(p, orgId));
        const score = ml ? parseNumberField(ml.healthScore || ml.health_score || ml.score, 100) : null;
        if (score !== null && score < 70) {
          const existing = data.recommendations.find(
            (r) => matchesOrg(r, orgId) && r.vehicleId === vid && r.status === "open"
          );
          if (!existing) {
            const rec = {
              id: makeId("REC"),
              orgId,
              vehicleId: vid,
              vehicleName: sanitizeString(vehicle.unitName || vehicle.name || vid, 120),
              healthScore: score,
              priority: score < 50 ? "critical" : "high",
              recommendation: score < 50
                ? "Critical health score — immediate inspection required."
                : "Elevated risk — schedule preventive service within 7 days.",
              serviceType: score < 50 ? "IMMEDIATE_INSPECTION" : "PREVENTIVE_MAINTENANCE",
              status: "open",
              autoScheduled: true,
              createdAt: nowIso()
            };
            data.recommendations.push(rec);
            created++;
            results.push({ vehicleId: vid, vehicleName: rec.vehicleName, score, priority: rec.priority });
          }
        }
      }
      if (created > 0) {
        addAudit(data, "PREDICTIVE_SCHEDULER_RUN", `${created} work orders created`);
        await writeData(data);
      }
      res.json({
        ok: true,
        checked: vehicles.length,
        created,
        message: created
          ? `Auto-scheduled ${created} work order(s) for vehicles with health score below 70.`
          : "All vehicles within healthy parameters. No new work orders needed.",
        results
      });
    } catch (err) { next(err); }
  });

  // ── COMPLIANCE REPORT GENERATOR ────────────────────────────────────────────
  app.get("/api/reports/compliance", requireEmployeeOrCustomerApi, async (req, res, next) => {
    try {
      const data = await ensureCollections(await readData());
      const orgId = resolveRequestOrgId(req, data);
      if (!orgId) return res.status(400).json({ error: "orgId required" });
      const type = sanitizeString(req.query.type || "full", 20);
      const fromDate = req.query.from ? new Date(sanitizeString(req.query.from, 30)) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const toDate = req.query.to ? new Date(sanitizeString(req.query.to, 30)) : new Date();
      const inRange = (iso) => { const d = new Date(iso || 0); return d >= fromDate && d <= toDate; };

      const dvirRecords = data.dvirRecords.filter((r) => matchesOrg(r, orgId) && inRange(r.submittedAt));
      data.maintenanceLogs = Array.isArray(data.maintenanceLogs) ? data.maintenanceLogs : [];
      const maintLogs = data.maintenanceLogs.filter((l) => matchesOrg(l, orgId) && inRange(l.performedAt || l.createdAt));
      const vehicles = data.vehicles.filter((v) => matchesOrg(v, orgId));
      const dvir = summarizeDvir(dvirRecords);
      const maintSummary = {
        total: maintLogs.length,
        byType: maintLogs.reduce((acc, l) => {
          const t = sanitizeString(l.serviceType || l.type || "OTHER", 80);
          acc[t] = (acc[t] || 0) + 1;
          return acc;
        }, {}),
        totalCost: Math.round(maintLogs.reduce((s, l) => s + parseNumberField(l.cost || 0, 0, 999999), 0) * 100) / 100
      };
      res.json({
        ok: true,
        data: {
          generatedAt: nowIso(),
          period: { from: fromDate.toISOString(), to: toDate.toISOString() },
          org: { orgId, vehicleCount: vehicles.length },
          dvir: type !== "maintenance" ? dvir : undefined,
          dvirRecords: type === "dvir" ? dvirRecords.slice(0, 200) : undefined,
          maintenance: type !== "dvir" ? maintSummary : undefined,
          maintenanceLogs: type === "maintenance" ? maintLogs.slice(0, 200) : undefined,
          hos: { status: "not_connected", message: "HOS integration not yet connected." }
        }
      });
    } catch (err) { next(err); }
  });

  // ── DRIVER MESSAGING ───────────────────────────────────────────────────────
  app.get("/api/messages", requireEmployeeOrCustomerApi, async (req, res, next) => {
    try {
      const data = await ensureCollections(await readData());
      const orgId = resolveRequestOrgId(req, data);
      if (!orgId) return res.status(400).json({ error: "orgId required" });
      data.driverMessages = Array.isArray(data.driverMessages) ? data.driverMessages : [];
      const driverId = sanitizeString(req.query.driverId || "", 80);
      let msgs = data.driverMessages.filter((m) => matchesOrg(m, orgId));
      if (driverId) msgs = msgs.filter((m) => m.toDriverId === driverId);
      msgs = msgs.slice().sort((a, b) => new Date(a.sentAt || 0) - new Date(b.sentAt || 0)).slice(-100);
      res.json({ ok: true, data: msgs });
    } catch (err) { next(err); }
  });

  app.post("/api/messages", requireEmployeeOrCustomerApi, async (req, res, next) => {
    try {
      const data = await ensureCollections(await readData());
      const orgId = resolveRequestOrgId(req, data);
      if (!orgId) return res.status(400).json({ error: "orgId required" });
      data.driverMessages = Array.isArray(data.driverMessages) ? data.driverMessages : [];
      const toDriverId = sanitizeString(req.body.driverId || req.body.toDriverId || "", 80);
      const body = sanitizeString(req.body.body || req.body.message || req.body.content || "", 2000);
      if (!toDriverId) return res.status(400).json({ error: "driverId required" });
      if (!body) return res.status(400).json({ error: "message body required" });
      const driver = findDriver(data, orgId, toDriverId);
      if (!driver) return res.status(404).json({ error: "Driver not found in this organization" });
      const msg = {
        id: makeId("MSG"),
        orgId,
        toDriverId,
        driverName: personName(driver) || driver.driverId || toDriverId,
        fromRole: req.customer ? "dispatcher" : "employee",
        body,
        sentAt: nowIso(),
        readAt: null
      };
      data.driverMessages.push(msg);
      addAudit(data, "DRIVER_MESSAGE_SENT", toDriverId);
      await writeData(data);
      if (app._msgClients && app._msgClients[orgId]) {
        const payload = `data: ${JSON.stringify(msg)}\n\n`;
        app._msgClients[orgId].forEach((client) => { try { client.write(payload); } catch (_) {} });
      }
      res.status(201).json({ ok: true, data: msg });
    } catch (err) { next(err); }
  });

  app.get("/api/messages/stream", requireEmployeeOrCustomerApi, (req, res, next) => {
    try {
      const orgId = sanitizeString(req.customer?.orgId || req.query?.orgId || "", 80);
      if (!orgId) { res.status(400).end(); return; }
      res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.flushHeaders();
      res.write(`data: ${JSON.stringify({ type: "connected", orgId })}\n\n`);
      if (!app._msgClients) app._msgClients = {};
      if (!app._msgClients[orgId]) app._msgClients[orgId] = [];
      app._msgClients[orgId].push(res);
      req.on("close", () => {
        if (app._msgClients[orgId]) {
          app._msgClients[orgId] = app._msgClients[orgId].filter((c) => c !== res);
        }
      });
    } catch (err) { next(err); }
  });
}

module.exports = {
  registerSolutionRoutes
};
