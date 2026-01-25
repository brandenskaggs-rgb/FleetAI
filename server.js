const path = require("path");
const fs = require("fs");
const fsp = require("fs/promises");
const https = require("https");
const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");

// Env loading (root first, backend second overrides)
const rootEnvPath = path.resolve(__dirname, ".env");
const backendEnvPath = path.resolve(__dirname, "backend", ".env");
const rootEnvExists = fs.existsSync(rootEnvPath);
const backendEnvExists = fs.existsSync(backendEnvPath);
if (rootEnvExists) {
  require("dotenv").config({ path: rootEnvPath, override: false });
}
if (backendEnvExists) {
  require("dotenv").config({ path: backendEnvPath, override: true });
}

const app = express();
const PORT = process.env.PORT || 3000;
const SITE_ROOT = path.resolve(__dirname);
const UI_DIR = path.resolve(__dirname, "ui");
const ADMIN_DIR = path.resolve(__dirname, "admin");
const DRIVER_DIR = path.resolve(__dirname, "driver_app");
const CSS_DIR = path.resolve(__dirname, "css");
const JS_DIR = path.resolve(__dirname, "js");
const ASSETS_DIR = path.resolve(__dirname, "assets");
const DATA_PATH = path.resolve(__dirname, "server", "data.json");
const SETUP_KEY = (process.env.FLEETAI_SETUP_KEY || "").trim();
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const AI_ENABLED = (process.env.AI_ENABLED || "").toLowerCase() === "true";
const SESSION_COOKIE = "fleetai_session";
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const CUSTOMER_SESSION_COOKIE = "fleetai_customer_session";
const customerSessionStore = new Map();
const DEFAULT_DATA = {
  users: [],
  orgs: [],
  audit: [],
  tenantSettings: {
    companyName: "Fleet AI",
    logoUrl: "",
    themeMode: "blue",
    accentColor: ""
  },
  settings: {
    defaultPilotPrice: 59,
    inviteExpiryHours: 72,
    maintenanceMode: false
  },
  vehicles: [],
  drivers: [],
  pairings: []
};

function hasSuperAdminCached(data) {
  return (data.users || []).some((u) => u.role === "SUPER_ADMIN");
}
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 5;
const RATE_LOCK_MS = 15 * 60 * 1000;
const rateState = new Map();
const sessionStore = new Map();

app.use(express.json({ limit: "256kb" }));

app.get("/", (req, res) => {
  res.sendFile(path.join(SITE_ROOT, "index.html"));
});

app.get("/privacy.html", (req, res) => {
  res.redirect(302, "/legal/privacy.html");
});

app.get("/terms.html", (req, res) => {
  res.redirect(302, "/legal/terms.html");
});

app.get("/admin/setup", (req, res) => {
  res.redirect(302, "/admin/setup.html");
});

app.get("/legal/privacy.html", (req, res) => {
  res.sendFile(path.join(SITE_ROOT, "legal", "privacy.html"));
});

app.get("/legal/privacy", (req, res) => {
  res.redirect(302, "/legal/privacy.html");
});

app.get("/legal/terms.html", (req, res) => {
  res.sendFile(path.join(SITE_ROOT, "legal", "terms.html"));
});

app.get("/legal/terms", (req, res) => {
  res.redirect(302, "/legal/terms.html");
});

app.get("/legal/legal/terms.html", (req, res) => {
  res.redirect(301, "/legal/terms.html");
});

app.get("/legal/legal/privacy.html", (req, res) => {
  res.redirect(301, "/legal/privacy.html");
});

// Convenience POST proxy to align with UI expectations if called directly
app.post("/admin/setup", (req, res) => {
  req.url = "/api/admin/setup";
  app.handle(req, res);
});

app.get("/employee/login", (req, res) => {
  res.redirect(302, "/employee-login.html");
});

app.get("/employee-portal.html", requireSuperAdmin, (req, res) => {
  res.sendFile(path.join(SITE_ROOT, "employee-portal.html"));
});

