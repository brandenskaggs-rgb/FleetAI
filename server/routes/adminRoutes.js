const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { getPrisma } = require("../db");
const { generateApiKey } = require("../middleware/apiKeyAuth");
const { validateBody, schemas } = require("../middleware/validate");
const { makeId, nowIso, addAudit, sanitizeString, normalizeEmail, parseNumberField } = require("../lib/utils");

// ── Pure helpers (org/lead data helpers) ──────────────────────────────────

function normalizeOrgStatus(value) {
  const raw = String(value || "").toUpperCase();
  const allowed = ["LEAD", "PILOT", "ACTIVE", "PAUSED", "CHURNED", "DELETED"];
  if (allowed.includes(raw)) return raw;
  if (raw === "DEMO") return "LEAD";
  return "LEAD";
}

function normalizeLeadStatus(value) {
  const raw = String(value || "").toUpperCase();
  const map = {
    NEW: "NEW",
    CONTACTED: "CONTACTED",
    QUALIFIED: "SCHEDULED",
    SCHEDULED: "SCHEDULED",
    CONVERTED: "CONVERTED",
    CLOSED: "CLOSED",
    LOST: "CLOSED",
    LEAD: "NEW",
    WON: "CONVERTED"
  };
  return map[raw] || "NEW";
}

function defaultBilling(orgId, data) {
  const price = data.settings?.defaultPilotPrice ?? 59;
  return {
    orgId,
    plan: "PILOT",
    pricePerVehicle: price,
    vehicleCount: 0,
    mrrEstimate: 0,
    contractTermMonths: 0,
    billingStatus: "NOT_BILLING",
    updatedAt: nowIso()
  };
}

function defaultBillingSettings(data) {
  const price = (data && data.settings?.defaultPilotPrice) ?? 59;
  return {
    plan: "PILOT_CORE",
    priceMonthly: price,
    status: "NONE",
    activatedAt: null,
    nextBillAt: null,
    vehicleCount: 0,
    contractTermMonths: 0,
    notes: ""
  };
}

function defaultPaymentMethod() {
  return {
    type: "CARD_STUB",
    billingName: "",
    billingEmail: "",
    last4: "",
    expMonth: 1,
    expYear: new Date().getFullYear(),
    brand: "",
    postalCode: "",
    accountType: "",
    routingLast4: "",
    accountLast4: "",
    updatedAt: null
  };
}

function defaultFeatures(orgId) {
  return {
    orgId,
    aiAdvisor: true,
    safetyPack: false,
    safetyScorePack: false,
    compliancePack: false,
    cameraIntegration: false,
    advancedDiagnostics: false,
    updatedAt: nowIso()
  };
}

// ── Route registration ─────────────────────────────────────────────────────

