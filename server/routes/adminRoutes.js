const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { getPrisma, createOrg, getOrg, updateOrg, listVehicles } = require("../db");

// Mirrors core org identity into Prisma (see orgManagementRoutes.js's
// mirrorOrgToPrisma for the full rationale — flat file stays authoritative
// for admin-only fields like billingPlan/notes; Prisma just needs a valid
// row so Vehicle/Driver/Pairing FK references and dashboard reads work).
async function mirrorAdminOrgToPrisma(org) {
  const existing = await getOrg(org.id);
  const fields = { name: org.name, status: org.status, email: org.primaryContactEmail || null, phone: org.phone || null, industry: org.industry || null };
  if (existing) await updateOrg(org.id, fields);
  else await createOrg({ id: org.id, ...fields });
}
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

// Roles an existing super admin is allowed to assign when creating users.
// Anything outside this set is rejected — prevents typos like "superadmin" or made-up roles.
const ASSIGNABLE_ROLES = new Set([
  "SUPER_ADMIN",
  "EMPLOYEE",
  "ORG_ADMIN",
  "CUSTOMER",
  "CUSTOMER_ADMIN",
  "CUSTOMER_USER",
  "CUSTOMER_VIEWER"
]);

function normalizeRole(role) {
  const upper = String(role || "").trim().toUpperCase();
  return ASSIGNABLE_ROLES.has(upper) ? upper : null;
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
    DEFAULT_SETTINGS,
    prismaAuthAdapter
  } = deps;

  function kindForRole(role) {
    const employeeRoles = new Set(["SUPER_ADMIN", "EMPLOYEE", "ADMIN", "SUPPORT", "SALES"]);
    return employeeRoles.has(String(role || "").toUpperCase()) ? "employee" : "customer";
  }

  function authOrgRecord(org) {
    return {
      id: org.id || org.orgId,
      name: org.name || "Fleet AI Org",
      status: org.status || "LEAD",
      email: org.primaryContactEmail || org.email || null,
      phone: org.phone || null,
      industry: org.industry || null
    };
  }

  function authUserRecord(user) {
    return Object.assign({}, user, {
      email: normalizeEmail(user.email),
      kind: user.kind || kindForRole(user.role),
      isActive: user.isActive !== false,
      active: user.active !== false,
      verified: user.verified !== false,
      passwordAlgo: user.passwordAlgo || "bcrypt"
    });
  }

  async function saveAdminUserToPrimary(user, data) {
    if (!prismaAuthAdapter) return;
    const org = user.orgId ? (data.orgs || []).find((item) => (item.id || item.orgId) === user.orgId) : null;
    await prismaAuthAdapter.saveData({
      users: [authUserRecord(user)],
      orgs: org ? [authOrgRecord(org)] : []
    });
  }

  async function reconcileAdminUsers(data, { persist = false } = {}) {
    data.users = Array.isArray(data.users) ? data.users : [];
    if (!prismaAuthAdapter) return { users: data.users, changed: false };
    const authData = await prismaAuthAdapter.loadData();
    let changed = false;
    const authEmails = new Set((authData.users || []).map((user) => normalizeEmail(user.email)));
    const staleUsers = data.users.filter((user) => normalizeEmail(user.email) && !authEmails.has(normalizeEmail(user.email)));
    if (staleUsers.length) {
      data.users = data.users.filter((user) => authEmails.has(normalizeEmail(user.email)));
      for (const user of staleUsers) {
        addAudit(data, "STALE_ADMIN_USER_INDEX_REMOVED", `${user.id || "unknown"}:${normalizeEmail(user.email)}`);
      }
      changed = true;
    }
    for (const authUser of authData.users || []) {
      const email = normalizeEmail(authUser.email);
      const indexed = data.users.find((user) => normalizeEmail(user.email) === email);
      if (!indexed) {
        data.users.push(authUserRecord(authUser));
        addAudit(data, "ADMIN_USER_INDEX_REPAIRED", `${authUser.id || "unknown"}:${email}`);
        changed = true;
      } else {
        const authoritative = authUserRecord(authUser);
        const fields = [
          "id", "email", "role", "kind", "orgId", "isActive", "active", "verified",
          "passwordHash", "passwordAlgo", "mustSetPassword", "requirePasswordReset",
          "firstLogin", "firstLoginRequired", "mustResetPassword", "isTemporaryPassword",
          "setupTokenHash", "setupTokenExpiresAt", "passwordLastSetAt", "lastPasswordChangeAt",
          "displayName", "lastLoginAt"
        ];
        if (fields.some((field) => indexed[field] !== authoritative[field])) {
          for (const field of fields) indexed[field] = authoritative[field];
          indexed.updatedAt = authoritative.updatedAt || nowIso();
          addAudit(data, "ADMIN_USER_INDEX_REALIGNED", `${authUser.id || "unknown"}:${email}`);
          changed = true;
        }
      }
    }
    if (changed && persist) await writeData(data);
    return { users: data.users, changed };
  }

  // ── Bootstrap setup endpoints ────────────────────────────────────────────

  app.get("/api/admin/setup/status", async (req, res, next) => {
    try {
      let hasSuperAdmin = false;
      if (prismaAuthAdapter) {
        try {
          const authData = await prismaAuthAdapter.loadData();
          hasSuperAdmin = (authData.users || []).some((u) => u.role === "SUPER_ADMIN");
        } catch (_) {
          const data = await readData();
          hasSuperAdmin = hasSuperAdminCached(data);
        }
      } else {
        const data = await readData();
        hasSuperAdmin = hasSuperAdminCached(data);
      }
      const enabled = SETUP_ALLOWED && !hasSuperAdmin;
      const reason = hasSuperAdmin
        ? "Setup already completed"
        : !SETUP_ALLOWED
          ? "Setup disabled in production"
          : "Setup available";
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
    const { setupKey: rawSetupKey, email, password } = req.body || {};
    const setupKey = (rawSetupKey || "").trim();
    console.log(`[admin-setup] attempt for ${email || "unknown"}`);
    // Setup key check: if SETUP_KEY is configured, validate it; otherwise allow (SETUP_ALLOWED already gates this)
    if (SETUP_KEY && setupKey !== SETUP_KEY) {
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
      const normalizedEmail = email.toLowerCase();
      const passwordHash = await bcrypt.hash(password, 12);

      // Try Prisma first (production with DATABASE_URL)
      let prisma = null;
      try { prisma = getPrisma(); } catch (_) {}

      if (prisma) {
        const existing = await prisma.user.findFirst({ where: { role: "SUPER_ADMIN" } });
        if (existing) return res.status(409).json({ error: "Setup already completed" });
        const emailExists = await prisma.user.findUnique({ where: { email: normalizedEmail } });
        if (emailExists) return res.status(409).json({ error: "User already exists." });
        await prisma.user.create({
          data: {
            email: normalizedEmail,
            role: "SUPER_ADMIN",
            kind: "employee",
            passwordHash,
            isActive: true,
            active: true,
            verified: true
          }
        });
      } else {
        // Dev fallback: write to JSON store
        const data = await readData();
        if (hasSuperAdminCached(data)) return res.status(409).json({ error: "Setup already completed" });
        const exists = (data.users || []).some((u) => u.email === normalizedEmail);
        if (exists) return res.status(409).json({ error: "User already exists." });
        data.users = data.users || [];
        data.audit = data.audit || [];
        data.users.push({
          id: makeId("EMP"),
          email: normalizedEmail,
          role: "SUPER_ADMIN",
          kind: "employee",
          isActive: true,
          passwordHash,
          createdAt: new Date().toISOString()
        });
        data.audit.push({ event: "SUPER_ADMIN_CREATED", email: normalizedEmail, ts: new Date().toISOString() });
        await writeData(data);
      }

      console.log(`[admin-setup] super admin created for ${normalizedEmail}`);
      res.status(201).json({ ok: true });
    } catch (err) {
      console.error("[admin-setup] error:", err.message, err.stack);
      res.status(500).json({ error: err.message || "Setup failed" });
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
      // Vehicles moved to Prisma this session — data.vehicles is always empty now.
      const activeVehicles = (await listVehicles()).length;
      const mrr = Object.values(billing).reduce((sum, b) => sum + (b.mrrEstimate || 0), 0);
      const closedStages = new Set(["CONVERTED", "CLOSED", "LOST"]);
      const openLeads = leads.filter((l) => !closedStages.has((l.stage || l.status || "").toUpperCase())).length;
      const leadsByStage = leads.reduce((acc, l) => {
        const key = l.stage || l.status || "UNKNOWN";
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {});
      const recentAlerts = (data.notifications || []).slice(0, 6).map((n) => ({
        type: n.title || n.type || "Alert",
        vehicleId: n.vehicle_id || "",
        explanation: n.body || "",
        ts: n.created_at || n.ts || null
      }));
      res.json({
        ok: true,
        data: { totalOrgs: orgs.length, activeOrgs, activePilots, activeVehicles, totalUsers: users.length, mrrEstimate: mrr, openLeads, leadsByStage, recentAlerts }
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
      await mirrorAdminOrgToPrisma(org);
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
      await mirrorAdminOrgToPrisma(org);
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
      await mirrorAdminOrgToPrisma(org);
      await writeData(data);
      res.json({ ok: true, data: org });
    } catch (err) {
      next(err);
    }
  });

  adminRouter.get("/users", async (req, res, next) => {
    try {
      const data = await readData();
      await reconcileAdminUsers(data, { persist: true });
      res.json({ ok: true, data: data.users || [] });
    } catch (err) {
      next(err);
    }
  });

  adminRouter.post("/users", async (req, res, next) => {
    const { email, role, orgId, password } = req.body || {};
    if (!email || !role) return res.status(400).json({ error: "email and role required" });
    const normalizedEmail = String(email).toLowerCase().trim();
    if (!/^[^@]+@[^@]+\.[^@]+$/.test(normalizedEmail)) {
      return res.status(400).json({ error: "Email must be a valid address." });
    }
    const normalizedRole = normalizeRole(role);
    if (!normalizedRole) {
      return res.status(400).json({ error: `Invalid role. Allowed: ${Array.from(ASSIGNABLE_ROLES).join(", ")}` });
    }
    if (password && password.length < 10) {
      return res.status(400).json({ error: "Password must be at least 10 characters." });
    }
    try {
      const data = await readData();
      data.users = data.users || [];
      await reconcileAdminUsers(data, { persist: true });
      const exists = data.users.some((u) => normalizeEmail(u.email) === normalizedEmail);
      if (exists) return res.status(409).json({ error: "User already exists" });
      const passwordHash = password ? await bcrypt.hash(password, 12) : "";
      const user = {
        id: makeId("USR"),
        email: normalizedEmail,
        role: normalizedRole,
        kind: kindForRole(normalizedRole),
        orgId: orgId || null,
        isActive: true,
        active: true,
        verified: true,
        createdAt: nowIso(),
        lastLoginAt: null,
        passwordHash,
        mustSetPassword: !password,
        requirePasswordReset: !password
      };
      await saveAdminUserToPrimary(user, data);
      data.users.push(user);
      addAudit(data, "USER_CREATED", `${user.id}:${user.email}:${user.role}`);
      await writeData(data);
      res.json({ ok: true, data: user });
    } catch (err) {
      next(err);
    }
  });

  // Create another super admin. Requires existing super admin session.
  // Issues a 15-min setup token; admin shares the returned setup URL with the new user.
  adminRouter.post("/super-admins", async (req, res, next) => {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: "email required" });
    const normalizedEmail = String(email).toLowerCase().trim();
    if (!/^[^@]+@[^@]+\.[^@]+$/.test(normalizedEmail)) {
      return res.status(400).json({ error: "Email must be a valid address." });
    }
    try {
      const data = await readData();
      data.users = data.users || [];
      await reconcileAdminUsers(data, { persist: true });
      if (data.users.some((u) => String(u.email || "").toLowerCase() === normalizedEmail)) {
        return res.status(409).json({ error: "User already exists." });
      }
      const setupToken = crypto.randomBytes(24).toString("hex");
      const setupTokenHash = crypto.createHash("sha256").update(setupToken).digest("hex");
      const setupTokenExpiresAt = Date.now() + 15 * 60 * 1000;
      const user = {
        id: makeId("EMP"),
        email: normalizedEmail,
        role: "SUPER_ADMIN",
        kind: "employee",
        orgId: null,
        isActive: true,
        active: true,
        verified: true,
        createdAt: nowIso(),
        lastLoginAt: null,
        passwordHash: "",
        mustSetPassword: true,
        requirePasswordReset: true,
        setupTokenHash,
        setupTokenExpiresAt
      };
      await saveAdminUserToPrimary(user, data);
      data.users.push(user);
      addAudit(data, "SUPER_ADMIN_INVITED", `${user.id}:${user.email}:by=${req.employee?.email || "unknown"}`);
      await writeData(data);
      console.log(`[admin] super admin invite created for ${user.email} by ${req.employee?.email || "unknown"}`);
      res.status(201).json({
        ok: true,
        data: { id: user.id, email: user.email, role: user.role },
        setupToken,
        setupTokenExpiresAt: new Date(setupTokenExpiresAt).toISOString(),
        setupPath: "/set-password.html"
      });
    } catch (err) {
      next(err);
    }
  });

  adminRouter.put("/users/:id", async (req, res, next) => {
    try {
      const data = await readData();
      await reconcileAdminUsers(data, { persist: true });
      const user = (data.users || []).find((u) => u.id === req.params.id);
      if (!user) return res.status(404).json({ error: "User not found" });
      const { email, orgId, isActive } = req.body || {};
      if (email !== undefined && normalizeEmail(email) !== normalizeEmail(user.email)) {
        return res.status(400).json({ error: "Email changes require creating a new account." });
      }
      if (orgId !== undefined) user.orgId = orgId || null;
      if (isActive !== undefined) user.isActive = Boolean(isActive);
      user.active = user.isActive !== false;
      addAudit(data, "USER_UPDATED", user.id);
      await saveAdminUserToPrimary(user, data);
      await writeData(data);
      res.json({ ok: true, data: user });
    } catch (err) {
      next(err);
    }
  });

  adminRouter.put("/users/:id/role", async (req, res, next) => {
    const { role } = req.body || {};
    if (!role) return res.status(400).json({ error: "role required" });
    const normalizedRole = normalizeRole(role);
    if (!normalizedRole) {
      return res.status(400).json({ error: `Invalid role. Allowed: ${Array.from(ASSIGNABLE_ROLES).join(", ")}` });
    }
    try {
      const data = await readData();
      await reconcileAdminUsers(data, { persist: true });
      const user = (data.users || []).find((u) => u.id === req.params.id);
      if (!user) return res.status(404).json({ error: "User not found" });
      user.role = normalizedRole;
      user.kind = kindForRole(normalizedRole);
      addAudit(data, "USER_ROLE_UPDATED", `${user.id}:${normalizedRole}:by=${req.employee?.email || "unknown"}`);
      await saveAdminUserToPrimary(user, data);
      await writeData(data);
      res.json({ ok: true, data: user });
    } catch (err) {
      next(err);
    }
  });

  adminRouter.put("/users/:id/disable", async (req, res, next) => {
    try {
      const data = await readData();
      await reconcileAdminUsers(data, { persist: true });
      const user = (data.users || []).find((u) => u.id === req.params.id);
      if (!user) return res.status(404).json({ error: "User not found" });
      user.isActive = false;
      user.active = false;
      addAudit(data, "USER_DISABLED", user.id);
      await saveAdminUserToPrimary(user, data);
      await writeData(data);
      res.json({ ok: true, data: user });
    } catch (err) {
      next(err);
    }
  });

  // NOTE: this file previously also had /invites, /billing/:orgId, and
  // /features/:orgId routes on adminRouter — confirmed dead (zero callers
  // anywhere in the repo; the admin UI's actual invite/billing/feature-flag
  // actions all go through orgManagementRoutes.js's separate, live endpoints
  // instead) and removed. This was also the only code path that ever wrote
  // data.billing[orgId].mrrEstimate, which is why the admin overview's MRR
  // KPI (adminRoutes.js "/overview" below) has always read as 0/-- — fixing
  // that needs a real decision about which of the two billing data models
  // (this dead one vs. orgManagementRoutes.js's org-embedded billing fields)
  // should be authoritative, not just resurrecting this dead code.

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
      const existingOrg = lead.orgId
        ? (data.orgs || []).find((item) => (item.id || item.orgId) === lead.orgId)
        : (data.orgs || []).find((item) => normalizeEmail(item.primaryContactEmail || item.email) === normalizeEmail(lead.contactEmail));
      if (existingOrg) {
        lead.stage = "CONVERTED";
        lead.status = "CONVERTED";
        lead.orgId = existingOrg.id || existingOrg.orgId;
        lead.updatedAt = nowIso();
        addAudit(data, "LEAD_CONVERSION_REUSED_ORG", `${lead.id}:${lead.orgId}`);
        await writeData(data);
        return res.json({ ok: true, data: { lead, org: existingOrg, reused: true } });
      }
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
      await mirrorAdminOrgToPrisma(org);
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
    const role = normalizeRole(req.body?.role || "ADMIN");
    if (!email) {
      return res.status(400).json({ ok: false, error: "email_required" });
    }
    if (!role) {
      return res.status(400).json({ ok: false, error: "invalid_role" });
    }
    try {
      const data = await readData();
      data.users = Array.isArray(data.users) ? data.users : [];
      const authData = prismaAuthAdapter ? await prismaAuthAdapter.loadData() : { users: [] };
      const indexedUser = data.users.find((u) => normalizeEmail(u.email) === email) || null;
      const authUser = (authData.users || []).find((u) => normalizeEmail(u.email) === email) || null;
      const user = authUser || indexedUser;
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
      user.kind = kindForRole(role);
      user.active = true;
      if (!indexedUser) data.users.push(user);
      else if (authUser) Object.assign(indexedUser, user);
      await saveAdminUserToPrimary(user, data);
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
    const requestedRole = (req.body?.role || "CUSTOMER").trim();
    const role = normalizeRole(requestedRole);
    const orgId = (req.body?.orgId || "ORG_DEFAULT").trim();
    if (!email) return res.status(400).json({ ok: false, error: "email_required" });
    if (!role) return res.status(400).json({ ok: false, error: "invalid_role" });
    try {
      const data = await readData();
      data.users = Array.isArray(data.users) ? data.users : [];
      await reconcileAdminUsers(data, { persist: true });
      const exists = data.users.find((u) => normalizeEmail(u.email) === email);
      if (exists) return res.status(409).json({ ok: false, error: "user_exists" });
      const passwordHash = await bcrypt.hash(SETUP_KEY, 12);
      const user = {
        id: makeId("USR"),
        email,
        role,
        kind: kindForRole(role),
        orgId,
        isActive: true,
        active: true,
        verified: true,
        createdAt: nowIso(),
        lastLoginAt: null,
        passwordHash,
        mustSetPassword: true,
        requirePasswordReset: true
      };
      await saveAdminUserToPrimary(user, data);
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