app.use("/", express.static(SITE_ROOT));
app.use("/ui", express.static(UI_DIR));
app.use("/admin", express.static(ADMIN_DIR));
app.use("/driver_app", express.static(DRIVER_DIR));
app.use("/css", express.static(CSS_DIR));
app.use("/js", express.static(JS_DIR));
app.use("/assets", express.static(ASSETS_DIR));

// Health check
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "fleet-ai", time: new Date().toISOString() });
});

app.get("/vehicles", async (req, res, next) => {
  try {
    const data = await readData();
    res.json(data.vehicles || []);
  } catch (err) {
    next(err);
  }
});

app.post("/vehicles/create", async (req, res, next) => {
  const { vehicleId, unitName, vin, type } = req.body || {};
  if (!vehicleId || !unitName || !vin || !type) {
    return res.status(400).json({ error: "vehicleId, unitName, vin, type required" });
  }
  try {
    const data = await readData();
    const exists = data.vehicles.some((v) => v.vehicleId === vehicleId);
    if (exists) {
      return res.status(409).json({ error: "Vehicle already exists" });
    }
    const vehicle = { vehicleId, unitName, vin, type, createdAt: nowIso() };
    data.vehicles.push(vehicle);
    await writeData(data);
    res.json(vehicle);
  } catch (err) {
    next(err);
  }
});

app.get("/drivers", async (req, res, next) => {
  try {
    const data = await readData();
    res.json(data.drivers || []);
  } catch (err) {
    next(err);
  }
});

app.post("/drivers/create", async (req, res, next) => {
  const { firstName, lastName, phone } = req.body || {};
  if (!firstName || !lastName || !phone) {
    return res.status(400).json({ error: "firstName, lastName, phone required" });
  }
  try {
    const data = await readData();
    const driverId = `DRIVER_${generateDigits(5)}`;
    const driver = { driverId, firstName, lastName, phone, createdAt: nowIso() };
    data.drivers.push(driver);
    await writeData(data);
    res.json({ driverId });
  } catch (err) {
    next(err);
  }
});

app.post("/pairings/generate", async (req, res, next) => {
  const { vehicleId, driverId } = req.body || {};
  if (!vehicleId || !driverId) {
    return res.status(400).json({ error: "vehicleId and driverId required" });
  }
  try {
    const data = await readData();
    const vehicle = data.vehicles.find((v) => v.vehicleId === vehicleId);
    const driver = data.drivers.find((d) => d.driverId === driverId);
    if (!vehicle || !driver) {
      return res.status(404).json({ error: "Vehicle or driver not found" });
    }
    const pairingCode = generatePairingCode();
    const driverPin = generateDriverPin();
    const expiresAt = new Date(Date.now() + 10 * 60000).toISOString();
    const driverPinExpiresAt = new Date(Date.now() + 10 * 60000).toISOString();
    const pairing = {
      pairingCode,
      vehicleId,
      driverId,
      driverPin,
      driverPinExpiresAt,
      status: "pending",
      expiresAt,
      createdAt: nowIso()
    };
    data.pairings.push(pairing);
    await writeData(data);
    res.json({ pairingCode, expiresAt, driverPin, driverPinExpiresAt });
  } catch (err) {
    next(err);
  }
});

app.post("/pairings/claim", async (req, res, next) => {
  const { pairingCode, deviceId, deviceLabel } = req.body || {};
  if (!pairingCode || !deviceId || !deviceLabel) {
    return res.status(400).json({ error: "pairingCode, deviceId, deviceLabel required" });
  }
  try {
    const data = await readData();
    const pairing = data.pairings.find((p) => p.pairingCode === pairingCode);
    if (!pairing) {
      return res.status(404).json({ error: "Invalid code" });
    }
    if (pairing.status !== "pending") {
      return res.status(409).json({ error: "Code already used" });
    }
    if (isExpired(pairing.expiresAt) || isExpired(pairing.driverPinExpiresAt)) {
      pairing.status = "expired";
      await writeData(data);
      return res.status(410).json({ error: "Expired code" });
    }
    pairing.status = "active";
    pairing.deviceId = deviceId;
    pairing.deviceLabel = deviceLabel;
    pairing.claimedAt = nowIso();
    pairing.lastSeen = nowIso();
    await writeData(data);
    res.json({ vehicleId: pairing.vehicleId, driverId: pairing.driverId, status: pairing.status });
  } catch (err) {
    next(err);
  }
});