function registerAdminRoutes(app, deps) {
  const {
    readData,
    writeData,
    requireSuperAdmin,
    hasSuperAdminCached,
    getRateState,
    SETUP_KEY,
    SETUP_ALLOWED,
    DEFAULT_SETTINGS
  } = deps;

  // ── Bootstrap setup endpoints ────────────────────────────────────────────

  app.get("/api/admin/setup/status", async (req, res, next) => {
    try {
      const data = await readData();
      const hasSuperAdmin = hasSuperAdminCached(data);
      const enabled = SETUP_ALLOWED && !hasSuperAdmin && Boolean(SETUP_KEY);
      const reason = hasSuperAdmin
        ? "Setup already completed"
        : !SETUP_ALLOWED
          ? "Setup disabled in production"
          : SETUP_KEY
            ? "Setup available"
            : "Setup key not configured on server";
      res.json({ enabled, hasSuperAdmin, reason });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/setup/status", (req, res) => {
    req.url = "/api/admin/setup/status";
    app.handle(req, res);
  });

  async function handleCreateSuperAdmin(req, res, next) {
    const ipKey = req.ip || req.socket.remoteAddress || "local";
    const rate = getRateState(ipKey);
    if (!rate.allowed) {
      return res.status(429).json({ error: "Too many attempts. Try again later." });
    }
    const { setupKey, email, password } = req.body || {};
    console.log(`[admin-setup] attempt for ${email || "unknown"}`);
    if (!SETUP_KEY) {
      return res.status(503).json({ error: "Setup key not configured on server" });
    }
    if (!setupKey || setupKey !== SETUP_KEY) {
      console.warn(`[admin-setup] invalid setup key for ${email || "unknown"}`);
      return res.status(401).json({ error: "Invalid setup key" });
    }
    if (!SETUP_ALLOWED) {
      return res.status(403).json({ error: "Setup is disabled in production." });
    }
    if (!email || !/^[^@]+@[^@]+\.[^@]+$/.test(email)) {
      console.warn(`[admin-setup] invalid email ${email || "unknown"}`);
      return res.status(400).json({ error: "Email must be a valid address." });
    }
    if (!password || password.length < 10) {
      console.warn(`[admin-setup] weak password for ${email}`);
      return res.status(400).json({ error: "Password must be at least 10 characters." });
    }
    try {
      const data = await readData();
      if (hasSuperAdminCached(data)) {
        return res.status(409).json({ error: "Setup already completed" });
      }
      const exists = (data.users || []).some((u) => u.email === email.toLowerCase());
      if (exists) {
        return res.status(409).json({ error: "User already exists." });
      }
      const passwordHash = await bcrypt.hash(password, 12);
      const user = {
        id: `EMP_${Date.now()}`,
        email: email.toLowerCase(),
        role: "SUPER_ADMIN",
        orgId: null,
        isActive: true,
        passwordHash,
        createdAt: new Date().toISOString(),
        lastLoginAt: null
      };
      data.users = data.users || [];
      data.audit = data.audit || [];
      data.users.push(user);
      data.audit.push({ event: "SUPER_ADMIN_CREATED", email: user.email, ts: new Date().toISOString() });
      await writeData(data);
      console.log(`[admin-setup] super admin created for ${user.email}`);
      res.status(201).json({ ok: true });
    } catch (err) {
      next(err);
    }
  }

  app.post("/api/admin/setup", handleCreateSuperAdmin);
  app.post("/api/setup/create-super-admin", handleCreateSuperAdmin);

  // ── Admin router (requireSuperAdmin guard on all routes) ──────────────────

  const adminRouter = express.Router();
  adminRouter.use(requireSuperAdmin);

  adminRouter.get("/me", (req, res) => {
    res.json({ ok: true, user: req.employee });
  });

  adminRouter.get("/overview", async (req, res, next) => {
    try {
      const data = await readData();
      const orgs = data.orgs || [];
      const users = data.users || [];
      const leads = data.leads || [];
      const billing = data.billing || {};
      const activeOrgs = orgs.filter((o) => o.status === "ACTIVE").length;
      const activePilots = orgs.filter((o) => o.status === "PILOT").length;
      const activeVehicles = (data.vehicles || []).length;
      const mrr = Object.values(billing).reduce((sum, b) => sum + (b.mrrEstimate || 0), 0);
      const leadsByStage = leads.reduce((acc, l) => {
        acc[l.stage] = (acc[l.stage] || 0) + 1;
        return acc;
      }, {});
      res.json({
        ok: true,
        data: { totalOrgs: orgs.length, activeOrgs, activePilots, activeVehicles, totalUsers: users.length, mrrEstimate: mrr, leadsByStage }
      });
    } catch (err) {
      next(err);
    }
  });

  adminRouter.get("/orgs", async (req, res, next) => {
    try {
      const data = await readData();
      res.json({ ok: true, data: data.orgs || [] });
    } catch (err) {
      next(err);
    }
  });

  adminRouter.post("/orgs", async (req, res, next) => {
    const { name, industry, fleetSize, status, notes, primaryContactName, primaryContactEmail, phone, billingPlan, activeVehicles } = req.body || {};
    if (!name) return res.status(400).json({ error: "Org name required" });
    try {
      const data = await readData();
      const org = {
        id: makeId("ORG"),
        name,
        status: normalizeOrgStatus(status || "LEAD"),
        industry: industry || "",
        fleetSize: Number.isFinite(fleetSize) ? fleetSize : 0,
        activeVehicles: Number.isFinite(activeVehicles) ? activeVehicles : 0,
        primaryContactName: primaryContactName || "",
        primaryContactEmail: primaryContactEmail || "",
        phone: phone || "",
        billingPlan: billingPlan || "PILOT_CORE",
        createdAt: nowIso(),
        updatedAt: nowIso(),
        notes: notes || ""
      };
      data.orgs.push(org);
      data.billing = data.billing || {};
      data.featureFlags = data.featureFlags || {};
      data.billing[org.id] = defaultBilling(org.id, data);
      data.featureFlags[org.id] = defaultFeatures(org.id);
      addAudit(data, "ORG_CREATED", `${org.id}:${org.name}`);
      await writeData(data);
      res.json({ ok: true, data: org });
    } catch (err) {
      next(err);
    }
  });

  adminRouter.get("/orgs/:id", async (req, res, next) => {
    try {
      const data = await readData();
      const org = (data.orgs || []).find((o) => o.id === req.params.id);
      if (!org) return res.status(404).json({ error: "Org not found" });
      const billing = (data.billing || {})[org.id] || defaultBilling(org.id, data);
      const features = (data.featureFlags || {})[org.id] || defaultFeatures(org.id);
      const invites = (data.invites || []).filter((i) => i.orgId === org.id);
      res.json({ ok: true, data: { org, billing, features, invites } });
    } catch (err) {
      next(err);
    }
  });

  adminRouter.put("/orgs/:id", async (req, res, next) => {
    try {
      const data = await readData();
      const org = (data.orgs || []).find((o) => o.id === req.params.id);
      if (!org) return res.status(404).json({ error: "Org not found" });
      const { name, industry, fleetSize, notes } = req.body || {};
      if (name !== undefined) org.name = name;
      if (industry !== undefined) org.industry = industry;
      if (fleetSize !== undefined) org.fleetSize = Number(fleetSize) || 0;
      if (notes !== undefined) org.notes = notes;
      org.updatedAt = nowIso();
      addAudit(data, "ORG_UPDATED", org.id);
      await writeData(data);
      res.json({ ok: true, data: org });
    } catch (err) {
      next(err);
    }
  });

  adminRouter.put("/orgs/:id/status", async (req, res, next) => {
    const { status } = req.body || {};
    if (!status) return res.status(400).json({ error: "status required" });
    try {
      const data = await readData();
      const org = (data.orgs || []).find((o) => o.id === req.params.id);
      if (!org) return res.status(404).json({ error: "Org not found" });
      org.status = normalizeOrgStatus(status);
      org.updatedAt = nowIso();
      addAudit(data, "ORG_STATUS_UPDATED", `${org.id}:${status}`);
      await writeData(data);
      res.json({ ok: true, data: org });
    } catch (err) {
      next(err);
    }
  });

  adminRouter.get("/users", async (req, res, next) => {
    try {
      const data = await readData();
      res.json({ ok: true, data: data.users || [] });
    } catch (err) {
      next(err);
    }
  });

  adminRouter.post("/users", async (req, res, next) => {
    const { email, role, orgId, password } = req.body || {};
    if (!email || !role) return res.status(400).json({ error: "email and role required" });
    try {
      const data = await readData();
      const exists = (data.users || []).some((u) => u.email === email.toLowerCase());
      if (exists) return res.status(409).json({ error: "User already exists" });
      const passwordHash = password ? await bcrypt.hash(password, 12) : "";
      const user = {
        id: makeId("USR"),
        email: email.toLowerCase(),
        role,
        orgId: orgId || null,
        isActive: true,
        createdAt: nowIso(),
        lastLoginAt: null,
        passwordHash
      };
      data.users.push(user);
      addAudit(data, "USER_CREATED", `${user.id}:${user.email}`);
      await writeData(data);
      res.json({ ok: true, data: user });
    } catch (err) {
      next(err);
    }
  });

  adminRouter.put("/users/:id", async (req, res, next) => {
    try {
      const data = await readData();
      const user = (data.users || []).find((u) => u.id === req.params.id);
      if (!user) return res.status(404).json({ error: "User not found" });
      const { email, orgId, isActive } = req.body || {};
      if (email !== undefined) user.email = email.toLowerCase();
      if (orgId !== undefined) user.orgId = orgId || null;
      if (isActive !== undefined) user.isActive = Boolean(isActive);
      addAudit(data, "USER_UPDATED", user.id);
      await writeData(data);
      res.json({ ok: true, data: user });
    } catch (err) {
      next(err);
    }
  });

  adminRouter.put("/users/:id/role", async (req, res, next) => {
    const { role } = req.body || {};
    if (!role) return res.status(400).json({ error: "role required" });
    try {
      const data = await readData();
      const user = (data.users || []).find((u) => u.id === req.params.id);
      if (!user) return res.status(404).json({ error: "User not found" });
      user.role = role;
      addAudit(data, "USER_ROLE_UPDATED", user.id);
      await writeData(data);
      res.json({ ok: true, data: user });
    } catch (err) {
      next(err);
    }
  });

  adminRouter.put("/users/:id/disable", async (req, res, next) => {
    try {
      const data = await readData();
      const user = (data.users || []).find((u) => u.id === req.params.id);
      if (!user) return res.status(404).json({ error: "User not found" });
      user.isActive = false;
      addAudit(data, "USER_DISABLED", user.id);
      await writeData(data);
      res.json({ ok: true, data: user });
    } catch (err) {
      next(err);
    }
  });

  adminRouter.get("/invites", async (req, res, next) => {
    try {
      const data = await readData();
      res.json({ ok: true, data: data.invites || [] });
    } catch (err) {
      next(err);
    }
  });

  adminRouter.post("/invites", async (req, res, next) => {
    const { orgId, type } = req.body || {};
    if (!orgId || !type) return res.status(400).json({ error: "orgId and type required" });
    try {
      const data = await readData();
      const token = crypto.randomBytes(16).toString("hex");
      const hours = data.settings?.inviteExpiryHours || 72;
      const invite = {
        id: makeId("INV"),
        orgId,
        type,
        token,
        expiresAt: new Date(Date.now() + hours * 3600000).toISOString(),
        createdAt: nowIso(),
        createdBy: req.employee?.email || "system"
      };
      data.invites = data.invites || [];
      data.invites.push(invite);
      addAudit(data, "INVITE_CREATED", invite.id);
      await writeData(data);
      res.json({ ok: true, data: invite });
    } catch (err) {
      next(err);
    }
  });

  adminRouter.delete("/invites/:id", async (req, res, next) => {
    try {
      const data = await readData();
      data.invites = (data.invites || []).filter((i) => i.id !== req.params.id);
      addAudit(data, "INVITE_REVOKED", req.params.id);
      await writeData(data);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  adminRouter.get("/billing/:orgId", async (req, res, next) => {
    try {
      const data = await readData();
      data.billing = data.billing || {};
      const billing = data.billing[req.params.orgId] || defaultBilling(req.params.orgId, data);
      res.json({ ok: true, data: billing });
    } catch (err) {
      next(err);
    }
  });

  adminRouter.put("/billing/:orgId", async (req, res, next) => {
    try {
      const data = await readData();
      data.billing = data.billing || {};
      const current = data.billing[req.params.orgId] || defaultBilling(req.params.orgId, data);
      const updates = req.body || {};
      const nextBilling = Object.assign({}, current, updates, { updatedAt: nowIso() });
      nextBilling.mrrEstimate = (nextBilling.pricePerVehicle || 0) * (nextBilling.vehicleCount || 0);
      data.billing[req.params.orgId] = nextBilling;
      addAudit(data, "BILLING_UPDATED", req.params.orgId);
      await writeData(data);
      res.json({ ok: true, data: nextBilling });
    } catch (err) {
      next(err);
    }
  });

  adminRouter.get("/features/:orgId", async (req, res, next) => {
    try {
      const data = await readData();
      data.featureFlags = data.featureFlags || {};
      const features = data.featureFlags[req.params.orgId] || defaultFeatures(req.params.orgId);
      res.json({ ok: true, data: features });
    } catch (err) {
      next(err);
    }
  });

  adminRouter.put("/features/:orgId", async (req, res, next) => {
    try {
      const data = await readData();
      data.featureFlags = data.featureFlags || {};
      const current = data.featureFlags[req.params.orgId] || defaultFeatures(req.params.orgId);
      const updates = req.body || {};
      const nextFeatures = Object.assign({}, current, updates, { updatedAt: nowIso() });
      data.featureFlags[req.params.orgId] = nextFeatures;
      addAudit(data, "FEATURES_UPDATED", req.params.orgId);
      await writeData(data);
      res.json({ ok: true, data: nextFeatures });
    } catch (err) {
      next(err);
    }
  });

  adminRouter.get("/leads", async (req, res, next) => {
    try {
      const data = await readData();
      res.json({ ok: true, data: data.leads || [] });
    } catch (err) {
      next(err);
    }
  });

  adminRouter.post("/leads", async (req, res, next) => {
    const { companyName, contactName, contactEmail, contactPhone, stage, demoDate, notes, status } = req.body || {};
    if (!companyName) return res.status(400).json({ error: "companyName required" });
    try {
      const data = await readData();
      const leadId = makeId("LEAD");
      const lead = {
        id: leadId,
        leadId,
        companyName,
        contactName: contactName || "",
        contactEmail: contactEmail || "",
        contactPhone: contactPhone || "",
        stage: stage || "LEAD",
        status: normalizeLeadStatus(status || stage || "NEW"),
        demoDate: demoDate || null,
        notes: notes || "",
        createdAt: nowIso(),
        updatedAt: nowIso()
      };
      data.leads = data.leads || [];
      data.leads.push(lead);
      addAudit(data, "LEAD_CREATED", lead.id);
      await writeData(data);
      res.json({ ok: true, data: lead });
    } catch (err) {
      next(err);
    }
  });

  adminRouter.put("/leads/:id", async (req, res, next) => {
    try {
      const data = await readData();
      const lead = (data.leads || []).find((l) => l.id === req.params.id);
      if (!lead) return res.status(404).json({ error: "Lead not found" });
      const updates = req.body || {};
      Object.assign(lead, updates);
      if (updates.status) {
        lead.status = normalizeLeadStatus(updates.status);
        lead.stage = lead.status;
      }
      lead.updatedAt = nowIso();
      addAudit(data, "LEAD_UPDATED", lead.id);
      await writeData(data);
      res.json({ ok: true, data: lead });
    } catch (err) {
      next(err);
    }
  });

  adminRouter.post("/leads/:id/convert-to-org", async (req, res, next) => {
    try {
      const data = await readData();
      const lead = (data.leads || []).find((l) => l.id === req.params.id);
      if (!lead) return res.status(404).json({ error: "Lead not found" });
      const org = {
        id: makeId("ORG"),
        name: lead.companyName,
        status: "PILOT",
        industry: "",
        fleetSize: 0,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        notes: lead.notes || ""
      };
      data.orgs.push(org);
      data.billing = data.billing || {};
      data.featureFlags = data.featureFlags || {};
      data.billing[org.id] = defaultBilling(org.id, data);
      data.featureFlags[org.id] = defaultFeatures(org.id);
      lead.stage = "CONVERTED";
      lead.status = "CONVERTED";
      lead.orgId = org.id;
      lead.updatedAt = nowIso();
      addAudit(data, "ORG_CREATED", `${org.id}:${org.name}`);
      addAudit(data, "LEAD_CONVERTED_TO_ORG", `${lead.id}:${org.id}`);
      await writeData(data);
      res.json({ ok: true, data: { lead, org } });
    } catch (err) {
      next(err);
    }
  });

  adminRouter.get("/audit", async (req, res, next) => {
    try {
      const data = await readData();
      res.json({ ok: true, data: (data.audit || []).slice(0, 100) });
    } catch (err) {
      next(err);
    }
  });

  adminRouter.get("/settings", async (req, res, next) => {
    try {
      const data = await readData();
      res.json({ ok: true, data: data.settings || DEFAULT_SETTINGS || {} });
    } catch (err) {
      next(err);
    }
  });

  adminRouter.put("/settings", async (req, res, next) => {
    try {
      const data = await readData();
      data.settings = Object.assign({}, data.settings || {}, req.body || {});
      addAudit(data, "SETTINGS_UPDATED", "settings");
      await writeData(data);
      res.json({ ok: true, data: data.settings });
    } catch (err) {
      next(err);
    }
  });

  app.use("/api/admin", adminRouter);

  // ── API Key Management ────────────────────────────────────────────────────

  app.get("/api/admin/api-keys", requireSuperAdmin, async (req, res, next) => {
    try {
      const keys = await getPrisma().apiKey.findMany({ orderBy: { createdAt: "desc" } });
      return res.json({
        success: true,
        data: keys.map((k) => ({
          id: k.id,
          partnerName: k.partnerName,
          orgId: k.orgId,
          tier: k.tier,
          enabled: k.enabled,
          lastUsedAt: k.lastUsedAt,
          createdAt: k.createdAt
        })),
        timestamp: new Date().toISOString()
      });
    } catch (err) { next(err); }
  });

  app.post("/api/admin/api-keys", requireSuperAdmin, validateBody(schemas.apiKeyCreate), async (req, res, next) => {
    try {
      const { partnerName, orgId, tier } = req.body || {};
      const { raw, hash } = generateApiKey("fai");
      const record = await getPrisma().apiKey.create({
        data: { keyHash: hash, partnerName, orgId: orgId || null, tier: tier || "standard" }
      });
      return res.status(201).json({
        success: true,
        data: { id: record.id, partnerName, apiKey: raw, tier: record.tier, createdAt: record.createdAt },
        timestamp: new Date().toISOString()
      });
    } catch (err) { next(err); }
  });

  app.delete("/api/admin/api-keys/:id", requireSuperAdmin, async (req, res, next) => {
    try {
      await getPrisma().apiKey.update({ where: { id: req.params.id }, data: { enabled: false } });
      return res.json({ success: true, data: { revoked: true }, timestamp: new Date().toISOString() });
    } catch (err) { next(err); }
  });

  app.post("/api/auth/admin/activate", async (req, res) => {
    const providedKey = (req.headers["x-setup-key"] || req.body?.setupKey || "").trim();
    if (!SETUP_ALLOWED || !SETUP_KEY || providedKey !== SETUP_KEY) {
      return res.status(403).json({ ok: false, error: "setup_key_required" });
    }
    const email = (req.body?.email || "").trim().toLowerCase();
    const orgId = (req.body?.orgId || "ORG_DEFAULT").trim();
    const role = (req.body?.role || "admin").trim();
    if (!email) {
      return res.status(400).json({ ok: false, error: "email_required" });
    }
    try {
      const data = await readData();
      const user = (data.users || []).find((u) => String(u.email || "").toLowerCase() === email);
      if (!user) {
        return res.status(404).json({ ok: false, error: "user_not_found" });
      }
      user.isActive = true;
      user.verified = true;
      user.orgId = user.orgId || orgId;
      user.role = role;
      user.status = "ACTIVE";
      user.mustSetPassword = true;
      user.requirePasswordReset = true;
      await writeData(data);
      return res.json({ ok: true, userId: user.id, role: user.role, orgId: user.orgId });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message || "activation_failed" });
    }
  });

  app.post("/api/admin/users", async (req, res) => {
    const providedKey = (req.headers["x-setup-key"] || req.body?.setupKey || "").trim();
    if (!SETUP_ALLOWED || !SETUP_KEY || providedKey !== SETUP_KEY) {
      return res.status(403).json({ ok: false, error: "setup_key_required" });
    }
    const email = (req.body?.email || "").trim().toLowerCase();
    const role = (req.body?.role || "customer").trim();
    const orgId = (req.body?.orgId || "ORG_DEFAULT").trim();
    if (!email) return res.status(400).json({ ok: false, error: "email_required" });
    try {
      const data = await readData();
      const exists = (data.users || []).find((u) => String(u.email || "").toLowerCase() === email);
      if (exists) return res.status(409).json({ ok: false, error: "user_exists" });
      const passwordHash = await bcrypt.hash(SETUP_KEY, 12);
      const user = {
        id: makeId("USR"),
        email,
        role,
        orgId,
        isActive: true,
        verified: true,
        createdAt: nowIso(),
        lastLoginAt: null,
        passwordHash,
        mustSetPassword: true,
        requirePasswordReset: true
      };
      data.users = Array.isArray(data.users) ? data.users : [];
      data.users.push(user);
      await writeData(data);
      return res.json({ ok: true, userId: user.id, orgId: user.orgId, role: user.role });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message || "create_user_failed" });
    }
  });
}

module.exports = {
  registerAdminRoutes,
  normalizeOrgStatus,
  normalizeLeadStatus,
  defaultBilling,
  defaultBillingSettings,
  defaultPaymentMethod,
  defaultFeatures
};
