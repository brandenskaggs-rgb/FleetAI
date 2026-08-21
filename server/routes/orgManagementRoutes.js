const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../db');
const {
  makeId, nowIso, addAudit, sanitizeString, normalizeEmail, parseNumberField,
  isExpired, generateTempPassword, publicUserView
} = require('../lib/utils');
const {
  normalizeOrgStatus, normalizeLeadStatus,
  defaultBillingSettings, defaultPaymentMethod, defaultFeatures
} = require('./adminRoutes');
const { validateBody, schemas } = require('../middleware/validate');

function registerOrgManagementRoutes(app, deps) {
  const { readData, writeData, requireEmployeeApi, requireCustomerApi, requireRole, getRateState, prismaAuthAdapter, revokeUserSessions } = deps;
  const employeeRoles = new Set(["SUPER_ADMIN", "ADMIN", "SUPPORT", "SALES"]);
  const customerAdminRoles = new Set(["ORG_ADMIN", "CUSTOMER_ADMIN", "CUSTOMER"]);

  function requireCustomerAdmin(req, res, next) {
    return requireCustomerApi(req, res, () => {
      const role = String(req.customer?.role || "").toUpperCase();
      if (!customerAdminRoles.has(role)) {
        return res.status(403).json({ ok: false, error: "customer_admin_required" });
      }
      return next();
    });
  }

  function serializeBilling(row, data) {
    const defaults = defaultBillingSettings(data);
    if (!row) return defaults;
    return {
      plan: row.plan,
      priceMonthly: Number(row.priceMonthly),
      status: row.status,
      activatedAt: row.activatedAt?.toISOString?.() || row.activatedAt || null,
      nextBillAt: row.nextBillAt?.toISOString?.() || row.nextBillAt || null,
      vehicleCount: Number(row.vehicleCount || 0),
      contractTermMonths: Number(row.contractTermMonths || 0),
      notes: row.notes || ""
    };
  }

  function serializePaymentMethod(row) {
    if (!row) return defaultPaymentMethod();
    return {
      type: row.type,
      billingName: row.billingName,
      billingEmail: row.billingEmail,
      last4: row.last4,
      expMonth: row.expMonth,
      expYear: row.expYear,
      brand: row.brand,
      postalCode: row.postalCode,
      accountType: row.accountType,
      routingLast4: row.routingLast4,
      accountLast4: row.accountLast4,
      updatedAt: row.updatedAt?.toISOString?.() || row.updatedAt || null
    };
  }

  async function loadOrgBilling(orgId, data) {
    const row = await db.getPrisma().orgBillingSettings.findUnique({ where: { orgId } });
    return serializeBilling(row, data);
  }

  async function saveOrgBilling(orgId, billing) {
    const values = {
      plan: sanitizeString(billing.plan || "PILOT_CORE", 80),
      priceMonthly: parseNumberField(billing.priceMonthly, 50),
      status: billing.status,
      activatedAt: billing.activatedAt ? new Date(billing.activatedAt) : null,
      nextBillAt: billing.nextBillAt ? new Date(billing.nextBillAt) : null,
      vehicleCount: Math.max(0, Math.trunc(parseNumberField(billing.vehicleCount, 0) || 0)),
      contractTermMonths: Math.max(0, Math.trunc(parseNumberField(billing.contractTermMonths, 0) || 0)),
      notes: sanitizeString(billing.notes || "", 2000)
    };
    return db.getPrisma().orgBillingSettings.upsert({
      where: { orgId },
      create: { orgId, ...values },
      update: values
    });
  }

  // Mirrors core org identity (name/status/email/phone) into Prisma so any
  // Vehicle/Driver/Pairing created against this orgId has a valid FK target,
  // and so Prisma-backed reads (e.g. /api/orgs/:orgId/public-profile in
  // fleetOpsRoutes.js) stay in sync. The flat file stays authoritative for the
  // admin-only fields (billingPlan, notes, fleetSizeEstimate, etc.) that don't
  // have a Prisma home yet — this is a deliberate dual-write, not a full
  // migration of the admin org-management panel.
  async function mirrorOrgToPrisma(org, { required = false } = {}) {
    try {
      const orgId = org.orgId || org.id;
      const existing = await db.getOrg(orgId);
      if (existing) {
        await db.updateOrg(orgId, {
          name: org.name,
          status: org.status,
          email: org.primaryContactEmail || null,
          phone: org.phone || null
        });
      } else {
        await db.createOrg({
          id: orgId,
          name: org.name,
          status: org.status,
          email: org.primaryContactEmail || null,
          phone: org.phone || null
        });
      }
      return true;
    } catch (err) {
      console.warn(`[ORG-SYNC] failed to mirror org to Prisma: ${err.message}`);
      if (required) throw err;
      return false;
    }
  }

  function orgIdOf(org) {
    return org?.orgId || org?.id || null;
  }

  function findOrgById(orgs, orgId) {
    if (!orgId) return null;
    return (orgs || []).find((org) => orgIdOf(org) === orgId) || null;
  }

  function isCustomerUser(user) {
    const role = String(user?.role || "").toUpperCase();
    return String(user?.kind || "").toLowerCase() === "customer"
      || role.startsWith("CUSTOMER")
      || role === "ORG_ADMIN";
  }

  function adminOrgFromAuth(authOrg) {
    const orgId = authOrg?.id;
    return {
      id: orgId,
      orgId,
      name: authOrg?.name || "Recovered Organization",
      status: normalizeOrgStatus(authOrg?.status || "PILOT"),
      primaryContactName: "",
      primaryContactEmail: normalizeEmail(authOrg?.email),
      phone: sanitizeString(authOrg?.phone, 80),
      fleetSizeEstimate: 0,
      activeVehicles: 0,
      billingPlan: "PILOT_CORE",
      notes: "Recovered from the primary account database.",
      recoveredFromAuthStore: true,
      createdAt: authOrg?.createdAt || nowIso(),
      updatedAt: authOrg?.updatedAt || nowIso()
    };
  }

  async function reconcileAuthOrganizations(data, { persist = false } = {}) {
    data.orgs = Array.isArray(data.orgs) ? data.orgs : [];
    let authData = { users: [], orgs: [] };
    if (prismaAuthAdapter) {
      try {
        authData = await prismaAuthAdapter.loadData();
      } catch (err) {
        console.warn(`[ORG-RECONCILE] unable to read primary account database: ${err.message}`);
      }
    }
    let changed = false;
    for (const authOrg of authData.orgs || []) {
      if (!authOrg?.id || findOrgById(data.orgs, authOrg.id)) continue;
      data.orgs.push(adminOrgFromAuth(authOrg));
      addAudit(data, "ORG_INDEX_REPAIRED", `${authOrg.id}:${authOrg.name || "unknown"}`);
      changed = true;
    }
    if (changed && persist) await writeData(data);
    return { authData, changed };
  }

  function canonicalCustomerOrgId(email, data, authData) {
    const cleanEmail = normalizeEmail(email);
    if (!cleanEmail) return null;
    const authUser = (authData?.users || []).find((user) => (
      isCustomerUser(user) && normalizeEmail(user.email) === cleanEmail && user.orgId
    ));
    if (authUser?.orgId) return authUser.orgId;
    const jsonUser = (data.users || []).find((user) => (
      isCustomerUser(user) && normalizeEmail(user.email) === cleanEmail && user.orgId
    ));
    return jsonUser?.orgId || null;
  }

  function duplicateOrgTarget(org, data, authData) {
    const email = normalizeEmail(org?.primaryContactEmail || org?.email);
    const canonicalOrgId = canonicalCustomerOrgId(email, data, authData);
    if (!canonicalOrgId || canonicalOrgId === orgIdOf(org)) return null;
    return canonicalOrgId;
  }

  function isEmployeeUser(user) {
    return employeeRoles.has(String(user?.role || "").toUpperCase())
      || String(user?.kind || "").toLowerCase() === "employee";
  }

  function employeeAuthRecord(user) {
    return Object.assign({}, user, {
      email: normalizeEmail(user.email),
      role: String(user.role || "EMPLOYEE").toUpperCase(),
      kind: "employee",
      orgId: null,
      status: user.status || "ACTIVE",
      isActive: user.isActive !== false,
      active: user.active !== false,
      verified: user.verified !== false,
      passwordAlgo: user.passwordAlgo || "bcrypt"
    });
  }

  async function reconcileEmployeeUsers(data, { persist = false } = {}) {
    data.users = Array.isArray(data.users) ? data.users : [];
    if (!prismaAuthAdapter) return { changed: false, authData: { users: [], orgs: [] } };

    const authData = await prismaAuthAdapter.loadData();
    const authEmployees = (authData.users || []).filter(isEmployeeUser);
    const authEmails = new Set(authEmployees.map((user) => normalizeEmail(user.email)));
    let changed = false;

    const indexedEmployees = data.users.filter(isEmployeeUser);
    const staleEmployees = indexedEmployees.filter((user) => !authEmails.has(normalizeEmail(user.email)));
    if (staleEmployees.length) {
      const staleEmails = new Set(staleEmployees.map((user) => normalizeEmail(user.email)));
      data.users = data.users.filter((user) => !isEmployeeUser(user) || !staleEmails.has(normalizeEmail(user.email)));
      for (const user of staleEmployees) {
        addAudit(data, "STALE_EMPLOYEE_INDEX_REMOVED", `${user.id || "unknown"}:${normalizeEmail(user.email)}`);
      }
      changed = true;
    }

    for (const authUser of authEmployees) {
      const email = normalizeEmail(authUser.email);
      const indexed = data.users.find((user) => normalizeEmail(user.email) === email);
      if (!indexed) {
        data.users.push(employeeAuthRecord(authUser));
        addAudit(data, "EMPLOYEE_INDEX_REPAIRED", `${authUser.id || "unknown"}:${email}`);
        changed = true;
        continue;
      }
      const authoritative = employeeAuthRecord(authUser);
      const fields = [
        "id", "email", "role", "kind", "orgId", "status", "isActive", "active", "verified",
        "passwordHash", "passwordAlgo", "mustSetPassword", "requirePasswordReset",
        "mustResetPassword", "isTemporaryPassword", "setupTokenHash", "setupTokenExpiresAt",
        "passwordLastSetAt", "lastPasswordChangeAt", "displayName", "lastLoginAt"
      ];
      if (fields.some((field) => indexed[field] !== authoritative[field])) {
        for (const field of fields) indexed[field] = authoritative[field];
        indexed.updatedAt = authoritative.updatedAt || nowIso();
        addAudit(data, "EMPLOYEE_INDEX_REALIGNED", `${authUser.id || "unknown"}:${email}`);
        changed = true;
      }
    }

    if (changed && persist) await writeData(data);
    return { changed, authData };
  }
  app.get("/api/leads/public-status", (req, res) => {
    res.json({ ok: true });
  });
  
  async function handleCreateLead(req, res, next, leadTypeOverride, sourceOverride) {
    const ipKey = req.ip || req.socket.remoteAddress || "local";
    const rate = getRateState(`lead:${ipKey}`);
    if (!rate.allowed) {
      return res.status(429).json({ error: "Too many requests. Try again later." });
    }
    const raw = req.body || {};
    const companyName = sanitizeString(raw.companyName, 200);
    const contactName = sanitizeString(raw.contactName, 200);
    const contactEmail = normalizeEmail(raw.email || raw.contactEmail);
    const contactPhone = sanitizeString(raw.phone || raw.contactPhone, 80);
    const fleetSize = sanitizeString(raw.fleetSize, 50);
    const message = sanitizeString(raw.message, 1200);
    const leadTypeRaw = String(leadTypeOverride || raw.leadType || "DEMO").toUpperCase();
    const sourcePage = sanitizeString(sourceOverride || raw.sourcePage, 120);
    if (!companyName || !contactName || !contactEmail) {
      return res.status(400).json({ error: "companyName, contactName, and email are required." });
    }
    try {
      const data = await readData();
      const leadId = makeId("LEAD");
      const lead = {
        id: leadId,
        leadId,
        companyName,
        contactName,
        contactEmail,
        contactPhone,
        fleetSize,
        message,
        leadType: leadTypeRaw === "PILOT" ? "PILOT" : "DEMO",
        sourcePage: sourcePage || "web",
        status: "NEW",
        orgId: null,
        internalNotes: "",
        createdAt: nowIso(),
        updatedAt: nowIso()
      };
      data.leads = data.leads || [];
      data.leads.unshift(lead);
      addAudit(data, "LEAD_CREATED", leadId);
      await writeData(data);
      res.status(201).json({ ok: true, data: lead });
    } catch (err) {
      next(err);
    }
  }
  
  app.post("/api/leads", validateBody(schemas.leadCreate), (req, res, next) => handleCreateLead(req, res, next));
  app.post("/api/leads/request-demo", validateBody(schemas.leadCreate), (req, res, next) => handleCreateLead(req, res, next, "DEMO", "request-demo"));
  app.post("/api/leads/pilot-apply", validateBody(schemas.leadCreate), (req, res, next) => handleCreateLead(req, res, next, "PILOT", "pilot"));
  app.post("/api/leads/apply-pilot", validateBody(schemas.leadCreate), (req, res, next) => handleCreateLead(req, res, next, "PILOT", "pilot"));
  
  app.get("/api/overview", requireEmployeeApi, async (req, res, next) => {
    try {
      const data = await readData();
      const orgs = data.orgs || [];
      const leads = data.leads || [];
      const activeOrgs = orgs.filter((o) => normalizeOrgStatus(o.status) === "ACTIVE").length;
      const activeVehicles = orgs.reduce((sum, o) => {
        const count = Number(o.activeVehicles ?? o.fleetSizeEstimate ?? 0);
        return sum + (Number.isFinite(count) ? count : 0);
      }, 0);
      const mrr = orgs.reduce((sum, o) => {
        const status = normalizeOrgStatus(o.status);
        const plan = String(o.billingPlan || "PILOT_CORE").toUpperCase();
        if (status !== "ACTIVE" || plan !== "PILOT_CORE") return sum;
        const count = Number(o.activeVehicles ?? o.fleetSizeEstimate ?? 0);
        const vehicles = Number.isFinite(count) ? count : 0;
        return sum + vehicles * 50;
      }, 0);
      const leadsByStatus = leads.reduce((acc, l) => {
        const status = normalizeLeadStatus(l.status || l.stage);
        acc[status] = (acc[status] || 0) + 1;
        return acc;
      }, {});
      const openLeadStatuses = new Set(["NEW", "CONTACTED", "SCHEDULED", "QUALIFIED"]);
      const openLeads = leads.filter((l) => openLeadStatuses.has(normalizeLeadStatus(l.status || l.stage))).length;
      const recentAlerts = (data.alerts || []).slice(0, 6);
      res.json({
        ok: true,
        data: {
          totalOrgs: orgs.length,
          activeOrgs,
          activeVehicles,
          mrrEstimate: mrr,
          leadsByStatus,
          openLeads,
          recentAlerts
        }
      });
    } catch (err) {
      next(err);
    }
  });
  
  app.get("/api/audit", requireEmployeeApi, async (req, res, next) => {
    try {
      const data = await readData();
      res.json({ ok: true, data: (data.audit || []).slice(0, 100) });
    } catch (err) {
      next(err);
    }
  });
  
  app.get("/api/orgs", requireEmployeeApi, async (req, res, next) => {
    try {
      const data = await readData();
      const { authData } = await reconcileAuthOrganizations(data, { persist: true });
      const includeDeleted = req.query.includeDeleted === "1" || req.query.includeDeleted === "true";
      const orgs = (data.orgs || [])
        .filter((org) => {
          const isDeleted = String(org.status || "").toUpperCase() === "DELETED" || Boolean(org.deletedAt);
          const duplicateOf = duplicateOrgTarget(org, data, authData);
          if (includeDeleted) return true;
          return !isDeleted && !duplicateOf;
        })
        .map((org) => {
        const orgId = org.orgId || org.id || makeId("ORG");
        return Object.assign({}, org, {
          id: org.id || orgId,
          orgId,
          status: normalizeOrgStatus(org.status || "LEAD"),
          billingPlan: org.billingPlan || "PILOT_CORE",
          activeVehicles: Number.isFinite(Number(org.activeVehicles)) ? Number(org.activeVehicles) : 0,
          fleetSizeEstimate: Number.isFinite(Number(org.fleetSizeEstimate)) ? Number(org.fleetSizeEstimate) : 0,
          duplicateOf: duplicateOrgTarget(org, data, authData)
        });
      });
      orgs.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
      res.json({ ok: true, data: orgs });
    } catch (err) {
      next(err);
    }
  });
  
  app.post("/api/orgs", requireEmployeeApi, requireRole(["SUPER_ADMIN"]), validateBody(schemas.orgCreate), async (req, res, next) => {
    const raw = req.body || {};
    const name = sanitizeString(raw.name, 200);
    const primaryContactName = sanitizeString(raw.primaryContactName, 200);
    const primaryContactEmail = normalizeEmail(raw.primaryContactEmail);
    if (!name) return res.status(400).json({ error: "name required" });
    if (!primaryContactName || !primaryContactEmail) {
      return res.status(400).json({ error: "primaryContactName and primaryContactEmail required" });
    }
    try {
      const data = await readData();
      const orgId = makeId("ORG");
      const org = {
        id: orgId,
        orgId,
        name,
        status: normalizeOrgStatus(raw.status),
        primaryContactName,
        primaryContactEmail,
        phone: sanitizeString(raw.phone, 80),
        fleetSizeEstimate: Number.isFinite(Number(raw.fleetSizeEstimate)) ? Number(raw.fleetSizeEstimate) : 0,
        activeVehicles: Number.isFinite(Number(raw.activeVehicles)) ? Number(raw.activeVehicles) : 0,
        billingPlan: sanitizeString(raw.billingPlan, 80) || "PILOT_CORE",
        notes: sanitizeString(raw.notes, 1200),
        createdAt: nowIso(),
        updatedAt: nowIso()
      };
      data.orgs = data.orgs || [];
      data.orgs.push(org);
      addAudit(data, "ORG_CREATED", `${orgId}:${org.name}`);
      await mirrorOrgToPrisma(org, { required: true });
      await writeData(data);
      res.status(201).json({ ok: true, data: org });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/orgs/:orgId", requireEmployeeApi, async (req, res, next) => {
    try {
      const data = await readData();
      await reconcileAuthOrganizations(data, { persist: true });
      const org = (data.orgs || []).find((o) => (o.orgId || o.id) === req.params.orgId || o.id === req.params.orgId);
      if (!org) return res.status(404).json({ error: "Org not found" });
      const orgId = org.orgId || org.id;
      res.json({
        ok: true,
        data: Object.assign({}, org, {
          id: org.id || orgId,
          orgId,
          status: normalizeOrgStatus(org.status),
          billingPlan: org.billingPlan || "PILOT_CORE",
          activeVehicles: Number.isFinite(Number(org.activeVehicles)) ? Number(org.activeVehicles) : 0,
          fleetSizeEstimate: Number.isFinite(Number(org.fleetSizeEstimate)) ? Number(org.fleetSizeEstimate) : 0
        })
      });
    } catch (err) {
      next(err);
    }
  });
  
  app.patch("/api/orgs/:orgId", requireEmployeeApi, requireRole(["SUPER_ADMIN"]), async (req, res, next) => {
    try {
      const data = await readData();
      const org = (data.orgs || []).find((o) => (o.orgId || o.id) === req.params.orgId || o.id === req.params.orgId);
      if (!org) return res.status(404).json({ error: "Org not found" });
      const raw = req.body || {};
      if (raw.name !== undefined) org.name = sanitizeString(raw.name, 200);
      if (raw.status !== undefined) org.status = normalizeOrgStatus(raw.status);
      if (raw.primaryContactName !== undefined) org.primaryContactName = sanitizeString(raw.primaryContactName, 200);
      if (raw.primaryContactEmail !== undefined) org.primaryContactEmail = normalizeEmail(raw.primaryContactEmail);
      if (raw.phone !== undefined) org.phone = sanitizeString(raw.phone, 80);
      if (raw.fleetSizeEstimate !== undefined) {
        org.fleetSizeEstimate = Number.isFinite(Number(raw.fleetSizeEstimate)) ? Number(raw.fleetSizeEstimate) : 0;
      }
      if (raw.activeVehicles !== undefined) {
        org.activeVehicles = Number.isFinite(Number(raw.activeVehicles)) ? Number(raw.activeVehicles) : 0;
      }
      if (raw.billingPlan !== undefined) org.billingPlan = sanitizeString(raw.billingPlan, 80);
      if (raw.billingContactName !== undefined) org.billingContactName = sanitizeString(raw.billingContactName, 200);
      if (raw.billingEmail !== undefined) org.billingEmail = normalizeEmail(raw.billingEmail);
      if (raw.paymentMethodType !== undefined) org.paymentMethodType = sanitizeString(raw.paymentMethodType, 20);
      if (raw.last4 !== undefined) org.last4 = sanitizeString(raw.last4, 4);
      if (raw.accountLast4 !== undefined) org.accountLast4 = sanitizeString(raw.accountLast4, 4);
      if (raw.billingExpMonth !== undefined) org.billingExpMonth = sanitizeString(raw.billingExpMonth, 2);
      if (raw.billingExpYear !== undefined) org.billingExpYear = sanitizeString(raw.billingExpYear, 4);
      if (raw.billingUpdatedAt !== undefined) org.billingUpdatedAt = sanitizeString(raw.billingUpdatedAt, 64);
      if (raw.notes !== undefined) org.notes = sanitizeString(raw.notes, 1200);
      org.updatedAt = nowIso();
      addAudit(data, "ORG_UPDATED", org.orgId || org.id || "unknown");
      await mirrorOrgToPrisma(org, { required: true });
      await writeData(data);
      res.json({ ok: true, data: org });
    } catch (err) {
      next(err);
    }
  });

  app.delete("/api/orgs/:orgId", requireEmployeeApi, requireRole(["SUPER_ADMIN"]), async (req, res, next) => {
    try {
      const data = await readData();
      const org = (data.orgs || []).find((o) => (o.orgId || o.id) === req.params.orgId || o.id === req.params.orgId);
      if (!org) return res.status(404).json({ error: "Org not found" });
      if (String(org.status || "").toUpperCase() === "DELETED") {
        return res.json({ ok: true, data: org });
      }
      org.status = "DELETED";
      org.deletedAt = nowIso();
      org.deletedBy = req.employee?.userId || req.employee?.email || "system";
      org.updatedAt = nowIso();
      addAudit(data, "ORG_DELETED", `${org.orgId || org.id}:${org.deletedBy}`);
      await mirrorOrgToPrisma(org, { required: true });
      await writeData(data);
      res.json({ ok: true, data: org });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/orgs/:orgId/restore", requireEmployeeApi, requireRole(["SUPER_ADMIN"]), async (req, res, next) => {
    try {
      const data = await readData();
      const org = (data.orgs || []).find((o) => (o.orgId || o.id) === req.params.orgId || o.id === req.params.orgId);
      if (!org) return res.status(404).json({ error: "Org not found" });
      org.status = "ACTIVE";
      org.deletedAt = null;
      org.deletedBy = null;
      org.updatedAt = nowIso();
      addAudit(data, "ORG_RESTORED", `${org.orgId || org.id}`);
      await mirrorOrgToPrisma(org, { required: true });
      await writeData(data);
      res.json({ ok: true, data: org });
    } catch (err) {
      next(err);
    }
  });
  
  app.get("/api/leads", requireEmployeeApi, async (req, res, next) => {
    try {
      const data = await readData();
      const leads = (data.leads || []).map((lead) => {
        const leadId = lead.leadId || lead.id;
        return Object.assign({}, lead, {
          id: lead.id || leadId,
          leadId,
          status: normalizeLeadStatus(lead.status || lead.stage)
        });
      });
      leads.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
      res.json({ ok: true, data: leads });
    } catch (err) {
      next(err);
    }
  });
  
  app.get("/api/leads/:leadId", requireEmployeeApi, async (req, res, next) => {
    try {
      const data = await readData();
      const lead = (data.leads || []).find((l) => (l.leadId || l.id) === req.params.leadId || l.id === req.params.leadId);
      if (!lead) return res.status(404).json({ error: "Lead not found" });
      const leadId = lead.leadId || lead.id;
      res.json({ ok: true, data: Object.assign({}, lead, { id: lead.id || leadId, leadId, status: normalizeLeadStatus(lead.status || lead.stage) }) });
    } catch (err) {
      next(err);
    }
  });
  
  app.patch("/api/leads/:leadId", requireEmployeeApi, requireRole(["SUPER_ADMIN", "ADMIN", "SUPPORT"]), async (req, res, next) => {
    try {
      const data = await readData();
      const lead = (data.leads || []).find((l) => (l.leadId || l.id) === req.params.leadId || l.id === req.params.leadId);
      if (!lead) return res.status(404).json({ error: "Lead not found" });
      const raw = req.body || {};
      if (raw.status !== undefined) {
        lead.status = normalizeLeadStatus(raw.status);
        lead.stage = lead.status;
      }
      if (raw.internalNotes !== undefined) lead.internalNotes = sanitizeString(raw.internalNotes, 2000);
      lead.updatedAt = nowIso();
      addAudit(data, "LEAD_UPDATED", lead.leadId || lead.id || "unknown");
      await writeData(data);
      res.json({ ok: true, data: lead });
    } catch (err) {
      next(err);
    }
  });
  
  app.post("/api/leads/:leadId/convert", requireEmployeeApi, requireRole(["SUPER_ADMIN"]), async (req, res, next) => {
    try {
      const data = await readData();
      data.users = Array.isArray(data.users) ? data.users : [];
      const { authData, changed: repairedOrgIndex } = await reconcileAuthOrganizations(data);
      const lead = (data.leads || []).find((l) => (l.leadId || l.id) === req.params.leadId || l.id === req.params.leadId);
      if (!lead) return res.status(404).json({ error: "Lead not found" });
      const leadEmail = normalizeEmail(lead.contactEmail || lead.email);
      const canonicalOrgId = canonicalCustomerOrgId(leadEmail, data, authData);
      const existingOrg = findOrgById(data.orgs, canonicalOrgId)
        || findOrgById(data.orgs, lead.orgId)
        || (data.orgs || []).find((org) => (
          leadEmail
          && normalizeEmail(org.primaryContactEmail || org.email) === leadEmail
          && String(org.status || "").toUpperCase() !== "DELETED"
        ));

      if (existingOrg) {
        const existingOrgId = orgIdOf(existingOrg);
        const linkChanged = lead.orgId !== existingOrgId || normalizeLeadStatus(lead.status || lead.stage) !== "CONVERTED";
        lead.status = "CONVERTED";
        lead.stage = "CONVERTED";
        lead.orgId = existingOrgId;
        lead.updatedAt = nowIso();
        if (linkChanged) {
          addAudit(data, "LEAD_CONVERSION_REUSED_ORG", `${lead.leadId || lead.id}:${existingOrgId}`);
        }
        if (linkChanged || repairedOrgIndex) await writeData(data);
        return res.json({ ok: true, data: { lead, org: existingOrg, reused: true, recovered: Boolean(existingOrg.recoveredFromAuthStore) } });
      }

      const status = normalizeOrgStatus(req.body?.status || "PILOT");
      const orgId = makeId("ORG");
      const org = {
        id: orgId,
        orgId,
        name: lead.companyName || "New Organization",
        status,
        primaryContactName: lead.contactName || "",
        primaryContactEmail: lead.contactEmail || "",
        phone: lead.contactPhone || "",
        fleetSizeEstimate: Number.isFinite(Number(lead.fleetSize)) ? Number(lead.fleetSize) : 0,
        activeVehicles: 0,
        billingPlan: "PILOT_CORE",
        notes: lead.message || "",
        createdAt: nowIso(),
        updatedAt: nowIso()
      };
      data.orgs = data.orgs || [];
      data.orgs.push(org);
      lead.status = "CONVERTED";
      lead.stage = "CONVERTED";
      lead.orgId = orgId;
      lead.updatedAt = nowIso();
      addAudit(data, "ORG_CREATED", `${orgId}:${org.name}`);
      addAudit(data, "LEAD_CONVERTED_TO_ORG", `${lead.leadId || lead.id}:${orgId}`);
      await mirrorOrgToPrisma(org, { required: true });
      await writeData(data);
      res.json({ ok: true, data: { lead, org } });
    } catch (err) {
      next(err);
    }
  });
  
  app.get("/api/employees", requireEmployeeApi, async (req, res, next) => {
    try {
      const data = await readData();
      await reconcileEmployeeUsers(data, { persist: true });
      const employees = (data.users || []).filter(isEmployeeUser);
      res.json({ ok: true, data: employees.map(publicUserView) });
    } catch (err) {
      next(err);
    }
  });
  
  app.post("/api/employees", requireEmployeeApi, requireRole(["SUPER_ADMIN"]), async (req, res, next) => {
    const { email, role } = req.body || {};
    const roles = Array.from(employeeRoles);
    const cleanEmail = normalizeEmail(email);
    if (!cleanEmail || !role || !roles.includes(role)) {
      return res.status(400).json({ error: "Valid email and role required." });
    }
    try {
      const data = await readData();
      await reconcileEmployeeUsers(data, { persist: true });
      const exists = (data.users || []).some((u) => normalizeEmail(u.email) === cleanEmail);
      if (exists) return res.status(409).json({ error: "User already exists" });
      const tempPassword = generateTempPassword();
      const passwordHash = await bcrypt.hash(tempPassword, 12);
      const user = {
        id: makeId("USR"),
        email: cleanEmail,
        role,
        kind: "employee",
        orgId: null,
        status: "ACTIVE",
        isActive: true,
        active: true,
        verified: true,
        mustSetPassword: true,
        requirePasswordReset: true,
        mustResetPassword: true,
        isTemporaryPassword: true,
        tempPasswordIssuedAt: nowIso(),
        passwordAlgo: "bcrypt",
        createdAt: nowIso(),
        lastLoginAt: null,
        passwordHash
      };
      if (prismaAuthAdapter) {
        await prismaAuthAdapter.saveData({ users: [user], orgs: [] });
      }
      data.users.push(user);
      addAudit(data, "USER_CREATED", `${user.id}:${user.email}`);
      await writeData(data);
      res.status(201).json({ ok: true, data: { email: user.email, role: user.role, tempPassword } });
    } catch (err) {
      next(err);
    }
  });
  
  function isCustomerAccountForOrg(user, orgId) {
    if (!user) return false;
    const role = String(user.role || "").toUpperCase();
    return (role.startsWith("CUSTOMER") || role === "ORG_ADMIN") && user.orgId === orgId;
  }

  function authOrgRecord(org) {
    return {
      id: org.orgId || org.id,
      name: org.name || "Fleet AI Org",
      status: org.status || "PILOT",
      email: org.primaryContactEmail || null,
      phone: org.phone || null
    };
  }

  async function handleCreateCustomerLogin(req, res, next) {
    try {
      const rate = getRateState(`cust-create:${req.employee?.userId || req.employee?.email || "unknown"}`);
      if (!rate.allowed) return res.status(429).json({ error: "Too many requests. Try again later." });
      const data = await readData();
      data.users = Array.isArray(data.users) ? data.users : [];
      const org = (data.orgs || []).find((o) => (o.orgId || o.id) === req.params.orgId || o.id === req.params.orgId);
      if (!org) return res.status(404).json({ error: "Org not found" });
      if (String(org.status || "").toUpperCase() === "DELETED") {
        return res.status(400).json({ error: "Org is deleted" });
      }
      const email = normalizeEmail(req.body?.email || org.primaryContactEmail);
      if (!email) return res.status(400).json({ error: "Valid email required" });
      const orgId = org.orgId || org.id;
      const jsonUser = data.users.find((u) => normalizeEmail(u.email) === email) || null;
      const { authData, changed: repairedOrgIndex } = await reconcileAuthOrganizations(data);
      const authUser = (authData?.users || []).find((u) => normalizeEmail(u.email) === email) || null;

      // The database-backed auth record is authoritative. If a repeated lead
      // conversion created a second org for the same contact, return the
      // original org so the employee console can open and repair it instead of
      // trapping the operator behind a generic duplicate-email error.
      if (authUser) {
        if (!isCustomerAccountForOrg(authUser, orgId)) {
          const canonicalOrg = findOrgById(data.orgs, authUser.orgId);
          const sameCustomerIdentity = duplicateOrgTarget(org, data, authData) === authUser.orgId
            || normalizeEmail(org.primaryContactEmail || org.email) === email;
          if (sameCustomerIdentity && canonicalOrg) {
            if (repairedOrgIndex) await writeData(data);
            return res.json({
              ok: true,
              data: {
                email,
                alreadyExists: true,
                redirectOrgId: authUser.orgId,
                existingOrgName: canonicalOrg.name || authUser.orgId,
                recovered: Boolean(canonicalOrg.recoveredFromAuthStore)
              }
            });
          }
          return res.status(409).json({
            code: "EMAIL_IN_USE_BY_ORG",
            error: "That email belongs to a different Fleet AI company account.",
            existingOrgId: authUser.orgId || null,
            existingOrgName: canonicalOrg?.name || null
          });
        }
        if (!jsonUser) {
          data.users.push(authUser);
          addAudit(data, "CUSTOMER_LOGIN_INDEX_REPAIRED", `${authUser.id}:${email}`);
          await writeData(data);
        } else if (!isCustomerAccountForOrg(jsonUser, orgId)) {
          Object.assign(jsonUser, authUser);
          addAudit(data, "CUSTOMER_LOGIN_INDEX_REALIGNED", `${authUser.id}:${email}:${orgId}`);
          await writeData(data);
        } else if (repairedOrgIndex) {
          await writeData(data);
        }
        return res.json({ ok: true, data: { email, alreadyExists: true } });
      }

      if (jsonUser) {
        if (!isCustomerAccountForOrg(jsonUser, orgId)) {
          return res.status(409).json({
            code: "EMAIL_IN_USE_BY_ORG",
            error: "That email belongs to a different Fleet AI company account.",
            existingOrgId: jsonUser.orgId || null,
            existingOrgName: findOrgById(data.orgs, jsonUser.orgId)?.name || null
          });
        }
        let tempPassword = null;
        if (!jsonUser.passwordHash) {
          tempPassword = generateTempPassword();
          jsonUser.passwordHash = await bcrypt.hash(tempPassword, 12);
          jsonUser.mustSetPassword = true;
          jsonUser.requirePasswordReset = true;
          jsonUser.mustResetPassword = true;
          jsonUser.isTemporaryPassword = true;
        }
        if (prismaAuthAdapter) {
          await prismaAuthAdapter.saveData({ users: [jsonUser], orgs: [authOrgRecord(org)] });
        }
        addAudit(data, "CUSTOMER_LOGIN_AUTH_REPAIRED", `${jsonUser.id}:${email}`);
        await writeData(data);
        return res.json({ ok: true, data: { email, repaired: true, tempPassword } });
      }

      const tempPassword = generateTempPassword();
      const passwordHash = await bcrypt.hash(tempPassword, 12);
      const user = {
        id: makeId("USR"),
        email,
        role: "ORG_ADMIN",
        kind: "customer",
        orgId,
        displayName: sanitizeString(req.body?.contactName || org.primaryContactName || "", 200),
        status: "ACTIVE",
        isActive: true,
        active: true,
        verified: true,
        isTemporaryPassword: true,
        mustSetPassword: true,
        requirePasswordReset: true,
        mustResetPassword: true,
        tempPasswordIssuedAt: nowIso(),
        passwordLastSetAt: null,
        lastPasswordChangeAt: null,
        createdAt: nowIso(),
        lastLoginAt: null,
        passwordHash
      };
      // Write the login authority first. If the secondary JSON index fails,
      // the customer can still authenticate and a retry repairs the index.
      if (prismaAuthAdapter) {
        await prismaAuthAdapter.saveData({ users: [user], orgs: [authOrgRecord(org)] });
      }
      data.users.push(user);
      addAudit(data, "CUSTOMER_LOGIN_CREATED", `${user.id}:${user.email}`);
      await writeData(data);
      res.status(201).json({ ok: true, data: { email: user.email, tempPassword } });
    } catch (err) {
      next(err);
    }
  }

  app.post("/api/orgs/:orgId/create-customer-login", requireEmployeeApi, requireRole(["SUPER_ADMIN"]), handleCreateCustomerLogin);
  app.post("/api/orgs/:orgId/customer/create", requireEmployeeApi, requireRole(["SUPER_ADMIN"]), handleCreateCustomerLogin);
  
  app.post("/api/orgs/:orgId/customer/reset-password", requireEmployeeApi, requireRole(["SUPER_ADMIN"]), async (req, res, next) => {
    try {
      const rate = getRateState(`cust-reset:${req.employee?.userId || req.employee?.email || "unknown"}`);
      if (!rate.allowed) return res.status(429).json({ error: "Too many requests. Try again later." });
      const data = await readData();
      const orgId = req.params.orgId;
      const org = (data.orgs || []).find((o) => (o.orgId || o.id) === orgId || o.id === orgId);
      if (!org) return res.status(404).json({ error: "Org not found" });
      if (String(org.status || "").toUpperCase() === "DELETED") {
        return res.status(400).json({ error: "Org is deleted" });
      }
      const email = normalizeEmail(req.body?.email || org.primaryContactEmail);
      if (!email) return res.status(400).json({ error: "Valid email required" });
      data.users = Array.isArray(data.users) ? data.users : [];
      const jsonUser = data.users.find((u) => normalizeEmail(u.email) === email) || null;
      const authData = prismaAuthAdapter ? await prismaAuthAdapter.loadData() : null;
      const authUser = (authData?.users || []).find((u) => normalizeEmail(u.email) === email) || null;
      const user = jsonUser || authUser;
      if (!user) return res.status(404).json({ error: "Customer user not found" });
      if (!isCustomerAccountForOrg(user, orgId)) {
        return res.status(409).json({ error: "Customer account does not belong to this organization" });
      }
      const tempPassword = generateTempPassword();
      user.passwordHash = await bcrypt.hash(tempPassword, 12);
      user.mustResetPassword = true;
      user.requirePasswordReset = true;
      user.isTemporaryPassword = true;
      user.mustSetPassword = true;
      user.tempPasswordIssuedAt = nowIso();
      user.lastPasswordChangeAt = null;
      user.passwordLastSetAt = null;
      user.status = user.status || "ACTIVE";
      user.kind = "customer";
      user.isActive = true;
      user.active = true;
      user.verified = true;
      user.lastLoginAt = null;
      if (!jsonUser) data.users.push(user);
      addAudit(data, "CUSTOMER_PASSWORD_RESET", `${user.id}:${user.email}`);
      if (prismaAuthAdapter) {
        await prismaAuthAdapter.saveData({ users: [user], orgs: [authOrgRecord(org)] });
      }
      if (typeof revokeUserSessions === "function") await revokeUserSessions(user.id);
      await writeData(data);
      res.json({ ok: true, data: { email: user.email, tempPassword } });
    } catch (err) {
      next(err);
    }
  });
  
  app.get("/api/invites", requireEmployeeApi, requireRole(["SUPER_ADMIN"]), async (req, res, next) => {
    try {
      const data = await readData();
      res.json({ ok: true, data: data.invites || [] });
    } catch (err) {
      next(err);
    }
  });
  
  app.post("/api/invites", requireEmployeeApi, requireRole(["SUPER_ADMIN"]), async (req, res, next) => {
    const { orgId, type } = req.body || {};
    if (!orgId || !type) return res.status(400).json({ error: "orgId and type required" });
    const normalizedType = String(type).trim().toUpperCase();
    if (!["CUSTOMER", "FLEET_MANAGER", "DRIVER"].includes(normalizedType)) {
      return res.status(400).json({ error: "Invalid invite type." });
    }
    try {
      const data = await readData();
      if (!findOrgById(data.orgs, orgId)) return res.status(404).json({ error: "Organization not found" });
      const token = crypto.randomBytes(16).toString("hex");
      const hours = data.settings?.inviteExpiryHours || 72;
      const invite = {
        id: makeId("INV"),
        orgId,
        type: normalizedType,
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
  
  app.get("/api/orgs/:orgId/feature-flags", requireEmployeeApi, async (req, res, next) => {
    try {
      const data = await readData();
      data.featureFlags = data.featureFlags || {};
      const flags = data.featureFlags[req.params.orgId] || defaultFeatures(req.params.orgId);
      res.json({ ok: true, data: flags });
    } catch (err) {
      next(err);
    }
  });
  
  app.patch("/api/orgs/:orgId/feature-flags", requireEmployeeApi, requireRole(["SUPER_ADMIN"]), async (req, res, next) => {
    try {
      const data = await readData();
      data.featureFlags = data.featureFlags || {};
      const current = data.featureFlags[req.params.orgId] || defaultFeatures(req.params.orgId);
      const updates = req.body || {};
      const nextFlags = Object.assign({}, current, updates, { updatedAt: nowIso() });
      data.featureFlags[req.params.orgId] = nextFlags;
      addAudit(data, "FEATURES_UPDATED", req.params.orgId);
      await writeData(data);
      res.json({ ok: true, data: nextFlags });
    } catch (err) {
      next(err);
    }
  });
  
  app.get("/api/org/billing", requireCustomerApi, async (req, res, next) => {
    try {
      const data = await readData();
      const billing = await loadOrgBilling(req.customer.orgId, data);
      res.json({ ok: true, data: billing });
    } catch (err) {
      next(err);
    }
  });
  
  app.post("/api/org/billing", requireCustomerAdmin, async (req, res, next) => {
    try {
      const data = await readData();
      const current = await loadOrgBilling(req.customer.orgId, data);
      const updates = req.body || {};
      const allowedStatus = ["NONE", "PILOT", "ACTIVE"];
      if (updates.status && !allowedStatus.includes(updates.status)) {
        return res.status(400).json({ error: "Invalid billing status." });
      }
      const nextBilling = Object.assign({}, current, updates);
      nextBilling.plan = nextBilling.plan || "PILOT_CORE";
      nextBilling.priceMonthly = nextBilling.priceMonthly || data.settings?.defaultPilotPrice || 50;
      if (updates.status === "ACTIVE" && !current.activatedAt) {
        const activatedAt = nowIso();
        const nextDate = new Date();
        nextDate.setDate(nextDate.getDate() + 30);
        nextBilling.activatedAt = activatedAt;
        nextBilling.nextBillAt = nextDate.toISOString();
      }
      if (updates.status === "NONE") {
        nextBilling.activatedAt = null;
        nextBilling.nextBillAt = null;
      }
      const saved = await saveOrgBilling(req.customer.orgId, nextBilling);
      addAudit(data, "ORG_BILLING_UPDATED", req.customer.orgId);
      await writeData(data);
      res.json({ ok: true, data: serializeBilling(saved, data) });
    } catch (err) {
      next(err);
    }
  });
  
  app.get("/api/org/billing-settings", requireCustomerApi, async (req, res, next) => {
    try {
      const data = await readData();
      const billing = await loadOrgBilling(req.customer.orgId, data);
      res.json({ ok: true, data: billing });
    } catch (err) {
      next(err);
    }
  });
  
  app.post("/api/org/billing-settings", requireCustomerAdmin, async (req, res, next) => {
    try {
      const data = await readData();
      const current = await loadOrgBilling(req.customer.orgId, data);
      const updates = req.body || {};
      const allowedStatus = ["NONE", "PILOT", "ACTIVE"];
      if (updates.status && !allowedStatus.includes(updates.status)) {
        return res.status(400).json({ error: "Invalid billing status." });
      }
      const nextBilling = Object.assign({}, current, updates);
      nextBilling.plan = nextBilling.plan || "PILOT_CORE";
      nextBilling.priceMonthly = nextBilling.priceMonthly || data.settings?.defaultPilotPrice || 50;
      if (updates.status === "ACTIVE" && !current.activatedAt) {
        const activatedAt = nowIso();
        const nextDate = new Date();
        nextDate.setDate(nextDate.getDate() + 30);
        nextBilling.activatedAt = activatedAt;
        nextBilling.nextBillAt = nextDate.toISOString();
      }
      if (updates.status === "NONE") {
        nextBilling.activatedAt = null;
        nextBilling.nextBillAt = null;
      }
      const saved = await saveOrgBilling(req.customer.orgId, nextBilling);
      addAudit(data, "ORG_BILLING_UPDATED", req.customer.orgId);
      await writeData(data);
      res.json({ ok: true, data: serializeBilling(saved, data) });
    } catch (err) {
      next(err);
    }
  });
  
  app.get("/api/billing/settings", (req, res, next) => {
    req.url = "/api/org/billing-settings";
    app.handle(req, res, next);
  });
  
  app.post("/api/billing/settings", (req, res, next) => {
    req.url = "/api/org/billing-settings";
    app.handle(req, res, next);
  });
  
  app.get("/api/org/payment-method", requireCustomerApi, async (req, res, next) => {
    try {
      const payment = serializePaymentMethod(await db.getPrisma().paymentMethod.findUnique({ where: { orgId: req.customer.orgId } }));
      res.json({ ok: true, data: payment });
    } catch (err) {
      next(err);
    }
  });
  
  app.post("/api/org/payment-method", requireCustomerAdmin, async (req, res, next) => {
    try {
      const payload = req.body || {};
      const allowedTypes = ["CARD_STUB", "ACH_STUB"];
      if (!allowedTypes.includes(payload.type)) {
        return res.status(400).json({ error: "Invalid payment method type." });
      }
      if (!payload.billingName || !payload.billingEmail) {
        return res.status(400).json({ error: "Billing name and email required." });
      }
      if (!/^[^@]+@[^@]+\.[^@]+$/.test(payload.billingEmail)) {
        return res.status(400).json({ error: "Billing email must be valid." });
      }
      const data = await readData();
      let payment;
      if (payload.type === "CARD_STUB") {
        if (!/^\d{4}$/.test(payload.last4 || "")) {
          return res.status(400).json({ error: "Card last 4 must be exactly 4 digits." });
        }
        const expMonth = Number(payload.expMonth);
        const expYear = Number(payload.expYear);
        const currentYear = new Date().getFullYear();
        if (!Number.isFinite(expMonth) || expMonth < 1 || expMonth > 12) {
          return res.status(400).json({ error: "Expiration month must be 1-12." });
        }
        if (!Number.isFinite(expYear) || expYear < currentYear) {
          return res.status(400).json({ error: "Expiration year must be current year or later." });
        }
        payment = {
          type: payload.type,
          billingName: payload.billingName.trim(),
          billingEmail: payload.billingEmail.trim(),
          last4: payload.last4.trim(),
          expMonth,
          expYear,
          brand: typeof payload.brand === "string" ? payload.brand.slice(0, 20) : "",
          postalCode: typeof payload.postalCode === "string" ? payload.postalCode.slice(0, 20) : "",
          accountType: "",
          routingLast4: "",
          accountLast4: "",
          updatedAt: nowIso()
        };
      } else {
        if (!/^\d{4}$/.test(payload.accountLast4 || "")) {
          return res.status(400).json({ error: "Account last 4 must be exactly 4 digits." });
        }
        const accountType = payload.accountType === "CHECKING" || payload.accountType === "SAVINGS"
          ? payload.accountType
          : "";
        if (!accountType) {
          return res.status(400).json({ error: "Account type required." });
        }
        payment = {
          type: payload.type,
          billingName: payload.billingName.trim(),
          billingEmail: payload.billingEmail.trim(),
          last4: "",
          expMonth: 1,
          expYear: new Date().getFullYear(),
          brand: "",
          postalCode: "",
          accountType,
          routingLast4: typeof payload.routingLast4 === "string" ? payload.routingLast4.slice(-4) : "",
          accountLast4: payload.accountLast4.trim(),
          updatedAt: nowIso()
        };
      }
      const values = Object.assign({}, payment);
      delete values.updatedAt;
      const saved = await db.getPrisma().paymentMethod.upsert({
        where: { orgId: req.customer.orgId },
        create: { orgId: req.customer.orgId, ...values },
        update: values
      });
      addAudit(data, "PAYMENT_METHOD_UPDATED", req.customer.orgId);
      await writeData(data);
      res.json({ ok: true, data: serializePaymentMethod(saved) });
    } catch (err) {
      next(err);
    }
  });
  
  app.get("/api/billing/payment-method", (req, res, next) => {
    req.url = "/api/org/payment-method";
    app.handle(req, res, next);
  });
  
  app.post("/api/billing/payment-method", (req, res, next) => {
    req.url = "/api/org/payment-method";
    app.handle(req, res, next);
  });
  
  app.get("/api/invites/:token", async (req, res, next) => {
    try {
      const data = await readData();
      const invite = (data.invites || []).find((i) => i.token === req.params.token);
      if (!invite) return res.status(404).json({ error: "Invite not found" });
      if (isExpired(invite.expiresAt)) {
        return res.status(410).json({ error: "Invite expired" });
      }
      res.json({
        ok: true,
        data: {
          id: invite.id,
          orgId: invite.orgId,
          type: invite.type,
          expiresAt: invite.expiresAt
        }
      });
    } catch (err) {
      next(err);
    }
  });
  
  app.post("/api/invites/:token/accept", validateBody(schemas.inviteAccept), async (req, res, next) => {
    const { password, email } = req.body || {};
    if (!password || password.length < 10) {
      return res.status(400).json({ error: "Password must be at least 10 characters." });
    }
    try {
      const data = await readData();
      const inviteIndex = (data.invites || []).findIndex((i) => i.token === req.params.token);
      if (inviteIndex === -1) return res.status(404).json({ error: "Invite not found" });
      const invite = data.invites[inviteIndex];
      if (isExpired(invite.expiresAt)) {
        return res.status(410).json({ error: "Invite expired" });
      }
      const org = findOrgById(data.orgs, invite.orgId);
      if (!org) return res.status(410).json({ error: "Invite organization is no longer available" });
      const userEmail = (email || "").trim().toLowerCase();
      if (!userEmail || !/^[^@]+@[^@]+\.[^@]+$/.test(userEmail)) {
        return res.status(400).json({ error: "Valid email required." });
      }
      data.users = Array.isArray(data.users) ? data.users : [];
      const authData = prismaAuthAdapter ? await prismaAuthAdapter.loadData() : { users: [] };
      const exists = data.users.some((u) => normalizeEmail(u.email) === userEmail)
        || (authData.users || []).some((u) => normalizeEmail(u.email) === userEmail);
      if (exists) return res.status(409).json({ error: "User already exists" });
      const roleByInviteType = {
        CUSTOMER: "ORG_ADMIN",
        FLEET_MANAGER: "CUSTOMER_ADMIN",
        DRIVER: "CUSTOMER_USER"
      };
      const role = roleByInviteType[String(invite.type || "").toUpperCase()];
      if (!role) return res.status(400).json({ error: "Invite type is invalid" });
      const passwordHash = await bcrypt.hash(password, 12);
      const user = {
        id: makeId("USR"),
        email: userEmail,
        role,
        kind: "customer",
        orgId: invite.orgId || null,
        status: "ACTIVE",
        isActive: true,
        active: true,
        verified: true,
        passwordAlgo: "bcrypt",
        mustSetPassword: false,
        requirePasswordReset: false,
        mustResetPassword: false,
        isTemporaryPassword: false,
        createdAt: nowIso(),
        lastLoginAt: null,
        passwordHash
      };
      if (prismaAuthAdapter) {
        await prismaAuthAdapter.saveData({
          users: [user],
          orgs: org ? [authOrgRecord(org)] : []
        });
      }
      data.users.push(user);
      data.invites.splice(inviteIndex, 1);
      addAudit(data, "INVITE_ACCEPTED", invite.id);
      await writeData(data);
      res.json({ ok: true, data: { userId: user.id, role: user.role } });
    } catch (err) {
      next(err);
    }
  });
}

module.exports = { registerOrgManagementRoutes };