app.get("/pairings/active", async (req, res, next) => {
  try {
    const data = await readData();
    const now = Date.now();
    (data.pairings || []).forEach((p) => {
      if (p.status === "pending" && p.expiresAt) {
        const expired = new Date(p.expiresAt).getTime() <= now;
        if (expired) p.status = "expired";
      }
      if (p.driverPinExpiresAt) {
        const pinExpired = new Date(p.driverPinExpiresAt).getTime() <= now;
        if (pinExpired && p.status !== "expired") p.status = "expired";
      }
    });
    await writeData(data);
    res.json(data.pairings || []);
  } catch (err) {
    next(err);
  }
});

app.post("/auth/driverLogin", async (req, res, next) => {
  const { companyCode, driverPin } = req.body || {};
  if (!companyCode || !driverPin) {
    return res.status(400).json({ error: "companyCode and driverPin required" });
  }
  try {
    const data = await readData();
    const pairing = (data.pairings || []).find((p) => p.driverPin === driverPin);
    if (!pairing) {
      return res.status(401).json({ error: "Invalid PIN" });
    }
    if (isExpired(pairing.driverPinExpiresAt) || isExpired(pairing.expiresAt)) {
      pairing.status = "expired";
      await writeData(data);
      return res.status(410).json({ error: "PIN expired" });
    }
    const driver = data.drivers.find((d) => d.driverId === pairing.driverId);
    res.json({
      tenantId: companyCode,
      driverId: driver ? driver.driverId : pairing.driverId,
      vehicleId: pairing.vehicleId,
      pairingCode: pairing.pairingCode,
      token: `token_${pairing.driverId}`,
      driverName: driver ? `${driver.firstName} ${driver.lastName}` : pairing.driverId
    });
  } catch (err) {
    next(err);
  }
});

async function ensureDataFile() {
  try {
    await fsp.access(DATA_PATH);
  } catch (err) {
    await atomicWrite(DATA_PATH, JSON.stringify(DEFAULT_DATA, null, 2));
  }
}

function normalizeData(data) {
  const out = typeof data === "object" && data ? data : {};
  out.users = Array.isArray(out.users) ? out.users : [];
  out.orgs = Array.isArray(out.orgs) ? out.orgs : [];
  out.audit = Array.isArray(out.audit) ? out.audit : [];
  out.vehicles = Array.isArray(out.vehicles) ? out.vehicles : [];
  out.drivers = Array.isArray(out.drivers) ? out.drivers : [];
  out.pairings = Array.isArray(out.pairings) ? out.pairings : [];
  out.tenantSettings = Object.assign({}, DEFAULT_DATA.tenantSettings, out.tenantSettings || {});
  out.settings = Object.assign({}, DEFAULT_DATA.settings, out.settings || {});
  return out;
}

async function readData() {
  await ensureDataFile();
  const raw = await fsp.readFile(DATA_PATH, "utf-8");
  return normalizeData(JSON.parse(raw));
}

async function writeData(data) {
  await atomicWrite(DATA_PATH, JSON.stringify(data, null, 2));
}

async function atomicWrite(filePath, contents) {
  const tempPath = `${filePath}.tmp`;
  await fsp.writeFile(tempPath, contents, "utf-8");
  await fsp.rename(tempPath, filePath);
}

function getRateState(key) {
  const now = Date.now();
  const entry = rateState.get(key) || { count: 0, resetAt: now + RATE_WINDOW_MS, lockedUntil: 0 };
  if (entry.lockedUntil && now < entry.lockedUntil) {
    return { allowed: false, locked: true };
  }
  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + RATE_WINDOW_MS;
  }
  entry.count += 1;
  if (entry.count > RATE_MAX) {
    entry.lockedUntil = now + RATE_LOCK_MS;
    rateState.set(key, entry);
    return { allowed: false, locked: true };
  }
  rateState.set(key, entry);
  return { allowed: true, locked: false };
}

function parseCookies(cookieHeader) {
  if (!cookieHeader) return {};
  return cookieHeader.split(";").reduce((acc, part) => {
    const [name, ...rest] = part.trim().split("=");
    if (!name) return acc;
    acc[name] = decodeURIComponent(rest.join("="));
    return acc;
  }, {});
}

function setSessionCookie(res, sessionId) {
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}; HttpOnly; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
  );
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0`);
}

function getSession(req) {
  const cookies = parseCookies(req.headers.cookie || "");
  const sessionId = cookies[SESSION_COOKIE];
  if (!sessionId) return null;
  const session = sessionStore.get(sessionId);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessionStore.delete(sessionId);
    return null;
  }
  return session;
}

function setCustomerSessionCookie(res, sessionId) {
  res.setHeader(
    "Set-Cookie",
    `${CUSTOMER_SESSION_COOKIE}=${encodeURIComponent(sessionId)}; HttpOnly; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
  );
}

function clearCustomerSessionCookie(res) {
  res.setHeader("Set-Cookie", `${CUSTOMER_SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0`);
}

function getCustomerSession(req) {
  const cookies = parseCookies(req.headers.cookie || "");
  const sessionId = cookies[CUSTOMER_SESSION_COOKIE];
  if (!sessionId) return null;
  const session = customerSessionStore.get(sessionId);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    customerSessionStore.delete(sessionId);
    return null;
  }
  return session;
}

function requireEmployeeSession(req, res, next) {
  const session = getSession(req);
  if (!session) {
    return res.redirect("/employee-login.html");
  }
  req.employee = session;
  next();
}

function requireSuperAdmin(req, res, next) {
  const session = getSession(req);
  if (!session) {
    if (req.path.startsWith("/api")) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    return res.redirect("/employee-login.html");
  }
  if (session.role !== "SUPER_ADMIN") {
    if (req.path.startsWith("/api")) {
      return res.status(403).json({ error: "Forbidden" });
    }
    return res.redirect("/employee-login.html");
  }
  req.employee = session;
  next();
}

function nowIso() {
  return new Date().toISOString();
}

function generateDigits(length) {
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += Math.floor(Math.random() * 10);
  }
  return out;
}

function generateDriverPin() {
  return generateDigits(6);
}

function generatePairingCode() {
  return generateDigits(6);
}

function isExpired(expiresAt) {
  const ts = new Date(expiresAt).getTime();
  return Number.isFinite(ts) && ts <= Date.now();
}

function aiEnabled() {
  if (!OPENAI_API_KEY) return false;
  if (AI_ENABLED) return true;
  return Boolean(OPENAI_API_KEY);
}

function postJson(url, payload, headers = {}) {
  const data = JSON.stringify(payload);
  const target = new URL(url);
  const options = {
    method: "POST",
    hostname: target.hostname,
    path: `${target.pathname}${target.search}`,
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(data),
      ...headers
    }
  };
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let raw = "";
      res.on("data", (chunk) => (raw += chunk));
      res.on("end", () => resolve({ status: res.statusCode || 500, body: raw }));
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function addAudit(data, event, detail) {
  data.audit = Array.isArray(data.audit) ? data.audit : [];
  data.audit.unshift({
    id: `AUD_${Date.now()}`,
    event,
    detail: detail || "",
    createdAt: nowIso()
  });
  if (data.audit.length > 500) {
    data.audit = data.audit.slice(0, 500);
  }
}

app.get("/api/admin/setup/status", async (req, res, next) => {
  try {
    const data = await readData();
    const hasSuperAdmin = hasSuperAdminCached(data);
    const enabled = !hasSuperAdmin && Boolean(SETUP_KEY);
    const reason = hasSuperAdmin
      ? "Setup already completed"
      : SETUP_KEY
        ? "Setup available"
        : "Setup key not configured on server";
    res.json({ enabled, hasSuperAdmin, reason });
  } catch (err) {
    next(err);
  }
});

app.get("/api/setup/status", (req, res) => {
  // Alias for compatibility
  req.url = "/api/admin/setup/status";
  app.handle(req, res);
});

async function handleCreateSuperAdmin(req, res, next) {
  const ipKey = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "local";
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
    const hasSuperAdmin = hasSuperAdminCached(data);
    if (hasSuperAdmin) {
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
    data.audit.push({
      event: "SUPER_ADMIN_CREATED",
      email: user.email,
      ts: new Date().toISOString()
    });
    await writeData(data);
    console.log(`[admin-setup] super admin created for ${user.email}`);
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
}

app.post("/api/admin/setup", handleCreateSuperAdmin);
app.post("/api/setup/create-super-admin", handleCreateSuperAdmin);

function makeId(prefix) {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
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

function defaultFeatures(orgId) {
  return {
    orgId,
    aiAdvisor: true,
    safetyPack: false,
    compliancePack: false,
    cameraIntegration: false,
    advancedDiagnostics: false,
    updatedAt: nowIso()
  };
}

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
      data: {
        totalOrgs: orgs.length,
        activeOrgs,
        activePilots,
        activeVehicles,
        totalUsers: users.length,
        mrrEstimate: mrr,
        leadsByStage
      }
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
  const { name, industry, fleetSize, status, notes } = req.body || {};
  if (!name) {
    return res.status(400).json({ error: "Org name required" });
  }
  try {
    const data = await readData();
    const org = {
      id: makeId("ORG"),
      name,
      status: status || "DEMO",
      industry: industry || "",
      fleetSize: Number.isFinite(fleetSize) ? fleetSize : 0,
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
    org.status = status;
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
    const before = data.invites || [];
    data.invites = before.filter((i) => i.id !== req.params.id);
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
  const { companyName, contactName, contactEmail, contactPhone, stage, demoDate, notes } = req.body || {};
  if (!companyName) return res.status(400).json({ error: "companyName required" });
  try {
    const data = await readData();
    const lead = {
      id: makeId("LEAD"),
      companyName,
      contactName: contactName || "",
      contactEmail: contactEmail || "",
      contactPhone: contactPhone || "",
      stage: stage || "LEAD",
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
    Object.assign(lead, req.body || {});
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
    lead.stage = "WON";
    lead.updatedAt = nowIso();
    addAudit(data, "LEAD_CONVERTED", `${lead.id}:${org.id}`);
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
    res.json({ ok: true, data: data.settings || DEFAULT_DATA.settings });
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

app.get("/api/invites/:token", async (req, res, next) => {
  try {
    const data = await readData();
    const invite = (data.invites || []).find((i) => i.token === req.params.token);
    if (!invite) return res.status(404).json({ error: "Invite not found" });
    if (isExpired(invite.expiresAt)) {
      return res.status(410).json({ error: "Invite expired" });
    }
    res.json({ ok: true, data: invite });
  } catch (err) {
    next(err);
  }
});

app.post("/api/invites/:token/accept", async (req, res, next) => {
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
    const userEmail = (email || "").toLowerCase();
    if (!userEmail || !/^[^@]+@[^@]+\.[^@]+$/.test(userEmail)) {
      return res.status(400).json({ error: "Valid email required." });
    }
    const exists = (data.users || []).some((u) => u.email === userEmail);
    if (exists) return res.status(409).json({ error: "User already exists" });
    const role = invite.type === "DRIVER" ? "DRIVER" : invite.type === "FLEET_MANAGER" ? "FLEET_MANAGER" : "ADMIN";
    const passwordHash = await bcrypt.hash(password, 12);
    const user = {
      id: makeId("USR"),
      email: userEmail,
      role,
      orgId: invite.orgId || null,
      isActive: true,
      createdAt: nowIso(),
      lastLoginAt: null,
      passwordHash
    };
    data.users.push(user);
    data.invites.splice(inviteIndex, 1);
    addAudit(data, "INVITE_ACCEPTED", invite.id);
    await writeData(data);
    res.json({ ok: true, data: { userId: user.id, role: user.role } });
  } catch (err) {
    next(err);
  }
});

app.post("/api/auth/login-customer", async (req, res, next) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: "Missing email or password." });
  }
  try {
    const data = await readData();
    const user = (data.users || []).find((u) => u.email === email.toLowerCase());
    if (!user || !user.passwordHash || !user.isActive) {
      return res.status(401).json({ error: "Invalid credentials." });
    }
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      return res.status(401).json({ error: "Invalid credentials." });
    }
    const sessionId = crypto.randomBytes(24).toString("hex");
    const session = {
      id: sessionId,
      userId: user.id,
      email: user.email,
      role: user.role,
      orgId: user.orgId || null,
      createdAt: nowIso(),
      expiresAt: Date.now() + SESSION_TTL_MS
    };
    customerSessionStore.set(sessionId, session);
    setCustomerSessionCookie(res, sessionId);
    user.lastLoginAt = nowIso();
    await writeData(data);
    res.json({ ok: true, user: { id: user.id, email: user.email, role: user.role, orgId: user.orgId || null } });
  } catch (err) {
    next(err);
  }
});

app.get("/api/auth/customer/session", (req, res) => {
  const session = getCustomerSession(req);
  if (!session) {
    return res.status(401).json({ error: "Not authenticated." });
  }
  res.json({ ok: true, user: { id: session.userId, email: session.email, role: session.role, orgId: session.orgId } });
});

app.post("/api/auth/customer/logout", (req, res) => {
  const session = getCustomerSession(req);
  if (session) {
    customerSessionStore.delete(session.id);
  }
  clearCustomerSessionCookie(res);
  res.json({ ok: true });
});

app.get("/api/telemetry", (req, res) => {
  res.json({ vehicle_id: req.query.vehicle_id || null });
});

app.get("/api/tire-risk", (req, res) => {
  res.status(204).end();
});

app.get("/api/alerts", (req, res) => {
  res.json([]);
});

app.get("/api/insights/latest", (req, res) => {
  res.json({ insight: null });
});

app.post("/api/insights/generate", (req, res) => {
  res.json({ insight: null });
});

app.get("/api/ai/status", (req, res) => {
  if (!OPENAI_API_KEY) {
    return res.json({ enabled: false, reason: "OPENAI_API_KEY not configured" });
  }
  if (!aiEnabled()) {
    return res.json({ enabled: false, reason: "AI disabled by configuration" });
  }
  return res.json({ enabled: true });
});

app.get("/api/ai-advisor/status", (req, res) => {
  req.url = "/api/ai/status";
  app.handle(req, res);
});

app.post("/api/ai/advisor/query", (req, res) => {
  if (!aiEnabled()) {
    return res.json({ reply: "Fleet AI Advisor is connecting..." });
  }
  return res.json({ reply: "Fleet AI Advisor is connecting..." });
});

app.post("/api/ai-advisor/query", (req, res) => {
  const prompt = typeof req.body?.prompt === "string" ? req.body.prompt : "";
  if (!prompt) return res.status(400).json({ error: "prompt required" });
  if (!aiEnabled()) {
    return res.json({ reply: "Fleet AI Advisor is connecting..." });
  }
  req.url = "/api/ai/chat";
  req.body = { messages: [{ role: "user", content: prompt }] };
  app.handle(req, res);
});

app.post("/api/ai/chat", async (req, res) => {
  if (!aiEnabled()) {
    return res.json({ reply: "Fleet AI Advisor is connecting..." });
  }
  const incoming = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const safeMessages = incoming
    .filter((m) => m && typeof m.content === "string")
    .map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content.slice(0, 4000)
    }))
    .slice(-16);
  const system = [
    "You are Fleet AI Advisor, a professional enterprise fleet operations assistant.",
    "Never invent fleet telemetry or metrics. If data is missing, say 'insufficient data' and ask a clarifying question.",
    "Do not claim certainty or guarantees. Use calm, professional language.",
    "Keep answers concise and actionable."
  ].join("\n");
  try {
    const payload = {
      model: OPENAI_MODEL,
      temperature: 0.2,
      messages: [{ role: "system", content: system }, ...safeMessages]
    };
    const response = await postJson("https://api.openai.com/v1/chat/completions", payload, {
      Authorization: `Bearer ${OPENAI_API_KEY}`
    });
    if (response.status < 200 || response.status >= 300) {
      return res.status(502).json({ error: "AI upstream error." });
    }
    const data = JSON.parse(response.body || "{}");
    const reply = data?.choices?.[0]?.message?.content?.trim();
    if (!reply) {
      return res.status(502).json({ error: "AI response missing." });
    }
    return res.json({ reply });
  } catch (err) {
    return res.status(500).json({ error: "AI request failed." });
  }
});

async function handleEmployeeLogin(req, res, next) {
  const { email, password } = req.body || {};
  console.log(`[employee-login] attempt for ${email || "unknown"}`);
  if (!email || !password) {
    return res.status(400).json({ error: "Missing email or password." });
  }
  if (!/^[^@]+@[^@]+\.[^@]+$/.test(email)) {
    return res.status(401).json({ error: "Invalid credentials." });
  }
  try {
    const data = await readData();
    const user = (data.users || []).find((u) => u.email === email.toLowerCase());
    if (!user || !user.passwordHash || user.isActive === false) {
      return res.status(401).json({ error: "Invalid credentials." });
    }
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      return res.status(401).json({ error: "Invalid credentials." });
    }
    const sessionId = crypto.randomBytes(24).toString("hex");
    const session = {
      id: sessionId,
      userId: user.id || null,
      email: user.email,
      role: user.role,
      createdAt: new Date().toISOString(),
      expiresAt: Date.now() + SESSION_TTL_MS
    };
    sessionStore.set(sessionId, session);
    setSessionCookie(res, sessionId);
    user.lastLoginAt = nowIso();
    await writeData(data);
    return res.json({ ok: true, email: user.email, role: user.role, id: user.id || null, token: sessionId });
  } catch (err) {
    return next(err);
  }
}

function handleEmployeeLoginRoute(req, res, next) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed." });
  }
  return handleEmployeeLogin(req, res, next);
}

app.all("/api/employee/login", handleEmployeeLoginRoute);
app.all("/api/auth/login", handleEmployeeLoginRoute);
app.all("/api/login", handleEmployeeLoginRoute);
app.all("/api/employee-login", handleEmployeeLoginRoute);

app.get("/api/billing/:orgId", requireSuperAdmin, (req, res) => {
  req.url = `/api/admin/billing/${req.params.orgId}`;
  app.handle(req, res);
});

app.put("/api/billing/:orgId", requireSuperAdmin, (req, res) => {
  req.url = `/api/admin/billing/${req.params.orgId}`;
  app.handle(req, res);
});

app.get("/api/feature-flags/:orgId", requireSuperAdmin, (req, res) => {
  req.url = `/api/admin/features/${req.params.orgId}`;
  app.handle(req, res);
});

app.put("/api/feature-flags/:orgId", requireSuperAdmin, (req, res) => {
  req.url = `/api/admin/features/${req.params.orgId}`;
  app.handle(req, res);
});

app.post("/api/employee/logout", (req, res) => {
  const session = getSession(req);
  if (session) {
    sessionStore.delete(session.id);
  }
  clearSessionCookie(res);
  return res.json({ ok: true });
});
app.post("/api/auth/logout", (req, res) => {
  const session = getSession(req);
  if (session) {
    sessionStore.delete(session.id);
  }
  clearSessionCookie(res);
  return res.json({ ok: true });
});

app.get("/api/employee/session", (req, res) => {
  const session = getSession(req);
  if (!session) {
    return res.status(401).json({ error: "Not authenticated." });
  }
  return res.json({ employee: { id: session.userId || null, email: session.email, role: session.role } });
});
app.get("/api/auth/session", (req, res) => {
  const session = getSession(req);
  if (!session) {
    return res.status(401).json({ error: "Not authenticated." });
  }
  return res.json({ authenticated: true, user: { id: session.userId || null, email: session.email, role: session.role } });
});

app.get("/api/debug/routes", (req, res) => {
  const routes = [];
  const addRoutes = (stack, prefix = "") => {
    stack.forEach((layer) => {
      if (layer.route) {
        const path = `${prefix}${layer.route.path}`;
        const methods = Object.keys(layer.route.methods || {}).map((m) => m.toUpperCase());
        methods.forEach((method) => routes.push({ method, path }));
      } else if (layer.name === "router" && layer.handle?.stack) {
        addRoutes(layer.handle.stack, prefix);
      }
    });
  };
  const stack = app._router?.stack || app.router?.stack || [];
  addRoutes(stack);
  res.json({
    cwd: process.cwd(),
    dirname: __dirname,
    port: PORT,
    routes
  });
});

app.use("/api", (req, res) => {
  res.status(404).json({ error: "API route not found.", path: req.originalUrl });
});

app.use((err, req, res, next) => {
  if (req.path.startsWith("/api")) {
    return res.status(500).json({ error: err.message || "Server error." });
  }
  next(err);
});

app.use((req, res, next) => {
  if (process.env.NODE_ENV === "production") {
    return next();
  }
  res.status(404).send([
    "Route not found.",
    "Known routes:",
    "  /",
    "  /index.html",
    "  /pricing.html",
    "  /about.html",
    "  /ui/fleetai-dashboard.html",
    "  /admin/setup.html",
    "  /admin/setup",
    "  /employee-login.html"
  ].join("\n"));
});

app.listen(PORT, () => {
  const keyLen = SETUP_KEY.length;
  const keyMasked = keyLen >= 6
    ? `${SETUP_KEY.slice(0, 3)}***${SETUP_KEY.slice(-3)}`
    : keyLen > 0
      ? `${SETUP_KEY.slice(0, 1)}***`
      : "";
  console.log(`[env] __dirname=${__dirname}`);
  console.log(`[env] server.js path=${__filename}`);
  console.log(`[env] PORT=${PORT}`);
  console.log(`[env] server root=${SITE_ROOT}`);
  console.log(`[env] root .env path=${rootEnvPath} exists=${rootEnvExists}`);
  console.log(`[env] backend .env path=${backendEnvPath} exists=${backendEnvExists}`);
  if (!rootEnvExists && !backendEnvExists) {
    console.warn("[env] warning: no .env files found");
  }
  if (!SETUP_KEY) {
    console.warn("[env] warning: FLEETAI_SETUP_KEY is missing or empty");
  }
  console.log(`[env] FLEETAI_SETUP_KEY present=${SETUP_KEY ? "true" : "false"} length=${keyLen} masked=${keyMasked}`);
  console.log(`Setup mode: ${SETUP_KEY ? "enabled if no super admin" : "disabled (no key)"}`);
  console.log(`Fleet AI listening on http://localhost:${PORT}`);
  console.log(`Dashboard: http://localhost:${PORT}/ui/fleetai-dashboard.html`);
  console.log(`Home: http://localhost:${PORT}/`);
  console.log(`Pricing: http://localhost:${PORT}/pricing.html`);
  console.log(`Admin setup: http://localhost:${PORT}/admin/setup`);
  console.log(`Admin setup: http://localhost:${PORT}/admin/setup.html`);
  console.log(`Employee login: http://localhost:${PORT}/employee-login.html`);
  console.log(`Run: npm start (PowerShell: node .\\server.js)`);
});
