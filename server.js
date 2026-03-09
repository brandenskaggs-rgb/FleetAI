const path = require("path");
const fs = require("fs");
const fsp = require("fs/promises");
const https = require("https");
const os = require("os");
const cors = require("cors");
const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const childProcess = require("child_process");
const pkg = require("./package.json");
const { detectAdapter } = require("./server/telematics/protocolRegistry");
const { normalizeMetrics } = require("./server/telematics/normalize/normalizeMetrics");
const { appendFrames, appendSnapshot } = require("./server/telematics/storage/telemetryStore");
const { cToF, kphToMph, kmToMiles, milesToKm } = require("./server/telematics/normalize/units");
const ml = require("./server/ml");
const { createDataStore } = require("./server/storage/dataStore");
const { createPairingRouter } = require("./server/routes/pairing");
const { startWatchdog } = require("./tools/watchdog");
const { normalizeAuthData, loadAuthStore, saveAuthStore } = require("./server/authStore");
const { createAuthService } = require("./server/auth/authService");
const { AUTH_ERRORS, formatAuthError } = require("./server/auth/authErrors");
const { applyAuthStoreRepair } = require("./server/auth/repairAuthStore");
const { resolveAuthStorePath } = require("./server/config/authStorePath");

/**
 * Fleet AI server entry and routing map (Step 0 audit)
 * Entry file: server.js (run via `node server.js` or `npm start`)
 * Auth endpoints (API JSON only):
 *   Customer: POST /api/auth/org/login (canonical), aliases /api/auth/customer/login, /api/auth/login, /api/auth/login-customer
 *   Employee: POST /api/employee/login (delegates to handleEmployeeLogin)
 *   First-login/set-password: (to implement) /api/auth/set-password
 *   Auth health: GET /api/auth/health
 * Pairing endpoints:
 *   Mounted via server/routes/pairing at /api/pairing/* (issue/claim/revoke/health as defined in router)
 * Key pages + scripts:
 *   customer-login.html -> js/customer-login.js (posts to /api/auth/org/login)
 *   employee-login.html -> js/employee.js (posts to /api/employee/login)
 *   ui/fleetai-dashboard.html -> ui JS modules
 *   admin/employee-console.html -> admin JS modules / navigation handlers
 * Static mounts are defined later; ensure API mounts occur before any 404 catch-all.
 */

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
function normalizeHost(value) {
  const raw = String(value || "").trim();
  if (!raw) return "0.0.0.0";
  if (raw === "0.0.0.0.0") return "0.0.0.0";
  return raw;
}

const HOST = normalizeHost(process.env.HOST || "0.0.0.0");
const PORT = Number(process.env.PORT) || 3000;
const SITE_ROOT = path.resolve(__dirname);
const UI_DIR = path.resolve(__dirname, "ui");
const ADMIN_DIR = path.resolve(__dirname, "admin");
const DRIVER_DIR = path.resolve(__dirname, "driver_app");
const CSS_DIR = path.resolve(__dirname, "css");
const JS_DIR = path.resolve(__dirname, "js");
const ASSETS_DIR = path.resolve(__dirname, "assets");
const DATA_PATH = resolveAuthStorePath();
const DATA_SCHEMA_VERSION = 2;
const SETUP_KEY = (process.env.FLEETAI_SETUP_KEY || "").trim();
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const AI_ENABLED = (process.env.AI_ENABLED || "").toLowerCase() === "true";
const API_TOKEN = (process.env.FLEETAI_API_TOKEN || "").trim();
const ALERTS_ENABLED = (process.env.ALERTS_ENABLED || "true").toLowerCase() !== "false";
const OPENAI_EXPLANATIONS_ENABLED = (process.env.OPENAI_EXPLANATIONS_ENABLED || "").toLowerCase() === "true";
const ALERT_DEDUPE_WINDOW_HOURS = Number(process.env.ALERT_DEDUPE_WINDOW_HOURS || 12);
const ALERT_RENOTIFY_HOURS = Number(process.env.ALERT_RENOTIFY_HOURS || 8);
const ALERTS_AGGREGATION_INTERVAL_MS = Number(
  process.env.ALERTS_AGGREGATION_INTERVAL_MS || 5 * 60 * 1000
);
const TELEMETRY_RETENTION_LIMIT = Number(process.env.TELEMETRY_RETENTION_LIMIT || 50000);
const COOLANT_OVERHEAT_THRESHOLD = Number(process.env.COOLANT_OVERHEAT_THRESHOLD || 215);
const COOLANT_DELTA_WARN = Number(process.env.COOLANT_DELTA_WARN || 6);
const COOLANT_DELTA_CRIT = Number(process.env.COOLANT_DELTA_CRIT || 12);
const BATTERY_VOLT_WARN = Number(process.env.BATTERY_VOLT_WARN || 12.4);
const BATTERY_VOLT_CRIT = Number(process.env.BATTERY_VOLT_CRIT || 12.0);
const BATTERY_DELTA_WARN = Number(process.env.BATTERY_DELTA_WARN || -0.5);
const BATTERY_DELTA_CRIT = Number(process.env.BATTERY_DELTA_CRIT || -0.8);
const FUEL_EFF_DROP_WARN = Number(process.env.FUEL_EFF_DROP_WARN || 0.12);
const FUEL_EFF_DROP_CRIT = Number(process.env.FUEL_EFF_DROP_CRIT || 0.2);
const IS_PROD = process.env.NODE_ENV === "production";
const SETUP_ALLOWED = !IS_PROD || (process.env.FLEETAI_ALLOW_SETUP || "").toLowerCase() === "true";
const DEV_SETUP = (process.env.DEV_SETUP || "").toLowerCase() === "true";
const DEV_SETUP_MODE = (process.env.DEV_SETUP_MODE || "").toLowerCase() === "true";
const DEV_SETUP_RESET_PASSWORDS = (process.env.DEV_SETUP_RESET_PASSWORDS || "").toLowerCase() === "true";
const DEV_SETUP_PASSWORD = process.env.DEV_SETUP_PASSWORD || "FleetAI!12345";
const AUTH_DEMO_WHITELIST = (process.env.AUTH_DEMO_WHITELIST || "")
  .split(",")
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);
const SESSION_COOKIE = "fleetai_session";
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const CUSTOMER_SESSION_COOKIE = "fleetai_customer_session";
const COOKIE_SAMESITE = (process.env.COOKIE_SAMESITE || (IS_PROD ? "None" : "Lax")).trim();
const COOKIE_SECURE = process.env.COOKIE_SECURE === "true"
  || (IS_PROD && COOKIE_SAMESITE.toLowerCase() === "none");
const BOOTSTRAP_CUSTOMER_EMAIL = (process.env.FLEETAI_BOOTSTRAP_CUSTOMER_EMAIL || "brandenskaggs01@gmail.com").toLowerCase().trim();
const BOOTSTRAP_CUSTOMER_ENABLED = !IS_PROD && (process.env.FLEETAI_BOOTSTRAP_CUSTOMER || "true").toLowerCase() !== "false";
const customerSessionStore = new Map();
const firstLoginTokens = new Map(); // token -> { userId, orgId, role, expiresAt }
let dataLoadStatus = "unknown";
let dataLoadError = null;
let dataLoadNote = null;
let lastDataWriteAt = null;
let lastDataLoadAt = null;
const DEV_LOG = !IS_PROD;
const DEBUG_AUTH = (process.env.DEBUG_AUTH || "").toLowerCase() === "true";

function authLog(...args) {
  if (!DEBUG_AUTH) return;
  console.log(...args);
}

function generateDevPassword() {
  const raw = crypto.randomBytes(18).toString("base64");
  const cleaned = raw.replace(/[^a-zA-Z0-9]/g, "");
  if (cleaned.length >= 14) return cleaned.slice(0, 14);
  return crypto.randomBytes(9).toString("hex");
}

function buildDemoUsers() {
  const specs = [
    { email: "admin@fleetai.local", role: "EMPLOYEE", kind: "employee", envKey: "ADMIN_PASSWORD" },
    { email: "brandenwooley07@icloud.com", role: "SUPER_ADMIN", kind: "employee", envKey: "EMPLOYEE_PASSWORD" },
    { email: "brandenskaggs01@gmail.com", role: "CUSTOMER", kind: "customer", orgId: "ORG_DEFAULT", envKey: "CUSTOMER_PASSWORD" }
  ];
  const generatedPasswords = {};
  const demoUsers = specs.map((spec) => {
    let passwordPlain = process.env[spec.envKey] || "";
    if (!passwordPlain) {
      passwordPlain = generateDevPassword();
      generatedPasswords[spec.email] = passwordPlain;
    }
    return Object.assign({}, spec, { passwordPlain });
  });
  return { demoUsers, generatedPasswords };
}

function logGeneratedPasswords(context, report, generatedPasswords) {
  if (!report || !generatedPasswords) return;
  const changed = new Set([...(report.passwordSet || []), ...(report.passwordReset || [])]);
  Object.keys(generatedPasswords).forEach((email) => {
    if (!changed.has(email)) return;
    console.warn(`[AUTH] ${context} generated password for ${email}: ${generatedPasswords[email]}`);
  });
}

async function seedDevAuthStoreIfNeeded() {
  if (!DEV_SETUP) return { seeded: false };
  const { demoUsers, generatedPasswords } = buildDemoUsers();
  const store = loadAuthStore({ allowEmpty: true, allowMissing: true });
  const result = await applyAuthStoreRepair(store.data, {
    demoUsers,
    resetPasswords: DEV_SETUP_RESET_PASSWORDS,
    defaultOrgId: "ORG_DEFAULT"
  });
  if (result.changed) {
    saveAuthStore(store.filePath, result.data);
    logGeneratedPasswords("dev seed", result.report, generatedPasswords);
  }
  return { seeded: result.changed, report: result.report };
}

function verifyAuthStoreOrExit() {
  try {
    loadAuthStore({ allowEmpty: false, allowMissing: false });
  } catch (err) {
    console.error(err.message || String(err));
    process.exit(1);
  }
}

const authService = createAuthService({
  loadData: readData,
  saveData: writeData,
  issueSession,
  devSetupMode: DEV_SETUP_MODE && !IS_PROD,
  demoWhitelist: AUTH_DEMO_WHITELIST,
  debugLogger: authLog,
  storePath: DATA_PATH
});
const APP_VERSION = (() => {
  const base = (pkg && pkg.version) || "0.0.0";
  try {
    const git = childProcess.execSync("git rev-parse --short HEAD", {
      cwd: __dirname,
      stdio: ["ignore", "pipe", "ignore"]
    }).toString().trim();
    return git ? `${base}+${git}` : base;
  } catch (err) {
    return base;
  }
})();
const DEFAULT_DATA = {
  schemaVersion: DATA_SCHEMA_VERSION,
  users: [],
  orgs: [],
  leads: [],
  invites: [],
  audit: [],
  featureFlags: {},
  billing: {},
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
  fleetAddons: {
    enabledAddons: {},
    trailerCount: 0,
    updatedAt: null
  },
  addonQuotes: [],
  orgBillingSettings: {
    plan: "PILOT_CORE",
    priceMonthly: 59,
    status: "NONE",
    activatedAt: null,
    nextBillAt: null,
    vehicleCount: 0,
    contractTermMonths: 0,
    notes: ""
  },
  paymentMethod: {
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
  },
  telemetryRecords: [],
  telemetrySnapshots: [],
  telemetryAggregates: [],
  telemetryFrames: [],
  telemetrySamples: [],
  telemetry_samples: [],
  fuelEvents: [],
  fuel_events: [],
  events: [],
  alerts: [],
  notifications: [],
  baselines: [],
  modelState: [],
  model_state: [],
  trendSignals: [],
  patternSignatures: [],
  recommendations: [],
  maintenanceLogs: [],
  maintenance_logs: [],
  workOrders: [],
  workOrderLineItems: [],
  vehicles: [],
  drivers: [],
  pairings: []
};

function getLanIPv4s() {
  const nets = os.networkInterfaces();
  const results = [];
  Object.keys(nets || {}).forEach((name) => {
    (nets[name] || []).forEach((net) => {
      if (net && net.family === "IPv4" && !net.internal) {
        results.push(net.address);
      }
    });
  });
  return Array.from(new Set(results.filter(Boolean)));
}

function printNetworkHints(port) {
  const ips = getLanIPv4s();
  if (!ips.length) {
    console.log(`LAN hint: (no IPv4 detected) Try: http://localhost:${port}`);
    return;
  }
  console.log("LAN hint(s):");
  ips.forEach((ip) => console.log(`  http://${ip}:${port}`));
}

function hasSuperAdminCached(data) {
  return (data.users || []).some((u) => u.role === "SUPER_ADMIN");
}
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 5;
const RATE_LOCK_MS = 15 * 60 * 1000;
const rateState = new Map();
const sessionStore = new Map();
// Telemetry streaming state
const telemetryLatest = new Map(); // vehicleId -> snapshot
const telemetrySubscribers = new Set();
let telemetryLastSeen = null; // { vehicleId, driverId, deviceId, ts }
const telemetryState = {
  status: "DISCONNECTED",
  lastChange: nowIso(),
  lastSampleAt: null,
  ageMs: null
};
let watchdogInstance = null;

function setTelemetryState(status, lastSampleAt, ageMs) {
  if (telemetryState.status !== status) {
    telemetryState.status = status;
    telemetryState.lastChange = nowIso();
    console.log("[TEL-STATE]", status, { ageMs });
  }
  telemetryState.lastSampleAt = lastSampleAt;
  telemetryState.ageMs = ageMs;
}

// Throttled heartbeat log (every ~2s when telemetry is active)
let lastHeartbeatLog = 0;
function logTelemetryHeartbeat(status, ageMs, source, metrics) {
  const now = Date.now();
  if (now - lastHeartbeatLog < 2000) return;
  lastHeartbeatLog = now;
  const keys = metrics ? Object.keys(metrics || {}).filter((k) => metrics[k] != null) : [];
  console.log("[TELEMETRY-NOW]", {
    status,
    ageMs,
    source: source || "live",
    keys: keys.slice(0, 30).join(",")
  });
}

app.set("trust proxy", true);
app.use(cors({
  origin: true,
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-FleetAI-Token"]
}));
app.options(/.*/, cors());
// Disable caching for API/active/telemetry so status never lies
app.set("etag", false);
app.use((req, res, next) => {
  const p = req.path || "";
  if (p.startsWith("/api/") || p === "/active" || p.includes("/telemetry")) {
    res.set({
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      Pragma: "no-cache",
      Expires: "0",
      Surrogate_Control: "no-store"
    });
  }
  next();
});
app.use(express.json({
  limit: "256kb",
  verify: (req, res, buf) => {
    req.rawBody = buf ? buf.toString("utf8") : "";
  }
}));

function isPairingPath(pathname) {
  return /^\/(api\/)?pair(ings|ing)(\/|$)/i.test(pathname || "");
}

app.use((req, res, next) => {
  if (!isPairingPath(req.path)) return next();
  const start = Date.now();
  res.on("finish", () => {
    const raw = typeof req.rawBody === "string" ? req.rawBody : "";
    const preview = raw.length > 600 ? `${raw.slice(0, 600)}...` : raw;
    console.log("[PAIR-RAW]", {
      method: req.method,
      path: req.path,
      query: req.query || {},
      contentType: req.headers["content-type"] || "",
      userAgent: req.headers["user-agent"] || "",
      ip: req.ip,
      status: res.statusCode,
      ms: Date.now() - start,
      rawBody: preview
    });
  });
  next();
});

app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
    const raw = typeof req.rawBody === "string" ? req.rawBody : "";
    const preview = raw.length > 600 ? `${raw.slice(0, 600)}...` : raw;
    console.warn("[JSON] parse error", {
      path: req.path,
      message: err.message,
      rawBody: preview
    });
    return res.status(400).json({
      ok: false,
      error: "INVALID_JSON",
      detail: err.message || "Invalid JSON payload"
    });
  }
  return next(err);
});

app.get("/", (req, res) => {
  res.sendFile(path.join(SITE_ROOT, "index.html"));
});

app.get("/privacy.html", (req, res) => {
  res.redirect(302, "/legal/privacy.html");
});

app.get("/login.html", (req, res) => {
  res.redirect(302, "/customer-login.html");
});

app.get("/login", (req, res) => {
  res.redirect(302, "/customer-login.html");
});

app.get("/terms.html", (req, res) => {
  res.redirect(302, "/legal/terms.html");
});

app.get("/admin/setup", (req, res) => {
  res.redirect(302, "/admin/setup.html");
});

app.get("/driver_app", (req, res) => {
  res.redirect(302, "/driver_app/");
});

app.get("/driver_app/", (req, res) => {
  res.sendFile(path.join(UI_DIR, "driver-tablet.html"));
});

app.get("/driver", (req, res) => {
  res.sendFile(path.join(UI_DIR, "driver-tablet.html"));
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

app.get("/employee-portal.html", requireEmployeeSession, (req, res) => {
  res.sendFile(path.join(SITE_ROOT, "employee-portal.html"));
});
app.get("/employee-console.html", requireEmployeeSession, (req, res) => {
  res.sendFile(path.join(SITE_ROOT, "employee-portal.html"));
});

app.get("/ui/fleetai-dashboard.html", (req, res) => {
  const session = getCustomerSession(req);
  if (!session) {
    return res.redirect("/customer-login.html");
  }
  if (session.mustSetPassword || session.resetRequired) {
    return res.redirect("/ui/settings/set-password.html");
  }
  const filePath = path.join(UI_DIR, "fleetai-dashboard.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) {
      return res.sendFile(filePath);
    }
    const stamp = new Date().toISOString();
    const out = html.replace("<!-- BUILD_MARKER -->", stamp);
    res.type("html").send(out);
  });
});

app.get("/ui/settings/set-password.html", (req, res) => {
  const session = getCustomerSession(req);
  if (!session && !req.query?.token) {
    return res.redirect("/customer-login.html");
  }
  return res.sendFile(path.join(UI_DIR, "settings", "set-password.html"));
});

app.get("/set-password.html", (req, res) => {
  return res.sendFile(path.join(UI_DIR, "settings", "set-password.html"));
});

// Health check (must be before static middleware)
async function healthPayload() {
  const data = await readData();
  const users = data.users || [];
  const employeeUsers = users.filter((u) => String(u.role || "").toUpperCase().includes("SUPER")
    || String(u.role || "").toUpperCase().includes("EMP")).length;
  const customerUsers = users.filter((u) => {
    const role = String(u.role || "").toUpperCase();
    return role.startsWith("CUSTOMER") || role === "ORG_ADMIN" || role === "CUSTOMER_ADMIN";
  }).length;
  const payload = {
    ok: true,
    service: "fleet-ai",
    timestamp: new Date().toISOString(),
    version: APP_VERSION,
    data: {
      status: dataLoadStatus,
      lastError: dataLoadError,
      note: dataLoadNote,
      lastWriteAt: lastDataWriteAt
    },
    auth: {
      users: users.length,
      employeeUsers,
      customerUsers
    }
  };
  const email = (typeof req === "object" && req.query && req.query.email) ? String(req.query.email || "").toLowerCase().trim() : null;
  if (email) {
    payload.auth.emailExists = users.some((u) => String(u.email || "").toLowerCase() === email);
  }
  return payload;
}

app.get("/health", async (req, res) => {
  res.status(200).json(await healthPayload());
});

app.get("/api/health", async (req, res) => {
  res.status(200).json(await healthPayload());
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
      lastLoadedAt: lastDataLoadAt,
      dataLoadStatus,
      dataLoadError,
      bootstrapAllowed,
      emailExists: req.query?.email ? users.some((u) => String(u.email || "").toLowerCase() === String(req.query.email || "").toLowerCase()) : undefined
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || "auth_health_error" });
  }
});

// First-login password setter (token-based)
app.post("/api/auth/set-password", async (req, res) => {
  const token = (req.body?.token || "").trim();
  const newPassword = (req.body?.newPassword || "").trim();
  if (!token || !newPassword) {
    return res.status(400).json(formatAuthError(AUTH_ERRORS.INVALID_CREDENTIALS, {
      message: "token and newPassword are required"
    }));
  }
  try {
    const result = await authService.setPasswordWithToken(token, newPassword);
    if (!result.ok) {
      return res.status(result.error.status).json(formatAuthError(result.error));
    }
    const user = result.user;
    const scope = authService.isCustomerRole(user) ? "customer" : "employee";
    const session = issueSession(scope, user);
    if (scope === "customer") {
      setCustomerSessionCookie(res, session.id);
    } else {
      setSessionCookie(res, session.id);
    }
    firstLoginTokens.delete(token);
    return res.status(200).json({
      ok: true,
      code: "OK",
      message: "Password updated",
      token: session.id,
      session: {
        token: session.id,
        expiresAt: session.expiresAt,
        user: { id: user.id, email: user.email, role: user.role, orgId: user.orgId || null }
      },
      user: { id: user.id, email: user.email, role: user.role, orgId: user.orgId || null }
    });
  } catch (err) {
    return res.status(500).json(formatAuthError(AUTH_ERRORS.SERVER_MISCONFIG, {
      message: err.message || "Failed to set password"
    }));
  }
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
    let data = await readData();
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
    let data = await readData();
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

app.get("/version", (req, res) => {
  res.status(200).json({
    ok: true,
    version: APP_VERSION,
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

app.use("/", express.static(SITE_ROOT));
app.use("/ui", express.static(UI_DIR));
app.use("/admin", express.static(ADMIN_DIR));
app.use("/driver_app", express.static(DRIVER_DIR));
app.use("/css", express.static(CSS_DIR));
app.use("/js", express.static(JS_DIR));
app.use("/assets", express.static(ASSETS_DIR));

app.get("/api/health", (req, res) => {
  req.url = "/health";
  app.handle(req, res);
});

async function handleListVehicles(req, res, next) {
  try {
    const data = await readData();
    const orgId = sanitizeString(req.query.orgId || "", 80);
    const vehicles = orgId
      ? (data.vehicles || []).filter((v) => (v.orgId || "") === orgId)
      : (data.vehicles || []);
    res.json(vehicles);
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
    const data = await readData();
    const exists = data.vehicles.some((v) => v.vehicleId === vehicleId);
    if (exists) {
      return res.status(409).json({ error: "Vehicle already exists" });
    }
    const vehicle = {
      vehicleId,
      unitName,
      vin,
      type,
      orgId: sanitizeString(req.body?.orgId || "", 80),
      year: parseNumberField(req.body?.year, null),
      make: sanitizeString(req.body?.make || "", 80),
      model: sanitizeString(req.body?.model || "", 80),
      createdAt: nowIso()
    };
    data.vehicles.push(vehicle);
    await writeData(data);
    res.json(vehicle);
  } catch (err) {
    next(err);
  }
}

app.get("/vehicles", handleListVehicles);
app.get("/api/vehicles", handleListVehicles);

app.post("/vehicles/create", handleCreateVehicle);
app.post("/api/vehicles/create", handleCreateVehicle);

app.post("/api/vehicles", async (req, res, next) => {
  const { vehicleId, unitName, vin, type } = req.body || {};
  if (!vehicleId || !unitName || !vin || !type) {
    return res.status(400).json({ error: "vehicleId, unitName, vin, type required" });
  }
  try {
    const data = await readData();
    if ((data.vehicles || []).some((v) => v.vehicleId === vehicleId)) {
      return res.status(409).json({ error: "Vehicle already exists" });
    }
    const vehicle = {
      id: makeId("VEH"),
      orgId: sanitizeString(req.body?.orgId || "", 80),
      vehicleId,
      vin,
      unitName,
      type,
      year: parseNumberField(req.body?.year, null),
      make: sanitizeString(req.body?.make || "", 80),
      model: sanitizeString(req.body?.model || "", 80),
      createdAt: nowIso()
    };
    data.vehicles.push(vehicle);
    await writeData(data);
    res.json({ ok: true, data: vehicle });
  } catch (err) {
    next(err);
  }
});

app.get("/api/vehicles/:id", async (req, res, next) => {
  try {
    const data = await readData();
    const vehicle = (data.vehicles || []).find(
      (v) => v.vehicleId === req.params.id || v.id === req.params.id
    );
    if (!vehicle) return res.status(404).json({ error: "Vehicle not found" });
    res.json({ ok: true, data: vehicle });
  } catch (err) {
    next(err);
  }
});

app.patch("/api/vehicles/:id", requireEmployeeOrCustomerApi, async (req, res, next) => {
  try {
    const data = await readData();
    const vehicle = (data.vehicles || []).find(
      (v) => v.vehicleId === req.params.id || v.id === req.params.id
    );
    if (!vehicle) return res.status(404).json({ error: "Vehicle not found" });
    if (req.customer?.orgId && vehicle.orgId && req.customer.orgId !== vehicle.orgId) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const payload = req.body || {};
    if (payload.unitName !== undefined) vehicle.unitName = sanitizeString(payload.unitName || "", 120);
    if (payload.type !== undefined) vehicle.type = sanitizeString(payload.type || "", 80);
    if (payload.vin !== undefined) vehicle.vin = sanitizeString(payload.vin || "", 80);
    if (payload.make !== undefined) vehicle.make = sanitizeString(payload.make || "", 80);
    if (payload.model !== undefined) vehicle.model = sanitizeString(payload.model || "", 80);
    if (payload.year !== undefined) vehicle.year = parseNumberField(payload.year, null);
    vehicle.updatedAt = nowIso();
    addAudit(data, "VEHICLE_UPDATED", vehicle.vehicleId || vehicle.id || "vehicle");
    await writeData(data);
    res.json({ ok: true, data: vehicle });
  } catch (err) {
    next(err);
  }
});

app.get("/api/vehicles/:id/baselines", async (req, res, next) => {
  try {
    const data = await readData();
    const list = (data.baselines || []).filter(
      (b) => b.vehicleId === req.params.id
    );
    res.json({ ok: true, data: list });
  } catch (err) {
    next(err);
  }
});

async function handleListDrivers(req, res, next) {
  try {
    const data = await readData();
    const orgId = sanitizeString(req.query.orgId || "", 80);
    const drivers = orgId
      ? (data.drivers || []).filter((d) => (d.orgId || "") === orgId)
      : (data.drivers || []);
    res.json(drivers);
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
    const data = await readData();
    const driverId = `DRIVER_${generateDigits(5)}`;
    const driver = {
      driverId,
      firstName,
      lastName,
      phone,
      orgId: sanitizeString(req.body?.orgId || "", 80),
      createdAt: nowIso()
    };
    data.drivers.push(driver);
    await writeData(data);
    res.json({ driverId });
  } catch (err) {
    next(err);
  }
}

app.get("/drivers", handleListDrivers);
app.get("/api/drivers", handleListDrivers);

app.post("/drivers/create", handleCreateDriver);
app.post("/api/drivers/create", handleCreateDriver);

app.post("/api/drivers", async (req, res, next) => {
  const { driverId, firstName, lastName, phone } = req.body || {};
  if (!firstName || !lastName || !phone) {
    return res.status(400).json({ error: "firstName, lastName, phone required" });
  }
  try {
    const data = await readData();
    const id = driverId || `DRIVER_${generateDigits(5)}`;
    if ((data.drivers || []).some((d) => d.driverId === id)) {
      return res.status(409).json({ error: "Driver already exists" });
    }
    const driver = {
      id: makeId("DRV"),
      driverId: id,
      orgId: sanitizeString(req.body?.orgId || "", 80),
      firstName,
      lastName,
      phone,
      createdAt: nowIso()
    };
    data.drivers.push(driver);
    await writeData(data);
    res.json({ ok: true, data: driver });
  } catch (err) {
    next(err);
  }
});

app.get("/api/drivers/:id", async (req, res, next) => {
  try {
    const data = await readData();
    const driver = (data.drivers || []).find(
      (d) => d.driverId === req.params.id || d.id === req.params.id
    );
    if (!driver) return res.status(404).json({ error: "Driver not found" });
    res.json({ ok: true, data: driver });
  } catch (err) {
    next(err);
  }
});

function findPairConflict(data, vehicleId, driverId) {
  const pairings = Array.isArray(data.pairings) ? data.pairings : [];
  const now = Date.now();
  pairings.forEach((p) => {
    const expired = (p.expiresAt && new Date(p.expiresAt).getTime() <= now)
      || (p.driverPinExpiresAt && new Date(p.driverPinExpiresAt).getTime() <= now);
    if (expired && p.status !== "expired") p.status = "expired";
  });
  const activeVehicle = pairings.find((p) => p.vehicleId === vehicleId && p.status === "active");
  if (activeVehicle) return { reason: "VEHICLE_ALREADY_ASSIGNED", pairing: activeVehicle };
  const activeDriver = pairings.find((p) => p.driverId === driverId && p.status === "active");
  if (activeDriver) return { reason: "DRIVER_ALREADY_ASSIGNED", pairing: activeDriver };
  const pendingVehicle = pairings.find((p) => p.vehicleId === vehicleId && p.status === "pending" && !isExpired(p.expiresAt));
  if (pendingVehicle) return { reason: "UNEXPIRED_CODE", pairing: pendingVehicle };
  const pendingDriver = pairings.find((p) => p.driverId === driverId && p.status === "pending" && !isExpired(p.expiresAt));
  if (pendingDriver) return { reason: "UNEXPIRED_CODE", pairing: pendingDriver };
  return null;
}

const pairingDebug = {
  generated: [],
  claims: []
};

function pushPairingDebug(list, entry) {
  list.unshift(entry);
  if (list.length > 50) list.length = 50;
}

function normalizePairingCode(value) {
  if (!value) return "";
  return String(value).trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function normalizePairingCodeDigits(value) {
  if (!value) return { digits: "", hadNonDigit: false };
  const raw = String(value).trim();
  const digits = raw.replace(/[^0-9]/g, "");
  const hadNonDigit = /[^0-9]/.test(raw);
  return { digits, hadNonDigit };
}

function normalizePairingClaimInput(req) {
  const body = req.body || {};
  const query = req.query || {};
  const pairingCodeRaw = body.pairingCode
    || body.code
    || body.pair_code
    || body.pairing_code
    || body.pairCode
    || body.companyCode
    || body.company_code
    || query.pairingCode
    || query.code
    || query.companyCode
    || query.company_code
    || "";
  const deviceIdRaw = body.deviceId
    || body.device_id
    || body.id
    || body.uuid
    || query.deviceId
    || query.device_id
    || query.id
    || query.uuid
    || req.headers["x-device-id"]
    || "";
  const deviceNameRaw = body.deviceName || body.device_name || body.deviceLabel || body.device_label || query.deviceName || query.device_name || "";
  const driverPinRaw = body.driverPin || body.pin || body.driver_pin || query.driverPin || query.pin || "";
  return {
    pairingCode: normalizePairingCode(pairingCodeRaw),
    deviceId: sanitizeString(deviceIdRaw || "", 120),
    deviceName: sanitizeString(deviceNameRaw || "", 120),
    driverPin: sanitizeString(driverPinRaw || "", 20)
  };
}

function formatPairConflict(conflict) {
  const p = conflict.pairing || {};
  return {
    pairId: p.id || null,
    code: p.pairingCode || p.code || null,
    expiresAt: p.expiresAt || null,
    vehicleId: p.vehicleId || null,
    driverId: p.driverId || null,
    deviceId: p.deviceId || null,
    status: p.status || null,
    driverPin: p.driverPin || null,
    driverPinExpiresAt: p.driverPinExpiresAt || null
  };
}

function createPairingRecord({ vehicleId, driverId, orgId, vehicleName, driverName }) {
  const pairingCode = generateDigits(6);
  const driverPin = generateDriverPin();
  const expiresAt = new Date(Date.now() + 10 * 60000).toISOString();
  return {
    id: makeId("PAIR"),
    orgId: sanitizeString(orgId || "", 80),
    pairingCode,
    pairCode: pairingCode,
    driverPin,
    vehicleId,
    driverId,
    vehicleName: sanitizeString(vehicleName || "", 120),
    driverName: sanitizeString(driverName || "", 120),
    status: "pending",
    expiresAt,
    driverPinExpiresAt: expiresAt,
    createdAt: nowIso()
  };
}

async function handlePairCodeGenerate(req, res, next) {
  const { vehicleId, driverId } = req.body || {};
  const force = Boolean(req.body?.force);
  const requestId = process.env.DEBUG_PAIRING === "1" ? crypto.randomBytes(6).toString("hex") : null;
  const logPrefix = requestId ? `[PAIR ${requestId}]` : "[PAIR]";
  const log = (...args) => console.log(logPrefix, ...args);
  if (!vehicleId || !driverId) {
    return res.status(400).json({ ok: false, error: "missing_vehicle_or_driver" });
  }
  try {
    const data = await readData();
    const vehicle = data.vehicles.find((v) => v.vehicleId === vehicleId);
    const driver = data.drivers.find((d) => d.driverId === driverId);
    if (!vehicle || !driver) {
      return res.status(404).json({ ok: false, error: "vehicle_or_driver_not_found" });
    }
    const now = nowIso();
    const pairings = data.pairings || [];
    const samePairings = pairings.filter(
      (p) => (p.vehicleId === vehicleId && p.driverId === driverId) && (p.status === "pending" || p.status === "active")
    );
    let replacedAssignmentId = null;
    if (samePairings.length) {
      samePairings.forEach((p) => {
        p.status = "expired";
        p.replacedAt = now;
        p.expiresAt = now;
        p.driverPinExpiresAt = now;
        replacedAssignmentId = replacedAssignmentId || p.id;
      });
    }
    let pairingCode;
    let attempts = 0;
    do {
      pairingCode = generateDigits(6);
      attempts += 1;
    } while (
      pairings.some((p) => {
        const digitsStored = normalizePairingCodeDigits(p.pairingCode || p.code).digits;
        const pending = p.status === "pending" || p.status === "active";
        return pending && digitsStored === pairingCode && !isExpired(p.expiresAt);
      }) && attempts < 5
    );
    const pairing = createPairingRecord({
      vehicleId,
      driverId,
      orgId: req.body?.orgId,
      vehicleName: vehicle.unitName || vehicle.name || vehicle.vehicleId,
      driverName: `${driver.firstName || ""} ${driver.lastName || ""}`.trim()
    });
    pairing.pairingCode = pairingCode;
    pairing.pairCode = pairingCode;
    data.pairings.push(pairing);
    await writeData(data);
    const payload = {
      ok: true,
      pairId: pairing.id,
      code: pairing.pairingCode,
      pairingCode: pairing.pairingCode,
      expiresAt: pairing.expiresAt,
      expiresInSeconds: Math.round((new Date(pairing.expiresAt).getTime() - Date.now()) / 1000),
      driverPin: pairing.driverPin,
      driverPinExpiresAt: pairing.driverPinExpiresAt,
      vehicleId,
      driverId,
      status: "PENDING",
      replacedAssignmentId
    };
    if (requestId) payload.debug = { requestId };
    log("generated", {
      vehicleId,
      driverId,
      pairId: pairing.id,
      pairingCode: pairing.pairingCode,
      expiresAt: pairing.expiresAt,
      replacedAssignmentId: payload.replacedAssignmentId || null
    });
    pushPairingDebug(pairingDebug.generated, {
      time: nowIso(),
      vehicleId,
      driverId,
      pairId: pairing.id,
      pairingCode: pairing.pairingCode,
      expiresAt: pairing.expiresAt,
      status: pairing.status
    });
    return res.json(payload);
  } catch (err) {
    next(err);
  }
}

async function handlePairCodeExpire(req, res, next) {
  const pairId = req.params.pairId;
  if (!pairId) return res.status(400).json({ ok: false, error: "missing_pair_id" });
  try {
    const data = await readData();
    const pairing = (data.pairings || []).find((p) => p.id === pairId);
    if (!pairing) return res.status(404).json({ ok: false, error: "pair_not_found" });
    pairing.status = "expired";
    pairing.expiresAt = nowIso();
    pairing.driverPinExpiresAt = nowIso();
    await writeData(data);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

async function handlePairCodeReplace(req, res, next) {
  const { vehicleId, driverId } = req.body || {};
  if (!vehicleId || !driverId) {
    return res.status(400).json({ ok: false, error: "missing_vehicle_or_driver" });
  }
  try {
    const data = await readData();
    const vehicle = data.vehicles.find((v) => v.vehicleId === vehicleId);
    const driver = data.drivers.find((d) => d.driverId === driverId);
    (data.pairings || []).forEach((p) => {
      if ((p.vehicleId === vehicleId || p.driverId === driverId) && p.status !== "expired") {
        p.status = "replaced";
        p.expiresAt = nowIso();
        p.driverPinExpiresAt = nowIso();
      }
    });
    const pairing = createPairingRecord({
      vehicleId,
      driverId,
      orgId: req.body?.orgId,
      vehicleName: vehicle?.unitName || vehicle?.name || vehicleId,
      driverName: `${driver?.firstName || ""} ${driver?.lastName || ""}`.trim()
    });
    data.pairings.push(pairing);
    await writeData(data);
    res.json({
      ok: true,
      pairId: pairing.id,
      code: pairing.pairingCode,
      pairingCode: pairing.pairingCode,
      expiresAt: pairing.expiresAt,
      expiresInSeconds: Math.round((new Date(pairing.expiresAt).getTime() - Date.now()) / 1000),
      driverPin: pairing.driverPin,
      driverPinExpiresAt: pairing.driverPinExpiresAt,
      vehicleId,
      driverId,
      status: "PENDING"
    });
    pushPairingDebug(pairingDebug.generated, {
      time: nowIso(),
      vehicleId,
      driverId,
      pairId: pairing.id,
      pairingCode: pairing.pairingCode,
      expiresAt: pairing.expiresAt,
      status: pairing.status,
      replaced: true
    });
  } catch (err) {
    next(err);
  }
}

async function handlePairingRevoke(req, res, next) {
  const { pairId, vehicleId, driverId } = req.body || {};
  if (!pairId && !vehicleId && !driverId) {
    return res.status(400).json({ ok: false, error: "missing_pair_or_vehicle_or_driver" });
  }
  try {
    const data = await readData();
    let expiredCount = 0;
    (data.pairings || []).forEach((p) => {
      const match = (pairId && p.id === pairId)
        || (!pairId && vehicleId && p.vehicleId === vehicleId)
        || (!pairId && driverId && p.driverId === driverId);
      if (match && p.status !== "expired") {
        p.status = "expired";
        p.expiresAt = nowIso();
        p.driverPinExpiresAt = nowIso();
        expiredCount += 1;
      }
    });
    await writeData(data);
    res.json({ ok: true, expiredCount });
  } catch (err) {
    next(err);
  }
}

async function handlePairingGenerate(req, res, next) {
  return handlePairCodeGenerate(req, res, next);
}

async function handlePairingClaim(req, res, next) {
  const input = normalizePairingClaimInput(req);
  const debugMode = req.headers["x-debug"] === "1";
  const normalizedDigits = normalizePairingCodeDigits(input.pairingCode);
  if (normalizedDigits.hadNonDigit) {
    return res.status(400).json({
      ok: false,
      error: "INVALID_CODE_FORMAT",
      message: "Pairing code must be numeric.",
      ...(debugMode ? { debug: { normalized: input } } : {})
    });
  }
  input.pairingCode = normalizedDigits.digits;
  if (!input.pairingCode) {
    return res.status(400).json({
      ok: false,
      error: "MISSING_CODE",
      message: "pairingCode required",
      ...(debugMode ? { debug: { normalized: input } } : {})
    });
  }
  if (input.pairingCode.length < 4 || input.pairingCode.length > 10) {
    return res.status(400).json({
      ok: false,
      error: "INVALID_CODE_FORMAT",
      message: "pairingCode must be 4-10 characters",
      ...(debugMode ? { debug: { normalized: input } } : {})
    });
  }
  if (!input.deviceId) {
    return res.status(400).json({ ok: false, error: "MISSING_DEVICE", message: "deviceId required" });
  }
  try {
    const data = await readData();
    const pairing = (data.pairings || []).find((p) => {
      const digitsStored = normalizePairingCodeDigits(p.pairingCode || p.code).digits;
      return digitsStored === input.pairingCode;
    });
    if (!pairing) {
      console.log("[PAIR-CLAIM] not_found", { pairingCode: input.pairingCode, deviceId: input.deviceId });
      pushPairingDebug(pairingDebug.claims, {
        time: nowIso(),
        pairingCode: input.pairingCode,
        deviceId: input.deviceId,
        status: "not_found"
      });
      return res.status(404).json({
        ok: false,
        error: "PAIRING_CODE_INVALID_OR_EXPIRED",
        message: "Invalid or expired pairing code",
        legacyError: "Invalid code",
        ...(debugMode ? { debug: { normalized: input } } : {})
      });
    }
    const normalizedStored = normalizePairingCodeDigits(pairing.pairingCode || pairing.code).digits;
    if (normalizedStored && normalizedStored !== pairing.pairingCode) {
      pairing.pairingCode = normalizedStored;
    }
    if (pairing.status === "active") {
      if (pairing.deviceId && pairing.deviceId !== input.deviceId) {
        console.log("[PAIR-CLAIM] already_claimed", {
          pairingCode: pairing.pairingCode,
          deviceId: input.deviceId,
          existingDeviceId: pairing.deviceId
        });
        pushPairingDebug(pairingDebug.claims, {
          time: nowIso(),
          pairingCode: pairing.pairingCode,
          deviceId: input.deviceId,
          status: "already_claimed",
          existingDeviceId: pairing.deviceId
        });
        return res.status(409).json({
          ok: false,
          error: "ALREADY_CLAIMED",
          message: "Pairing code already claimed by another device",
          conflict: {
            pairingCode: pairing.pairingCode,
            assignmentId: pairing.id,
            deviceId: pairing.deviceId,
            status: pairing.status
          },
          claimedByDeviceId: pairing.deviceId,
          ...(debugMode ? { debug: { normalized: input } } : {})
        });
      }
      return res.json({
        ok: true,
        pairingCode: pairing.pairingCode,
        driverPin: pairing.driverPin,
        pinExpiresAt: pairing.driverPinExpiresAt,
        assignmentId: pairing.id,
        deviceId: pairing.deviceId || input.deviceId,
        deviceLabel: pairing.deviceLabel || input.deviceName || "",
        serverTime: nowIso(),
        vehicle: { vehicleId: pairing.vehicleId, name: pairing.vehicleName || "" },
        driver: { driverId: pairing.driverId, name: pairing.driverName || "" },
        vehicleId: pairing.vehicleId,
        driverId: pairing.driverId,
        status: pairing.status,
        ...(debugMode ? { debug: { normalized: input, route: req.path } } : {})
      });
    }
    if (pairing.status && pairing.status !== "pending") {
      console.log("[PAIR-CLAIM] status_invalid", {
        pairingCode: pairing.pairingCode,
        deviceId: input.deviceId,
        status: pairing.status
      });
      pushPairingDebug(pairingDebug.claims, {
        time: nowIso(),
        pairingCode: pairing.pairingCode,
        deviceId: input.deviceId,
        status: pairing.status
      });
      return res.status(409).json({
        ok: false,
        error: "PAIRING_CODE_ALREADY_CLAIMED",
        message: "Pairing code already used",
        legacyError: "Code already used",
        ...(debugMode ? { debug: { normalized: input } } : {})
      });
    }
    if (isExpired(pairing.expiresAt) || isExpired(pairing.driverPinExpiresAt)) {
      console.log("[PAIR-CLAIM] expired", {
        pairingCode: pairing.pairingCode,
        deviceId: input.deviceId
      });
      pairing.status = "expired";
      await writeData(data);
      pushPairingDebug(pairingDebug.claims, {
        time: nowIso(),
        pairingCode: pairing.pairingCode,
        deviceId: input.deviceId,
        status: "expired"
      });
      return res.status(410).json({
        ok: false,
        error: "PAIRING_CODE_INVALID_OR_EXPIRED",
        message: "Pairing code expired",
        legacyError: "Expired code",
        ...(debugMode ? { debug: { normalized: input } } : {})
      });
    }
    if (input.driverPin && pairing.driverPin && input.driverPin !== pairing.driverPin) {
      console.log("[PAIR] claim pin mismatch (ignored for compatibility)", {
        pairingId: pairing.id,
        pairingCode: pairing.pairingCode,
        deviceId: input.deviceId
      });
    }
    pairing.status = "active";
    pairing.deviceId = input.deviceId;
    const fallbackLabel = `Tablet-${input.deviceId.slice(-4) || "UNK"}`;
    pairing.deviceLabel = input.deviceName || pairing.deviceLabel || fallbackLabel;
    pairing.claimedAt = nowIso();
    pairing.lastSeen = nowIso();
    await writeData(data);
    console.log("[PAIR-CLAIM] success", {
      pairingCode: pairing.pairingCode,
      deviceId: pairing.deviceId,
      assignmentId: pairing.id
    });
    pushPairingDebug(pairingDebug.claims, {
      time: nowIso(),
      pairingCode: pairing.pairingCode,
      deviceId: pairing.deviceId,
      status: pairing.status,
      assignmentId: pairing.id
    });
    res.json({
      ok: true,
      pairingCode: pairing.pairingCode,
      driverPin: pairing.driverPin,
      pinExpiresAt: pairing.driverPinExpiresAt,
      assignmentId: pairing.id,
      deviceId: pairing.deviceId,
      deviceLabel: pairing.deviceLabel,
      serverTime: nowIso(),
      vehicle: { vehicleId: pairing.vehicleId, name: pairing.vehicleName || "" },
      driver: { driverId: pairing.driverId, name: pairing.driverName || "" },
      vehicleId: pairing.vehicleId,
      driverId: pairing.driverId,
      status: pairing.status,
      ...(debugMode ? { debug: { normalized: input, route: req.path } } : {})
    });
  } catch (err) {
    next(err);
  }
}

async function handlePairingsActive(req, res, next) {
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
}

function pairingRequestLogger(req, res, next) {
  const keys = Object.keys(req.body || {});
  const safeQuery = req.query || {};
  const start = Date.now();
  res.on("finish", () => {
    console.log("[PAIR-REQ]", {
      method: req.method,
      path: req.path,
      query: safeQuery,
      bodyKeys: keys,
      status: res.statusCode,
      ms: Date.now() - start
    });
  });
  next();
}

app.use(["/api/pairings", "/pairings", "/api/pairing"], pairingRequestLogger);

app.get("/api/pairings/health", (req, res) => {
  readData()
    .then((data) => {
      const active = (data.pairings || []).filter((p) => p.status === "active" && !isExpired(p.expiresAt));
      const pending = (data.pairings || []).filter((p) => p.status === "pending" && !isExpired(p.expiresAt));
      res.json({
        ok: true,
        time: nowIso(),
        version: "pairings-v1",
        active: active.length,
        pending: pending.length,
        lastWriteAt: lastDataWriteAt
      });
    })
    .catch((err) => {
      res.status(500).json({ ok: false, error: "health_error", message: err?.message || String(err) });
    });
});

app.get("/api/pairing/health", (req, res) => {
  readData()
    .then((data) => {
      const active = (data.pairings || []).filter((p) => p.status === "active" && !isExpired(p.expiresAt));
      const pending = (data.pairings || []).filter((p) => p.status === "pending" && !isExpired(p.expiresAt));
      res.json({
        ok: true,
        time: nowIso(),
        version: "pairing-v1",
        active: active.length,
        pending: pending.length,
        lastWriteAt: lastDataWriteAt
      });
    })
    .catch((err) => {
      res.status(500).json({ ok: false, error: "health_error", message: err?.message || String(err) });
    });
});

app.get("/api/pairings/debug", requireEmployeeOrCustomerApi, async (req, res) => {
  try {
    const data = await readData();
    const active = (data.pairings || []).filter((p) => p.status === "active" && !isExpired(p.expiresAt));
    res.json({
      ok: true,
      generated: pairingDebug.generated,
      claims: pairingDebug.claims,
      active
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: "debug_error", message: err?.message || String(err) });
  }
});

app.post("/pairings/generate", handlePairingGenerate);
app.post("/api/pairings/generate", handlePairingGenerate);
app.post("/api/pair-code", requireEmployeeOrCustomerApi, handlePairCodeGenerate);
app.post("/api/pair-code/generate", requireEmployeeOrCustomerApi, handlePairCodeGenerate);
app.post("/api/pair-code/replace", requireEmployeeOrCustomerApi, handlePairCodeReplace);
app.post("/api/pair-code/:pairId/expire", requireEmployeeOrCustomerApi, handlePairCodeExpire);
app.post("/api/pair-code/expire-and-generate", requireEmployeeOrCustomerApi, handlePairCodeReplace);

app.post("/pairings/claim", handlePairingClaim);
app.post("/api/pairings/claim", handlePairingClaim);
app.post("/api/pairing/claim", handlePairingClaim);
app.post("/pairing/claim", handlePairingClaim);
app.post("/api/pairings/claim-device", handlePairingClaim);
app.post("/api/pairing/claim-device", handlePairingClaim);
app.post("/pairing/claim-device", handlePairingClaim);

app.get("/pairings/active", handlePairingsActive);
app.get("/api/pairings/active", handlePairingsActive);

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

app.post("/api/auth/driverLogin", (req, res, next) => {
  req.url = "/auth/driverLogin";
  app.handle(req, res, next);
});

app.post("/api/pairing/create", async (req, res, next) => {
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
    const pairing = createPairingRecord({
      vehicleId,
      driverId,
      orgId: req.body?.orgId,
      vehicleName: vehicle.unitName || vehicle.name || vehicle.vehicleId,
      driverName: `${driver.firstName || ""} ${driver.lastName || ""}`.trim()
    });
    data.pairings.push(pairing);
    await writeData(data);
    res.json({
      ok: true,
      pairingId: pairing.id,
      pairingCode: pairing.pairingCode,
      driverPin: pairing.driverPin,
      expiresAt: pairing.expiresAt
    });
  } catch (err) {
    next(err);
  }
});

app.post("/api/pairing/activate", async (req, res, next) => {
  const pairingId = req.body?.pairingId || "";
  const pairingCode = normalizePairingCode(req.body?.pairingCode || req.body?.code || "");
  const deviceId = sanitizeString(req.body?.deviceId || req.body?.device_id || "", 120);
  const deviceLabel = sanitizeString(req.body?.deviceLabel || req.body?.deviceName || req.body?.device_name || "", 120);
  if ((!pairingId && !pairingCode) || !deviceId) {
    return res.status(400).json({ ok: false, error: "pairingId or pairingCode and deviceId required" });
  }
  try {
    const data = await readData();
    const pairing = (data.pairings || []).find(
      (p) => (pairingId && p.id === pairingId) || (pairingCode && normalizePairingCode(p.pairingCode || p.code) === pairingCode)
    );
    if (!pairing) {
      return res.status(404).json({ ok: false, error: "Invalid pairing" });
    }
    if (isExpired(pairing.expiresAt)) {
      pairing.status = "expired";
      await writeData(data);
      return res.status(410).json({ ok: false, error: "Expired code" });
    }
    pairing.status = "active";
    pairing.deviceId = deviceId;
    pairing.deviceLabel = deviceLabel || pairing.deviceLabel || "";
    pairing.claimedAt = nowIso();
    pairing.lastSeen = nowIso();
    await writeData(data);
    res.json({ ok: true, pairing });
  } catch (err) {
    next(err);
  }
});

app.get("/api/pairing/status", async (req, res, next) => {
  try {
    const data = await readData();
    const vehicleId = sanitizeString(req.query.vehicleId || "", 80);
    const pairing = (data.pairings || []).find(
      (p) => p.vehicleId === vehicleId && p.status === "active"
    );
    res.json({ ok: true, pairing: pairing || null });
  } catch (err) {
    next(err);
  }
});

app.post("/api/driver/register-device", (req, res) => {
  const deviceId = sanitizeString(req.body?.deviceId || "", 120) || makeId("DEVICE");
  res.json({ ok: true, deviceId });
});

app.post("/api/driver/trips/start", (req, res) => {
  res.json({ ok: true, trip_id: makeId("TRIP") });
});

app.post("/api/driver/trips/end", (req, res) => {
  res.json({ ok: true });
});

app.post("/api/driver/telemetry", (req, res) => {
  (async () => {
    const payload = req.body || {};
    const vehicleId = sanitizeString(payload.vehicle_id || "", 80);
    const samples = Array.isArray(payload.samples) ? payload.samples : [];
    if (!vehicleId || samples.length === 0) {
      return res.status(400).json({ error: "vehicle_id and samples required" });
    }
    const data = await readData();
    const orgId = resolveOrgIdForVehicle(data, vehicleId);
    if (req.customer && req.customer.orgId && orgId && req.customer.orgId !== orgId) {
      return res.status(403).json({ error: "Forbidden" });
    }
    for (const sample of samples) {
      const ts = sample.ts || nowIso();
      const decodedMetrics = {
        speedKph: sample.speed ?? null,
        rpm: sample.rpm ?? null,
        coolantTempC: sample.coolant_temp ?? null,
        fuelLevelPct: sample.fuel_level ?? null,
        batteryVoltageV: sample.voltage ?? null,
        odometerMiles: sample.odometer ?? null
      };
      const decoded = { metrics: decodedMetrics, dtc: { active: [] } };
      const normalized = normalizeMetrics({
        decoded,
        protocol: "OBD2",
        timestamp: ts,
        orgId,
        vehicleId
      });
      storeNormalizedSnapshot(data, normalized, {
        driverId: sanitizeString(payload.driver_id || "", 80) || null,
        deviceId: sanitizeString(payload.device_id || "", 80) || null,
        rawPids: decodedMetrics,
        derivedMetrics: {}
      });
    }
    await writeData(data);
    triggerTelemetryPipeline();
    return res.json({ received: samples.length, stored: true });
  })().catch((err) => {
    res.status(500).json({ error: err.message || "Telemetry ingest failed" });
  });
});

app.get("/api/driver/alerts", (req, res) => {
  (async () => {
    const vehicleId = sanitizeString(req.query.vehicle_id || "", 80);
    if (!vehicleId) {
      return res.status(400).json({ error: "vehicle_id required" });
    }
    const data = await readData();
    const items = (data.notifications || []).filter(
      (n) =>
        n.recipient_type === "driver" &&
        n.vehicle_id === vehicleId &&
        n.status !== "read"
    );
    const alerts = items.map((n) => ({
      id: n.id,
      severity: n.severity,
      message: n.title ? `${n.title}: ${n.body}` : n.body,
      created_at: n.created_at
    }));
    return res.json(alerts);
  })().catch((err) => {
    res.status(500).json({ error: err.message || "Failed to load alerts" });
  });
});

app.post("/api/driver/alerts/:id/ack", (req, res) => {
  (async () => {
    const data = await readData();
    const notif = (data.notifications || []).find((n) => n.id === req.params.id);
    if (!notif) {
      return res.status(404).json({ error: "Alert not found" });
    }
    notif.status = "read";
    await writeData(data);
    return res.json({ acknowledged: true });
  })().catch((err) => {
    res.status(500).json({ error: err.message || "Failed to acknowledge alert" });
  });
});

app.get("/api/driver/config", (req, res) => {
  res.json({ ok: true, pairingEnabled: true });
});

app.get("/api/drivers/me", (req, res) => {
  res.json({ ok: true, driver: null });
});

app.post("/api/vehicles/select", (req, res) => {
  res.json({ ok: true });
});

app.post("/api/logs/hos", (req, res) => {
  res.json({ ok: true });
});

app.get("/api/logs/hos", (req, res) => {
  res.json({ ok: true, logs: [] });
});

app.post("/api/telemetry/snapshot", (req, res) => {
  (async () => {
    const payload = req.body || {};
    const vehicleId = sanitizeString(payload.vehicleId || "", 80);
    if (!vehicleId) {
      return res.status(400).json({ error: "vehicleId required" });
    }
    const data = await readData();
    const orgId = resolveOrgIdForVehicle(data, vehicleId);
    const ts = payload.timestamp || nowIso();
    const pids = payload.pids || {};
    const decodedMetrics = {
      coolantTempC: pids.coolantTemp ?? null,
      rpm: pids.rpm ?? null,
      speedKph: pids.speed ?? null,
      oilTempC: pids.oilTemp ?? null,
      batteryVoltageV: pids.voltage ?? null,
      fuelLevelPct: pids.fuelLevel ?? null
    };
    const decoded = { metrics: decodedMetrics, dtc: { active: payload.dtcs || [] } };
    const normalized = normalizeMetrics({
      decoded,
      protocol: "OBD2",
      timestamp: ts,
      orgId,
      vehicleId
    });
    storeNormalizedSnapshot(data, normalized, {
      driverId: sanitizeString(payload.driverId || "", 80) || null,
      deviceId: sanitizeString(payload.deviceId || "", 80) || null,
      rawPids: pids,
      derivedMetrics: {},
      odometerMiles: parseNumberField(payload.odometer || null),
      engineHours: parseNumberField(payload.engineHours || null)
    });
    await writeData(data);
    triggerTelemetryPipeline();
    res.json({ ok: true });
  })().catch((err) => {
    res.status(500).json({ error: err.message || "Telemetry snapshot failed" });
  });
});

app.post("/api/alerts", (req, res) => {
  (async () => {
    const payload = req.body || {};
    const vehicleId = sanitizeString(payload.vehicleId || "", 80);
    const message = sanitizeString(payload.message || "", 400);
    if (!vehicleId || !message) {
      return res.status(400).json({ error: "vehicleId and message required" });
    }
    const data = await readData();
    const orgId = resolveOrgIdForVehicle(data, vehicleId);
    const severity = sanitizeString(payload.severity || "info", 20);
    const notification = {
      id: makeId("NOTIF"),
      org_id: orgId,
      recipient_type: "fleet_manager",
      recipient_id: orgId,
      vehicle_id: vehicleId,
      event_id: "",
      title: "Driver Alert",
      body: message,
      severity,
      status: "unread",
      created_at: nowIso()
    };
    data.notifications = Array.isArray(data.notifications) ? data.notifications : [];
    data.notifications.unshift(notification);
    await writeData(data);
    res.json({ ok: true });
  })().catch((err) => {
    res.status(500).json({ error: err.message || "Alert ingest failed" });
  });
});

app.get("/api/vehicle/dtcs", (req, res) => {
  res.json({ dtcs: [] });
});

async function ensureDataFile() {
  // storage layer now handles initialization
  return;
}

function migrateData(raw) {
  const data = typeof raw === "object" && raw ? raw : {};
  const current = Number(data.schemaVersion || 0);
  if (current < 1) {
    data.schemaVersion = 1;
  }
  if (current < 2) {
    if (!Array.isArray(data.telemetrySamples)) {
      data.telemetrySamples = Array.isArray(data.telemetry_samples) ? data.telemetry_samples : [];
    }
    if (!Array.isArray(data.maintenanceLogs)) {
      data.maintenanceLogs = Array.isArray(data.maintenance_logs) ? data.maintenance_logs : [];
    }
    if (!Array.isArray(data.fuelEvents)) {
      data.fuelEvents = Array.isArray(data.fuel_events) ? data.fuel_events : [];
    }
    if (!Array.isArray(data.modelState)) {
      data.modelState = Array.isArray(data.model_state) ? data.model_state : [];
    }
    if (!Array.isArray(data.alerts)) {
      data.alerts = [];
    }
  }
  data.schemaVersion = DATA_SCHEMA_VERSION;
  return data;
}

function normalizeData(data) {
  const out = typeof data === "object" && data ? data : {};
  out.schemaVersion = Number(out.schemaVersion || DATA_SCHEMA_VERSION);
  out.users = Array.isArray(out.users) ? out.users : [];
  out.orgs = Array.isArray(out.orgs) ? out.orgs : [];
  out.leads = Array.isArray(out.leads) ? out.leads : [];
  out.invites = Array.isArray(out.invites) ? out.invites : [];
  out.audit = Array.isArray(out.audit) ? out.audit : [];
  out.featureFlags = typeof out.featureFlags === "object" && out.featureFlags ? out.featureFlags : {};
  out.billing = typeof out.billing === "object" && out.billing ? out.billing : {};
  out.vehicles = Array.isArray(out.vehicles) ? out.vehicles : [];
  out.drivers = Array.isArray(out.drivers) ? out.drivers : [];
  out.pairings = Array.isArray(out.pairings) ? out.pairings : [];
  out.telemetryRecords = Array.isArray(out.telemetryRecords) ? out.telemetryRecords : [];
  out.telemetrySnapshots = Array.isArray(out.telemetrySnapshots) ? out.telemetrySnapshots : [];
  out.telemetryAggregates = Array.isArray(out.telemetryAggregates) ? out.telemetryAggregates : [];
  out.telemetryFrames = Array.isArray(out.telemetryFrames) ? out.telemetryFrames : [];
  out.telemetrySamples = Array.isArray(out.telemetrySamples)
    ? out.telemetrySamples
    : Array.isArray(out.telemetry_samples) ? out.telemetry_samples : [];
  out.fuelEvents = Array.isArray(out.fuelEvents)
    ? out.fuelEvents
    : Array.isArray(out.fuel_events) ? out.fuel_events : [];
  out.events = Array.isArray(out.events) ? out.events : [];
  out.alerts = Array.isArray(out.alerts) ? out.alerts : [];
  out.notifications = Array.isArray(out.notifications) ? out.notifications : [];
  out.baselines = Array.isArray(out.baselines) ? out.baselines : [];
  out.modelState = Array.isArray(out.modelState)
    ? out.modelState
    : Array.isArray(out.model_state) ? out.model_state : [];
  out.trendSignals = Array.isArray(out.trendSignals) ? out.trendSignals : [];
  out.patternSignatures = Array.isArray(out.patternSignatures) ? out.patternSignatures : [];
  out.recommendations = Array.isArray(out.recommendations) ? out.recommendations : [];
  out.maintenanceLogs = Array.isArray(out.maintenanceLogs)
    ? out.maintenanceLogs
    : Array.isArray(out.maintenance_logs) ? out.maintenance_logs : [];
  out.workOrders = Array.isArray(out.workOrders) ? out.workOrders : [];
  out.workOrderLineItems = Array.isArray(out.workOrderLineItems) ? out.workOrderLineItems : [];
  out.fleetAddons = Object.assign({}, DEFAULT_DATA.fleetAddons, out.fleetAddons || {});
  out.addonQuotes = Array.isArray(out.addonQuotes) ? out.addonQuotes : [];
  out.tenantSettings = Object.assign({}, DEFAULT_DATA.tenantSettings, out.tenantSettings || {});
  out.settings = Object.assign({}, DEFAULT_DATA.settings, out.settings || {});
  const legacyBilling = out.orgBilling || null;
  out.orgBillingSettings = Object.assign(
    {},
    defaultBillingSettings(out),
    out.orgBillingSettings || legacyBilling || {}
  );
  out.paymentMethod = Object.assign({}, defaultPaymentMethod(), out.paymentMethod || {});
  return out;
}

function extractJsonErrorPosition(message) {
  if (!message) return null;
  const match = /position\s+(\d+)/i.exec(message);
  if (!match) return null;
  return Number(match[1]);
}

function stripBom(raw) {
  if (!raw) return "";
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
}

function describeJsonError(raw, message) {
  const pos = extractJsonErrorPosition(message);
  if (pos === null || !Number.isFinite(pos)) return { line: null, column: null };
  const prefix = raw.slice(0, pos);
  const lines = prefix.split(/\r?\n/);
  const line = lines.length;
  const column = lines[lines.length - 1].length + 1;
  return { line, column };
}

function parseJsonWithDiagnostics(filePath, raw) {
  try {
    return JSON.parse(raw);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    const detail = describeJsonError(raw, message);
    console.log(`[CONFIG_PARSE_ERROR] file=${filePath} ${message}`);
    if (detail.line && detail.column) {
      console.log(`[CONFIG_PARSE_ERROR] line=${detail.line} column=${detail.column}`);
    }
    if (process.env.NODE_ENV !== "production") {
      const head = raw.slice(0, 200);
      const tail = raw.slice(Math.max(0, raw.length - 200));
      console.log(`[CONFIG_PARSE_ERROR] head=${JSON.stringify(head)}`);
      console.log(`[CONFIG_PARSE_ERROR] tail=${JSON.stringify(tail)}`);
    }
    const error = new Error("CONFIG_PARSE_ERROR");
    error.code = "CONFIG_PARSE_ERROR";
    error.file = filePath;
    error.detail = message;
    throw error;
  }
}

function attemptJsonRecovery(raw) {
  const cleaned = stripBom(raw).trim();
  try {
    return { recovered: false, data: JSON.parse(cleaned), note: "trimmed" };
  } catch (err) {
    const lastBrace = cleaned.lastIndexOf("}");
    const lastBracket = cleaned.lastIndexOf("]");
    const cut = Math.max(lastBrace, lastBracket);
    if (cut < 0) return null;
    const slice = cleaned.slice(0, cut + 1).trim();
    try {
      return { recovered: true, data: JSON.parse(slice), note: "truncated" };
    } catch (err2) {
      return null;
    }
  }
}

function findLatestBackup(filePath) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  let latest = null;
  let latestTs = "";
  try {
    const files = fs.readdirSync(dir);
    files.forEach((name) => {
      if (!name.startsWith(`${base}.bak-`)) return;
      const stamp = name.slice(`${base}.bak-`.length);
      if (!latest || stamp > latestTs) {
        latest = path.join(dir, name);
        latestTs = stamp;
      }
    });
  } catch (err) {
    return null;
  }
  return latest;
}

function formatJsonSnippet(raw, line, radius = 2) {
  if (!line) return "";
  const lines = raw.split(/\r?\n/);
  const start = Math.max(1, line - radius);
  const end = Math.min(lines.length, line + radius);
  const out = [];
  for (let i = start; i <= end; i += 1) {
    out.push(`${String(i).padStart(4, " ")}: ${lines[i - 1]}`);
  }
  return out.join("\n");
}

let dataStore = null;
function initStorage() {
  if (dataStore) return dataStore;
  dataStore = createDataStore({
    dataPath: DATA_PATH,
    defaultData: DEFAULT_DATA,
    normalize: (data) => normalizeData(migrateData(data))
  });
  return dataStore;
}

function syncStorageStatus() {
  if (!dataStore) return;
  const status = dataStore.getStatus();
  dataLoadStatus = status.status || "unknown";
  dataLoadError = status.lastError || null;
  dataLoadNote = status.note || null;
  lastDataWriteAt = status.lastWriteAt || lastDataWriteAt;
}

function reportDataIntegrity(data) {
  const store = initStorage();
  const status = store.getStatus();
  const counts = store.normalizeReport ? store.normalizeReport(data) : { users: 0, orgs: 0 };
  console.log(`[DATA] integrity users=${counts.users} orgs=${counts.orgs} status=${status.status || "unknown"} note=${status.note || ""}`);
}

function validateJsonFile() {
  initStorage();
  return dataStore.validate().then((result) => {
    syncStorageStatus();
    console.log(`[CONFIG] valid json: ${DATA_PATH}`);
    return result;
  });
}

async function readData() {
  initStorage();
  const data = await dataStore.loadData();
  syncStorageStatus();
  lastDataLoadAt = new Date().toISOString();
  normalizeAuthData(data);
  if (dataLoadStatus === "RECOVERED") {
    console.warn(`[DATA] recovered store from ${DATA_PATH} note=${dataLoadNote || "unknown"}`);
  }
  if (dataLoadStatus === "RESET") {
    const message = `[DATA] failed to parse ${DATA_PATH}; storage reset to default (note=${dataLoadNote || "unknown"}). Refusing to continue.`;
    console.error(message);
    process.exit(1);
  }
  return data;
}

async function writeData(data) {
  initStorage();
  const payload = Object.assign({}, data, {
    schemaVersion: DATA_SCHEMA_VERSION,
    telemetry_samples: data.telemetrySamples || [],
    maintenance_logs: data.maintenanceLogs || [],
    fuel_events: data.fuelEvents || [],
    model_state: data.modelState || [],
    alerts: data.alerts || []
  });
  if (!Array.isArray(payload.users) || payload.users.length === 0) {
    const existing = await storage.loadData();
    if (Array.isArray(existing.users) && existing.users.length > 0) {
      payload.users = existing.users;
      console.warn("[AUTH] preserved users during write to avoid auth store loss");
    }
  }
  await dataStore.safeWriteData(payload);
  syncStorageStatus();
}

async function runDevAuthRepair() {
  if (IS_PROD || !DEV_SETUP) return { ran: false };
  const data = await readData();
  const { demoUsers, generatedPasswords } = buildDemoUsers();
  const result = await applyAuthStoreRepair(data, {
    demoUsers,
    resetPasswords: DEV_SETUP_RESET_PASSWORDS,
    defaultOrgId: "ORG_DEFAULT"
  });
  if (!result.changed) return { ran: true, changed: false, report: result.report };
  const store = initStorage();
  const backupPath = await store.createBackup();
  await writeData(result.data);
  console.log(`[AUTH] dev repair applied changes. backup=${backupPath || "none"}`);
  console.log(`[AUTH] dev repair report: ${JSON.stringify(result.report)}`);
  logGeneratedPasswords("dev repair", result.report, generatedPasswords);
  return { ran: true, changed: true, report: result.report };
}


// user normalization handled by authStore.normalizeAuthData

async function restoreUsersIfEmpty(data) {
  if (Array.isArray(data.users) && data.users.length > 0) {
    return { data, restored: false };
  }
  const backupsDir = path.resolve(__dirname, "server");
  const backups = fs.existsSync(backupsDir)
    ? fs.readdirSync(backupsDir).filter((f) => f.startsWith("data.json.bak"))
    : [];
  if (backups.length) {
    console.warn("[AUTH] backups detected but automatic restore is disabled. Skipping .bak files.");
  }
  if (SETUP_ALLOWED && SETUP_KEY) {
    const adminUser = {
      id: makeId("ADMIN"),
      email: "admin@fleetai.local".toLowerCase().trim(),
      role: "admin",
      orgId: "ORG_DEFAULT",
      isActive: true,
      verified: true,
      createdAt: nowIso(),
      lastLoginAt: null,
      passwordHash: await bcrypt.hash(SETUP_KEY, 12),
      mustSetPassword: true,
      requirePasswordReset: true
    };
    data.users = [adminUser];
    await writeData(data);
    console.warn("[AUTH] bootstrap admin created with FLEETAI_SETUP_KEY. Please change password after login.");
    return { data, restored: true, source: "bootstrap" };
  }
  console.warn("[AUTH] auth store empty and no backup/bootstrap available");
  return { data, restored: false };
}

async function ensureBootstrapCustomer(data) {
  if (!BOOTSTRAP_CUSTOMER_ENABLED) return { created: false };
  if (!Array.isArray(data.users)) data.users = [];
  const email = BOOTSTRAP_CUSTOMER_EMAIL;
  if (!email) return { created: false };
  const existing = data.users.find((u) => String(u.email || "").toLowerCase() === email);
  if (existing) return { created: false };
  if (!SETUP_KEY) {
    console.warn("[AUTH] bootstrap customer requested but FLEETAI_SETUP_KEY is missing");
    return { created: false };
  }
  // ensure default org exists
  if (!Array.isArray(data.orgs)) data.orgs = [];
  let org = data.orgs.find((o) => o.id === "ORG_DEFAULT");
  if (!org) {
    org = { id: "ORG_DEFAULT", name: "Default Org", createdAt: nowIso() };
    data.orgs.push(org);
  }
  const passwordHash = await bcrypt.hash(SETUP_KEY, 12);
  const user = {
    id: makeId("CUST"),
    email,
    role: "CUSTOMER",
    orgId: org.id,
    isActive: true,
    active: true,
    verified: true,
    createdAt: nowIso(),
    lastLoginAt: null,
    passwordHash,
    mustSetPassword: true,
    requirePasswordReset: true
  };
  data.users.push(user);
  await writeData(data);
  console.warn(`[AUTH] bootstrap customer created: ${email} (org ${org.id})`);
  return { created: true };
}

async function atomicWrite(filePath, contents) {
  const tempPath = `${filePath}.tmp`;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${filePath}.bak-${stamp}`;
  await fsp.writeFile(tempPath, contents, "utf-8");
  if (fs.existsSync(filePath)) {
    try {
      await fsp.rename(filePath, backupPath);
    } catch (err) {
      try {
        await fsp.copyFile(filePath, backupPath);
        await fsp.unlink(filePath);
      } catch (backupErr) {
        console.warn(`[CONFIG] backup failed: ${backupPath}`);
      }
    }
  }
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

function buildCookieAttributes(maxAgeSeconds) {
  const parts = [
    "HttpOnly",
    "Path=/",
    `Max-Age=${maxAgeSeconds}`,
    `SameSite=${COOKIE_SAMESITE || "Lax"}`
  ];
  if (COOKIE_SECURE) parts.push("Secure");
  return parts.join("; ");
}

function setSessionCookie(res, sessionId) {
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}; ${buildCookieAttributes(Math.floor(SESSION_TTL_MS / 1000))}`
  );
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; ${buildCookieAttributes(0)}`);
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

function getSessionFromRequest(req) {
  const cookieSession = getSession(req);
  if (cookieSession) return { session: cookieSession, source: "cookie" };
  let token = "";
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ")) token = auth.slice(7).trim();
  if (!token && req.headers["x-fleetai-token"]) token = String(req.headers["x-fleetai-token"]);
  if (!token && req.query && req.query.token) token = String(req.query.token);
  if (!token) return null;
  const session = sessionStore.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessionStore.delete(token);
    return null;
  }
  return { session, source: "token", token };
}

function issueSession(scope, user) {
  const sessionId = crypto.randomBytes(24).toString("hex");
  const session = {
    id: sessionId,
    userId: user.id || null,
    email: user.email,
    role: user.role,
    loginRole: scope,
    orgId: user.orgId || null,
    displayName: user.displayName || "",
    createdAt: nowIso(),
    expiresAt: Date.now() + SESSION_TTL_MS
  };
  if (scope === "customer") {
    customerSessionStore.set(sessionId, session);
  } else {
    sessionStore.set(sessionId, session);
  }
  return session;
}

function setCustomerSessionCookie(res, sessionId) {
  res.setHeader(
    "Set-Cookie",
    `${CUSTOMER_SESSION_COOKIE}=${encodeURIComponent(sessionId)}; ${buildCookieAttributes(Math.floor(SESSION_TTL_MS / 1000))}`
  );
}

function clearCustomerSessionCookie(res) {
  res.setHeader("Set-Cookie", `${CUSTOMER_SESSION_COOKIE}=; ${buildCookieAttributes(0)}`);
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
  return { session, source: "cookie" };
}

function requireEmployeeSession(req, res, next) {
  const result = getSessionFromRequest(req);
  if (!result) {
    return res.redirect("/employee-login.html");
  }
  if (result.source === "token") {
    setSessionCookie(res, result.token);
  }
  req.employee = result.session;
  next();
}

function formatAuthResponse({ ok, code, message, session = null, next = null }) {
  return { ok, code, message, next, session };
}

function issueFirstLoginToken(user) {
  const token = crypto.randomBytes(24).toString("hex");
  const expiresAt = Date.now() + 15 * 60 * 1000;
  firstLoginTokens.set(token, {
    userId: user.id,
    orgId: user.orgId || null,
    role: user.role || null,
    expiresAt
  });
  return { token, expiresAt };
}

function validateFirstLoginToken(token) {
  if (!token || !firstLoginTokens.has(token)) return null;
  const entry = firstLoginTokens.get(token);
  if (!entry || entry.expiresAt < Date.now()) {
    firstLoginTokens.delete(token);
    return null;
  }
  return entry;
}

function requireSuperAdmin(req, res, next) {
  const result = getSessionFromRequest(req);
  if (!result) {
    if (req.path.startsWith("/api")) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    return res.redirect("/employee-login.html");
  }
  if (result.source === "token") {
    setSessionCookie(res, result.token);
  }
  if (result.session.role !== "SUPER_ADMIN") {
    if (req.path.startsWith("/api")) {
      return res.status(403).json({ error: "Forbidden" });
    }
    return res.redirect("/employee-login.html");
  }
  req.employee = result.session;
  next();
}

function requireEmployeeApi(req, res, next) {
  const result = getSessionFromRequest(req);
  if (!result) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (result.source === "token") {
    setSessionCookie(res, result.token);
  }
  req.employee = result.session;
  next();
}

function requireCustomerApi(req, res, next) {
  const session = getCustomerSession(req);
  if (!session) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  req.customer = session;
  next();
}

function requireEmployeeOrCustomerApi(req, res, next) {
  const employee = getSession(req);
  const customer = getCustomerSession(req);
  if (!employee && !customer) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (employee) req.employee = employee;
  if (customer) req.customer = customer;
  return next();
}

const pairingRouter = createPairingRouter({
  storage: initStorage(),
  requireAuth: requireEmployeeOrCustomerApi,
  log: console.log
});
app.use("/api/pairing", pairingRouter);

function requireRole(roles) {
  return (req, res, next) => {
    if (!req.employee) return res.status(401).json({ error: "Unauthorized" });
    if (!roles.includes(req.employee.role)) {
      return res.status(403).json({ error: "Forbidden" });
    }
    return next();
  };
}

function nowIso() {
  return new Date().toISOString();
}

function sanitizeString(value, max = 500) {
  if (!value) return "";
  const clean = String(value).replace(/[<>]/g, "").trim();
  return clean.slice(0, max);
}

function normalizeEmail(value) {
  const email = sanitizeString(value, 200).toLowerCase();
  if (!email) return "";
  return /^[^@]+@[^@]+\.[^@]+$/.test(email) ? email : "";
}

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

function parseNumberField(value, fallback = null) {
  if (value === undefined || value === null || value === "") return fallback;
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function parseIsoDate(value) {
  if (!value) return null;
  const ts = new Date(value).toISOString();
  return ts;
}

function safeParseIsoDate(value) {
  if (!value) return null;
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toISOString();
}

function normalizeMaintenanceType(value) {
  const raw = String(value || "").toLowerCase();
  const allowed = [
    "oil_change",
    "tire_rotation",
    "brakes",
    "coolant_service",
    "transmission_service",
    "inspection",
    "repair",
    "other"
  ];
  if (allowed.includes(raw)) return raw;
  return "other";
}

const MAINTENANCE_SERVICE_TYPES = [
  { code: "OIL_CHANGE", label: "Oil Change", category: "Oil Change" },
  { code: "TIRE_ROTATION", label: "Tire Rotation", category: "Tires" },
  { code: "TIRE_CHANGE_REPLACEMENT", label: "Tire Change/Replacement", category: "Tires" },
  { code: "BRAKE_INSPECTION", label: "Brake Inspection", category: "Brakes" },
  { code: "BRAKE_PADS_SHOES_REPLACEMENT", label: "Brake Pads/Shoes Replacement", category: "Brakes" },
  { code: "BRAKE_ADJUSTMENT", label: "Brake Adjustment", category: "Brakes" },
  { code: "AIR_FILTER_REPLACEMENT", label: "Air Filter Replacement", category: "Air Intake" },
  { code: "FUEL_FILTER_REPLACEMENT", label: "Fuel Filter Replacement", category: "Fuel System" },
  { code: "CABIN_FILTER_REPLACEMENT", label: "Cabin Filter Replacement", category: "Air Intake" },
  { code: "COOLANT_FLUSH_SERVICE", label: "Coolant Flush/Service", category: "Cooling System" },
  { code: "THERMOSTAT_REPLACEMENT", label: "Thermostat Replacement", category: "Cooling System" },
  { code: "RADIATOR_REPLACEMENT_REPAIR", label: "Radiator Replacement/Repair", category: "Cooling System" },
  { code: "WATER_PUMP_REPLACEMENT", label: "Water Pump Replacement", category: "Cooling System" },
  { code: "SERPENTINE_BELT_REPLACEMENT", label: "Serpentine Belt Replacement", category: "Drivetrain" },
  { code: "BATTERY_REPLACEMENT", label: "Battery Replacement", category: "Electrical" },
  { code: "ALTERNATOR_REPLACEMENT", label: "Alternator Replacement", category: "Electrical" },
  { code: "STARTER_REPLACEMENT", label: "Starter Replacement", category: "Electrical" },
  { code: "TRANSMISSION_SERVICE", label: "Transmission Service", category: "Transmission" },
  { code: "DIFFERENTIAL_SERVICE", label: "Differential Service", category: "Drivetrain" },
  { code: "WHEEL_ALIGNMENT", label: "Wheel Alignment", category: "Tires" },
  { code: "SUSPENSION_INSPECTION", label: "Suspension Inspection", category: "Inspection" },
  { code: "SHOCK_STRUT_REPLACEMENT", label: "Shock/Strut Replacement", category: "Drivetrain" },
  { code: "INJECTOR_SERVICE_REPLACEMENT", label: "Injector Service/Replacement", category: "Fuel System" },
  { code: "GLOW_PLUG_REPLACEMENT", label: "Glow Plug Replacement", category: "Electrical" },
  { code: "DPF_REGEN_SERVICE", label: "DPF Regeneration/Service", category: "Emissions/DPF" },
  { code: "DEF_SYSTEM_SERVICE", label: "DEF System Service", category: "Emissions/DPF" },
  { code: "EGR_SYSTEM_SERVICE", label: "EGR System Service", category: "Emissions/DPF" },
  { code: "SENSOR_REPLACEMENT", label: "Sensor Replacement", category: "Sensors" },
  { code: "CHECK_ENGINE_DIAGNOSTIC_SCAN", label: "Check Engine / Diagnostic Scan", category: "Inspection" },
  { code: "OTHER", label: "Other", category: "Other" },
  { code: "MANUAL", label: "Other (Manual Entry)", category: "Other" }
];

const MAINTENANCE_SERVICE_TYPE_MAP = new Map(
  MAINTENANCE_SERVICE_TYPES.map((entry) => [entry.code, entry])
);
const MAINTENANCE_SERVICE_LABEL_MAP = new Map(
  MAINTENANCE_SERVICE_TYPES.map((entry) => [entry.label.toLowerCase(), entry.code])
);
const MAINTENANCE_SERVICE_ALIAS_MAP = new Map([
  ["MANUAL ENTRY", "MANUAL"],
  ["OTHER (MANUAL ENTRY)", "MANUAL"],
  ["OTHER/MANUAL", "MANUAL"],
  ["OTHER", "OTHER"]
]);

function normalizeServiceType(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const upper = raw.toUpperCase();
  if (MAINTENANCE_SERVICE_TYPE_MAP.has(upper)) return upper;
  if (MAINTENANCE_SERVICE_ALIAS_MAP.has(upper)) return MAINTENANCE_SERVICE_ALIAS_MAP.get(upper);
  const labelKey = raw.toLowerCase();
  if (MAINTENANCE_SERVICE_LABEL_MAP.has(labelKey)) return MAINTENANCE_SERVICE_LABEL_MAP.get(labelKey);
  return "";
}

function serviceTypeLabel(code) {
  return MAINTENANCE_SERVICE_TYPE_MAP.get(code)?.label || "Other";
}

function serviceTypeCategoryLabel(code) {
  return MAINTENANCE_SERVICE_TYPE_MAP.get(code)?.category || "Other";
}

function serviceTypeLegacyType(code) {
  return normalizeMaintenanceType(mapCategoryToType(serviceTypeCategoryLabel(code)));
}

function normalizePartsList(partsInput) {
  if (Array.isArray(partsInput)) {
    return partsInput.map((part) => sanitizeString(part, 200)).filter(Boolean);
  }
  if (typeof partsInput === "string") {
    return partsInput
      .split(",")
      .map((part) => sanitizeString(part, 200))
      .filter(Boolean);
  }
  return [];
}

function parseOptionalNumber(value, field, errors) {
  if (value === undefined || value === null || value === "") return null;
  const num = Number(value);
  if (!Number.isFinite(num)) {
    errors.push(`${field} must be a valid number`);
    return null;
  }
  return num;
}

function getMaintenanceLogTimestamp(log) {
  const date = log.performedAt || log.occurredAt || log.serviceDate || log.createdAt;
  const ms = Date.parse(date);
  return Number.isFinite(ms) ? ms : 0;
}

const MAINT_LOG_CATEGORIES = new Map([
  ["oil change", "Oil Change"],
  ["cooling system", "Cooling System"],
  ["fuel system", "Fuel System"],
  ["electrical", "Electrical"],
  ["brakes", "Brakes"],
  ["tires", "Tires"],
  ["sensors", "Sensors"],
  ["drivetrain", "Drivetrain"],
  ["transmission", "Transmission"],
  ["emissions/dpf", "Emissions/DPF"],
  ["inspection", "Inspection"],
  ["other", "Other"]
]);

function normalizeMaintenanceCategory(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "Other";
  for (const [key, label] of MAINT_LOG_CATEGORIES.entries()) {
    if (raw === key) return label;
  }
  return "Other";
}

function mapCategoryToType(category) {
  const raw = String(category || "").toLowerCase();
  if (raw.includes("oil")) return "oil_change";
  if (raw.includes("cool")) return "coolant_service";
  if (raw.includes("transmission")) return "transmission_service";
  if (raw.includes("brake")) return "brakes";
  if (raw.includes("tire")) return "tire_rotation";
  if (raw.includes("inspection")) return "inspection";
  if (raw.includes("repair")) return "repair";
  return "other";
}

function normalizeMaintenanceEnum(value) {
  const raw = String(value || "").trim().toLowerCase();
  const map = new Map([
    ["oil change", "OIL_SERVICE"],
    ["oil_service", "OIL_SERVICE"],
    ["cooling system", "COOLING"],
    ["coolant_service", "COOLING"],
    ["fuel system", "FUEL_SYSTEM"],
    ["fuel_system", "FUEL_SYSTEM"],
    ["electrical", "ELECTRICAL"],
    ["charging", "CHARGING"],
    ["brakes", "BRAKES"],
    ["tires", "TIRES"],
    ["transmission", "TRANSMISSION"],
    ["drivetrain", "DRIVETRAIN"],
    ["sensors", "SENSORS"],
    ["air intake", "AIR_INTAKE"],
    ["air_intake", "AIR_INTAKE"],
    ["exhaust", "EXHAUST_EMISSIONS"],
    ["emissions/dpf", "EXHAUST_EMISSIONS"],
    ["inspection", "INSPECTION"],
    ["other", "OTHER"]
  ]);
  if (!raw) return "OTHER";
  if (map.has(raw)) return map.get(raw);
  if (raw.includes("oil")) return "OIL_SERVICE";
  if (raw.includes("cool")) return "COOLING";
  if (raw.includes("fuel")) return "FUEL_SYSTEM";
  if (raw.includes("brake")) return "BRAKES";
  if (raw.includes("tire")) return "TIRES";
  if (raw.includes("transmission")) return "TRANSMISSION";
  if (raw.includes("drivetrain")) return "DRIVETRAIN";
  if (raw.includes("sensor")) return "SENSORS";
  if (raw.includes("intake")) return "AIR_INTAKE";
  if (raw.includes("emission") || raw.includes("dpf")) return "EXHAUST_EMISSIONS";
  if (raw.includes("inspect")) return "INSPECTION";
  if (raw.includes("charge") || raw.includes("battery")) return "CHARGING";
  return "OTHER";
}

function sanitizePartsList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => ({
    partName: sanitizeString(item.partName || "", 200),
    partNumber: sanitizeString(item.partNumber || "", 80),
    qty: parseNumberField(item.qty, null),
    cost: parseNumberField(item.cost, null)
  })).filter((p) => p.partName);
}

function requireApiToken(req, res, next) {
  if (!API_TOKEN) return next();
  const token = req.headers["x-fleetai-token"];
  if (!token || token !== API_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

const TELEMETRY_ALIASES = {
  coolant: ["coolant_temp", "coolant_temp_f", "coolant_temp_c", "engine_coolant_temp", "coolantTempC"],
  battery: ["battery_voltage", "battery_v", "voltage", "charging_voltage", "batteryVoltageV"],
  fuelEff: ["fuel_efficiency", "fuel_mpg", "fuel_economy"],
  fuelTrim: ["short_term_fuel_trim", "long_term_fuel_trim", "stft", "ltft"],
  maf: ["maf", "mass_air_flow", "mafGramsPerSec"],
  misfire: ["misfire", "misfire_count"],
  speed: ["speed", "vehicle_speed", "speed_kph", "speed_mph", "speedKph"],
  rpm: ["rpm", "engine_rpm"],
  fuelLevel: ["fuel_level", "fuel_level_pct", "fuelLevelPct"],
  odometer: ["odometer", "mileage", "distance"],
  engineHours: ["engine_hours", "engine_runtime", "engineHours"]
};

const DASHBOARD_SIGNAL_MAP = {
  speed: TELEMETRY_ALIASES.speed,
  rpm: TELEMETRY_ALIASES.rpm,
  coolant_temp: TELEMETRY_ALIASES.coolant,
  fuel_level: TELEMETRY_ALIASES.fuelLevel,
  mileage: TELEMETRY_ALIASES.odometer,
  engine_hours: TELEMETRY_ALIASES.engineHours,
  battery_v: TELEMETRY_ALIASES.battery
};

const BASELINE_WINDOWS_DAYS = [7, 14, 30];
const BASELINE_MIN_SAMPLES = { 7: 50, 14: 100, 30: 200 };
const BASELINE_METRICS = [
  "coolantTemp",
  "batteryVoltage",
  "engineLoad",
  "maf",
  "rpm",
  "stft1",
  "ltft1",
  "intakeAirTemp"
];

const PREDICTIVE_RULES = [
  {
    id: "COOLANT_DRIFT_UP",
    metricKey: "coolantTemp",
    windowDays: 7,
    severity: (stats) => {
      if (stats.mean == null || stats.baselineMean == null) return null;
      if (stats.mean > stats.baselineMean + 10) return "critical";
      if (
        stats.mean > stats.baselineMean + Math.max(stats.baselineStdDev * 2, 6) ||
        stats.slopePerDay > 0.8
      ) {
        return "warning";
      }
      return null;
    },
    serviceWindowDays: { warning: 14, critical: 3 },
    recommendedAction:
      "Inspect cooling system: radiator fins/debris, coolant level, fan operation, thermostat."
  },
  {
    id: "VOLTAGE_DECLINE",
    metricKey: "batteryVoltage",
    windowDays: 7,
    severity: (stats) => {
      if (stats.mean == null || stats.baselineMean == null) return null;
      if (
        stats.mean < stats.baselineMean - Math.max(stats.baselineStdDev * 2, 0.8) ||
        stats.slopePerDay < -0.08
      ) {
        return "critical";
      }
      if (
        stats.mean < stats.baselineMean - Math.max(stats.baselineStdDev * 2, 0.4) ||
        stats.slopePerDay < -0.04
      ) {
        return "warning";
      }
      return null;
    },
    serviceWindowDays: { warning: 7, critical: 3 },
    recommendedAction:
      "Inspect charging system: battery health, alternator output, grounds."
  },
  {
    id: "FUEL_TRIM_DRIFT",
    metricKey: "ltft1",
    windowDays: 7,
    severity: (stats) => {
      if (stats.mean == null || stats.baselineMean == null) return null;
      if (stats.baselineP90 != null && Math.abs(stats.mean) > stats.baselineP90 + 2) {
        return "warning";
      }
      if (Math.abs(stats.mean - stats.baselineMean) > 3) {
        return "warning";
      }
      return null;
    },
    serviceWindowDays: { warning: 14, critical: 7 },
    recommendedAction:
      "Inspect intake leaks, MAF contamination, and fuel delivery."
  },
  {
    id: "DTC_NEW_OR_REPEAT",
    metricKey: "dtcCodes",
    windowDays: 14,
    severity: (stats) => stats.severity || null,
    serviceWindowDays: { warning: 7, critical: 2 },
    recommendedAction:
      "Diagnose DTC; review freeze-frame if available."
  }
];

function normalizeIdentifier(value) {
  if (!value) return "";
  return String(value).trim().toLowerCase().replace(/\s+/g, "_");
}

function coerceNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function resolveOrgIdForVehicle(data, vehicleId, fallback = "ORG_DEFAULT") {
  if (!vehicleId) return fallback;
  const orgs = Array.isArray(data.orgs) ? data.orgs : [];
  for (const org of orgs) {
    const list = Array.isArray(org.vehicleIds) ? org.vehicleIds : Array.isArray(org.vehicles) ? org.vehicles : [];
    if (list.includes(vehicleId)) return org.orgId || org.id;
  }
  if (orgs.length === 1) return orgs[0].orgId || orgs[0].id || fallback;
  return fallback;
}

function normalizeTelemetryRecord(record) {
  const timestamp = record.timestamp || record.ts || nowIso();
  const identifier = normalizeIdentifier(record.identifier || record.pid || record.spn || record.name || "");
  return {
    id: record.id || makeId("TEL"),
    org_id: record.org_id || record.orgId || "",
    vehicle_id: record.vehicle_id || record.vehicleId || "",
    timestamp,
    protocol: record.protocol || "derived",
    identifier,
    name: sanitizeString(record.name || identifier, 120),
    raw_value: record.raw_value ?? record.rawValue ?? null,
    normalized_value: coerceNumber(record.normalized_value ?? record.normalizedValue ?? record.value),
    unit: sanitizeString(record.unit || "", 32),
    source: record.source || "ecu",
    validity: record.validity || "ok"
  };
}

function extractCommonFields(rawPids = {}) {
  const getVal = (keys) => {
    for (const key of keys) {
      if (rawPids[key] !== undefined && rawPids[key] !== null) return rawPids[key];
    }
    return null;
  };
  return {
    speed: parseNumberField(getVal(["speed", "vehicle_speed", "speed_kph", "speed_mph", "speedKph"])),
    rpm: parseNumberField(getVal(["rpm", "engine_rpm"])),
    engineLoad: parseNumberField(getVal(["engine_load", "engineLoadPct"])),
    coolantTemp: parseNumberField(getVal(["coolant_temp", "engine_coolant_temp", "coolantTempC"])),
    intakeAirTemp: parseNumberField(getVal(["intake_air_temp", "intakeAirTempC"])),
    ambientAirTemp: parseNumberField(getVal(["ambient_air_temp", "ambientTempC"])),
    maf: parseNumberField(getVal(["maf", "mass_air_flow", "mafGramsPerSec"])),
    throttlePos: parseNumberField(getVal(["throttle_position", "throttlePosPct"])),
    fuelLevel: parseNumberField(getVal(["fuel_level", "fuel_level_pct", "fuelLevelPct"])),
    fuelRate: parseNumberField(getVal(["fuel_rate", "fuelRateLph"])),
    batteryVoltage: parseNumberField(getVal(["battery_voltage", "control_module_voltage", "voltage", "batteryVoltageV"])),
    stft1: parseNumberField(getVal(["short_term_fuel_trim", "stft", "stft1"])),
    ltft1: parseNumberField(getVal(["long_term_fuel_trim", "ltft", "ltft1"]))
  };
}

function getMetricFromSnapshot(snapshot, metricKey) {
  if (!snapshot) return null;
  if (metricKey === "coolantTemp") return parseNumberField(snapshot.coolantTemp);
  if (metricKey === "batteryVoltage") return parseNumberField(snapshot.batteryVoltage);
  if (metricKey === "engineLoad") return parseNumberField(snapshot.engineLoad);
  if (metricKey === "maf") return parseNumberField(snapshot.maf);
  if (metricKey === "rpm") return parseNumberField(snapshot.rpm);
  if (metricKey === "stft1") return parseNumberField(snapshot.stft1);
  if (metricKey === "ltft1") return parseNumberField(snapshot.ltft1);
  if (metricKey === "intakeAirTemp") return parseNumberField(snapshot.intakeAirTemp);
  return null;
}

function computeQuantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  }
  return sorted[base];
}

function computeStats(values) {
  const count = values.length;
  if (!count) {
    return {
      count: 0,
      mean: null,
      stdDev: null,
      min: null,
      max: null,
      p10: null,
      p50: null,
      p90: null
    };
  }
  const sum = values.reduce((a, b) => a + b, 0);
  const mean = sum / count;
  const variance = values.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / count;
  const stdDev = Math.sqrt(variance);
  const sorted = values.slice().sort((a, b) => a - b);
  return {
    count,
    mean,
    stdDev,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    p10: computeQuantile(sorted, 0.1),
    p50: computeQuantile(sorted, 0.5),
    p90: computeQuantile(sorted, 0.9)
  };
}

function computeSlopePerDay(samples) {
  if (samples.length < 2) return null;
  const points = samples.map((s) => ({
    x: (new Date(s.ts).getTime() - new Date(samples[0].ts).getTime()) / 86400000,
    y: s.value
  }));
  const n = points.length;
  const sumX = points.reduce((a, p) => a + p.x, 0);
  const sumY = points.reduce((a, p) => a + p.y, 0);
  const sumXY = points.reduce((a, p) => a + p.x * p.y, 0);
  const sumXX = points.reduce((a, p) => a + p.x * p.x, 0);
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return null;
  return (n * sumXY - sumX * sumY) / denom;
}

function getSnapshotsInWindow(data, vehicleId, startMs, endMs) {
  return (data.telemetrySnapshots || []).filter((snap) => {
    if (snap.vehicleId !== vehicleId) return false;
    const ts = parseRecordTimestamp(snap.ts);
    return ts && ts >= startMs && ts <= endMs;
  });
}

function getSamplesForMetric(snapshots, metricKey) {
  return snapshots
    .map((snap) => ({
      ts: snap.ts,
      value: getMetricFromSnapshot(snap, metricKey)
    }))
    .filter((s) => s.value !== null && s.value !== undefined);
}

function estimateRatePerDay(samples) {
  if (samples.length < 2) return null;
  const sorted = samples.slice().sort((a, b) => new Date(a.ts) - new Date(b.ts));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const days = (new Date(last.ts) - new Date(first.ts)) / 86400000;
  if (days <= 0) return null;
  return (last.value - first.value) / days;
}

function storeTelemetryRecords(data, records) {
  data.telemetryRecords = Array.isArray(data.telemetryRecords) ? data.telemetryRecords : [];
  data.telemetryRecords.push(...records);
  if (data.telemetryRecords.length > TELEMETRY_RETENTION_LIMIT) {
    data.telemetryRecords = data.telemetryRecords.slice(-TELEMETRY_RETENTION_LIMIT);
  }
}

function getTelemetryRecordsForVehicle(data, vehicleId) {
  return (data.telemetryRecords || []).filter((rec) => rec.vehicle_id === vehicleId);
}

function getLatestTelemetrySnapshot(data, vehicleId) {
  const records = data.telemetryRecords || [];
  const latest = {};
  let latestTs = null;
  const foundKeys = new Set();
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const rec = records[i];
    if (rec.vehicle_id !== vehicleId) continue;
    if (!latestTs) latestTs = rec.timestamp;
    for (const key of Object.keys(DASHBOARD_SIGNAL_MAP)) {
      if (foundKeys.has(key)) continue;
      if (DASHBOARD_SIGNAL_MAP[key].includes(rec.identifier)) {
        latest[key] = rec.normalized_value ?? rec.raw_value ?? null;
        foundKeys.add(key);
      }
    }
    if (foundKeys.size === Object.keys(DASHBOARD_SIGNAL_MAP).length) break;
  }
  const vehicle = (data.vehicles || []).find((v) => v.vehicleId === vehicleId);
  return {
    vehicle_id: vehicleId || null,
    vin: vehicle ? vehicle.vin : null,
    timestamp: latestTs,
    metrics: latest,
    speed: latest.speed,
    rpm: latest.rpm,
    coolant_temp: latest.coolant_temp,
    fuel_level: latest.fuel_level,
    mileage: latest.mileage,
    engine_hours: latest.engine_hours,
    battery_v: latest.battery_v
  };
}

function getLatestNormalizedMetrics(data, vehicleId) {
  const snaps = (data.telemetrySnapshots || []).filter((s) => s.vehicleId === vehicleId);
  if (!snaps.length) return null;
  return snaps[snaps.length - 1];
}

function parseRangeToMs(range) {
  if (!range) return 24 * 60 * 60 * 1000;
  const match = String(range).trim().match(/^(\d+)(m|h|d)$/i);
  if (!match) return 24 * 60 * 60 * 1000;
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === "m") return value * 60 * 1000;
  if (unit === "h") return value * 60 * 60 * 1000;
  if (unit === "d") return value * 24 * 60 * 60 * 1000;
  return 24 * 60 * 60 * 1000;
}

function getMetricValueFromSnapshot(snapshot, metricKey) {
  if (!snapshot) return null;
  const key = String(metricKey || "");
  const map = {
    rpm: snapshot.rpm,
    coolantTempC: snapshot.coolantTemp,
    batteryVoltageV: snapshot.batteryVoltage,
    engineLoadPct: snapshot.engineLoad,
    maf: snapshot.maf,
    stft1: snapshot.stft1,
    ltft1: snapshot.ltft1,
    intakeAirTempC: snapshot.intakeAirTemp,
    speedKph: snapshot.speedKph,
    odometerKm: snapshot.odometerMiles != null ? milesToKm(snapshot.odometerMiles) : null,
    engineHours: snapshot.engineHours,
    fuelLevelPct: snapshot.fuelLevelPct
  };
  return map[key] != null ? map[key] : null;
}

function buildSnapshotFromNormalized(normalized, extra) {
  const engine = normalized.engine || {};
  const vehicle = normalized.vehicle || {};
  const electrical = normalized.electrical || {};
  const dtcActive = Array.isArray(normalized.dtc?.active) ? normalized.dtc.active : [];
  const dtcCodes = dtcActive.map((d) => d.code).filter(Boolean);
  return {
    id: makeId("SNAP"),
    orgId: normalized.orgId || null,
    vehicleId: normalized.vehicleId || null,
    driverId: extra.driverId || null,
    deviceId: extra.deviceId || null,
    ts: normalized.timestamp,
    odometerMiles: vehicle.odometerKm != null ? kmToMiles(vehicle.odometerKm) : (extra.odometerMiles ?? null),
    engineHours: vehicle.engineHours ?? extra.engineHours ?? null,
    dtcCodes,
    rawPids: extra.rawPids || {},
    derivedMetrics: extra.derivedMetrics || {},
    coolantTemp: engine.coolantTempC ?? null,
    batteryVoltage: electrical.batteryVoltageV ?? null,
    engineLoad: engine.engineLoadPct ?? null,
    maf: engine.mafGramsPerSec ?? null,
    rpm: engine.rpm ?? null,
    stft1: engine.stft1 ?? null,
    ltft1: engine.ltft1 ?? null,
    intakeAirTemp: engine.intakeAirTempC ?? null,
    speedKph: vehicle.speedKph ?? null,
    fuelLevelPct: vehicle.fuelLevelPct ?? null,
    sourceProtocol: normalized.sourceProtocol || "UNKNOWN",
    vin: normalized.meta?.vin || null
  };
}

function addTelemetryRecordsFromNormalized(data, snapshot) {
  const records = [];
  const toRecord = (identifier, value, unit) => {
    if (value === null || value === undefined) return;
    records.push(
      normalizeTelemetryRecord({
        org_id: snapshot.orgId || "",
        vehicle_id: snapshot.vehicleId || "",
        timestamp: snapshot.ts,
        protocol: snapshot.sourceProtocol || "derived",
        identifier,
        name: identifier,
        raw_value: value,
        normalized_value: value,
        unit,
        source: "ecu",
        validity: "ok"
      })
    );
  };
  if (snapshot.coolantTemp != null) toRecord("coolant_temp", cToF(snapshot.coolantTemp), "F");
  if (snapshot.batteryVoltage != null) toRecord("battery_v", snapshot.batteryVoltage, "V");
  if (snapshot.engineLoad != null) toRecord("engine_load", snapshot.engineLoad, "%");
  if (snapshot.maf != null) toRecord("maf", snapshot.maf, "g/s");
  if (snapshot.rpm != null) toRecord("rpm", snapshot.rpm, "rpm");
  if (snapshot.speedKph != null) toRecord("speed_mph", kphToMph(snapshot.speedKph), "mph");
  if (snapshot.fuelLevelPct != null) toRecord("fuel_level", snapshot.fuelLevelPct, "%");
  if (snapshot.odometerMiles != null) toRecord("mileage", snapshot.odometerMiles, "mi");
  if (snapshot.engineHours != null) toRecord("engine_hours", snapshot.engineHours, "h");
  storeTelemetryRecords(data, records);
}

function detectFuelEvent(data, snapshot) {
  if (snapshot.fuelLevelPct == null) return;
  const now = new Date(snapshot.ts).getTime();
  const candidates = (data.telemetrySnapshots || []).filter((snap) => {
    if (snap.vehicleId !== snapshot.vehicleId) return false;
    const ts = parseRecordTimestamp(snap.ts);
    return ts && now - ts <= 20 * 60000;
  });
  if (candidates.length < 2) return;
  const sorted = candidates.sort((a, b) => new Date(a.ts) - new Date(b.ts));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (first.fuelLevelPct == null || last.fuelLevelPct == null) return;
  const delta = last.fuelLevelPct - first.fuelLevelPct;
  const elapsedMin = (new Date(last.ts) - new Date(first.ts)) / 60000;
  const rpm = last.rpm ?? 0;
  const speedKph = last.speedKph ?? 0;
  const stationary = (rpm === 0 || rpm <= 100) && speedKph <= 1;
  if (!stationary) return;
  const qualifies =
    (delta >= 8 && elapsedMin <= 20) ||
    (delta >= 4 && elapsedMin <= 10);
  if (!qualifies) return;
  data.fuelEvents = Array.isArray(data.fuelEvents) ? data.fuelEvents : [];
  const recent = data.fuelEvents.find(
    (evt) =>
      evt.vehicleId === snapshot.vehicleId &&
      Math.abs(new Date(evt.endTs).getTime() - new Date(last.ts).getTime()) < 30 * 60000
  );
  if (recent) return;
  data.fuelEvents.unshift({
    id: makeId("FUEL"),
    orgId: snapshot.orgId || null,
    vehicleId: snapshot.vehicleId,
    tsStart: first.ts,
    tsEnd: last.ts,
    startTs: first.ts,
    endTs: last.ts,
    detectedBy: "AUTO",
    fuelLevelBefore: first.fuelLevelPct,
    fuelLevelAfter: last.fuelLevelPct,
    gallonsEstimated: null,
    location: null,
    confidence: delta >= 8 ? 0.8 : 0.6,
    note: "Detected likely refuel based on fuel level increase while stationary.",
    deltaFuelPct: Math.round(delta * 10) / 10,
    status: "suggested"
  });
  if (data.fuelEvents.length > 1000) {
    data.fuelEvents = data.fuelEvents.slice(0, 1000);
  }
}

function storeNormalizedSnapshot(data, normalized, extra) {
  const snapshot = buildSnapshotFromNormalized(normalized, extra);
  appendSnapshot(data, snapshot);
  addTelemetryRecordsFromNormalized(data, snapshot);
  detectFuelEvent(data, snapshot);
  try {
    const sample = ml.buildTelemetrySample(normalized, extra);
    if (sample.vehicleId) {
      ml.appendTelemetrySample(data, sample, TELEMETRY_RETENTION_LIMIT);
      ml.detectFuelEventsFromSamples(data, sample.vehicleId);
    }
  } catch (err) {
    // Best-effort; do not block telemetry ingest.
  }
  return snapshot;
}

function parseRecordTimestamp(value) {
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) ? ts : null;
}

function computeWindowStats(records, identifiers, startMs, endMs, threshold) {
  const values = [];
  let overCount = 0;
  for (const rec of records) {
    if (!identifiers.includes(rec.identifier)) continue;
    const ts = parseRecordTimestamp(rec.timestamp);
    if (!ts || ts < startMs || ts >= endMs) continue;
    const val = coerceNumber(rec.normalized_value ?? rec.raw_value);
    if (val === null) continue;
    values.push(val);
    if (threshold !== null && val >= threshold) {
      overCount += 1;
    }
  }
  const count = values.length;
  if (!count) {
    return { count: 0, avg: null, min: null, max: null, overPct: 0 };
  }
  const sum = values.reduce((a, b) => a + b, 0);
  return {
    count,
    avg: sum / count,
    min: Math.min(...values),
    max: Math.max(...values),
    overPct: threshold !== null ? overCount / count : 0
  };
}

function buildAggregateSnapshot(records, identifiers, now, threshold) {
  const dayMs = 24 * 60 * 60 * 1000;
  const monthMs = 30 * 24 * 60 * 60 * 1000;
  const last24 = computeWindowStats(records, identifiers, now - dayMs, now, threshold);
  const prev24 = computeWindowStats(records, identifiers, now - 2 * dayMs, now - dayMs, threshold);
  const last30 = computeWindowStats(records, identifiers, now - monthMs, now, threshold);
  const prev30 = computeWindowStats(records, identifiers, now - 2 * monthMs, now - monthMs, threshold);
  return {
    last24,
    prev24,
    last30,
    prev30,
    delta24: (last24.avg ?? 0) - (prev24.avg ?? 0),
    delta30: (last30.avg ?? 0) - (prev30.avg ?? 0)
  };
}

function computeBaselinesForVehicle(data, vehicleId) {
  const baselines = [];
  const now = Date.now();
  BASELINE_METRICS.forEach((metricKey) => {
    BASELINE_WINDOWS_DAYS.forEach((windowDays) => {
      const start = now - windowDays * 86400000;
      const snaps = getSnapshotsInWindow(data, vehicleId, start, now);
      const samples = getSamplesForMetric(snaps, metricKey);
      const stats = computeStats(samples.map((s) => s.value));
      const minSamples = BASELINE_MIN_SAMPLES[windowDays] || 0;
      baselines.push({
        id: makeId("BASE"),
        orgId: resolveOrgIdForVehicle(data, vehicleId),
        vehicleId,
        metricKey,
        windowDays,
        mean: stats.count >= minSamples ? stats.mean : null,
        stdDev: stats.count >= minSamples ? stats.stdDev : null,
        min: stats.count >= minSamples ? stats.min : null,
        max: stats.count >= minSamples ? stats.max : null,
        p10: stats.count >= minSamples ? stats.p10 : null,
        p50: stats.count >= minSamples ? stats.p50 : null,
        p90: stats.count >= minSamples ? stats.p90 : null,
        sampleCount: stats.count,
        lastComputedAt: nowIso()
      });
    });
  });
  return baselines;
}

function upsertBaselines(data, vehicleId, baselines) {
  data.baselines = Array.isArray(data.baselines) ? data.baselines : [];
  data.baselines = data.baselines.filter((b) => b.vehicleId !== vehicleId);
  data.baselines.push(...baselines);
}

function findBaseline(data, vehicleId, metricKey, windowDays) {
  return (data.baselines || []).find(
    (b) => b.vehicleId === vehicleId && b.metricKey === metricKey && b.windowDays === windowDays
  );
}

function computeDtcStats(data, vehicleId, windowDays) {
  const now = Date.now();
  const start = now - windowDays * 86400000;
  const priorStart = now - windowDays * 2 * 86400000;
  const priorEnd = now - windowDays * 86400000;
  const current = {};
  const previous = {};
  (data.telemetrySnapshots || []).forEach((snap) => {
    if (snap.vehicleId !== vehicleId) return;
    const ts = parseRecordTimestamp(snap.ts);
    if (!ts) return;
    const codes = Array.isArray(snap.dtcCodes) ? snap.dtcCodes : [];
    if (ts >= start && ts <= now) {
      codes.forEach((code) => {
        current[code] = (current[code] || 0) + 1;
      });
    } else if (ts >= priorStart && ts < priorEnd) {
      codes.forEach((code) => {
        previous[code] = (previous[code] || 0) + 1;
      });
    }
  });
  return { current, previous };
}

function dtcSeverity(code) {
  if (!code) return "warning";
  if (/^P0/.test(code)) return "critical";
  if (/^U0/.test(code)) return "critical";
  return "warning";
}

function buildServiceWindow(data, vehicleId, baseDays) {
  const snaps = (data.telemetrySnapshots || []).filter((s) => s.vehicleId === vehicleId);
  const odometerSamples = snaps
    .filter((s) => s.odometerMiles != null)
    .map((s) => ({ ts: s.ts, value: s.odometerMiles }));
  const engineSamples = snaps
    .filter((s) => s.engineHours != null)
    .map((s) => ({ ts: s.ts, value: s.engineHours }));
  const milesPerDay = estimateRatePerDay(odometerSamples);
  const hoursPerDay = estimateRatePerDay(engineSamples);
  const windows = [{ type: "days", value: baseDays }];
  if (milesPerDay != null && milesPerDay > 0) {
    windows.push({ type: "miles", value: Math.round(milesPerDay * baseDays) });
  }
  if (hoursPerDay != null && hoursPerDay > 0) {
    windows.push({ type: "engineHours", value: Math.round(hoursPerDay * baseDays) });
  }
  return windows;
}

function upsertTrendSignal(data, signal) {
  data.trendSignals = Array.isArray(data.trendSignals) ? data.trendSignals : [];
  const windowMs = 7 * 86400000;
  const existing = data.trendSignals.find(
    (s) =>
      s.vehicleId === signal.vehicleId &&
      s.ruleId === signal.ruleId &&
      s.status === "open" &&
      Date.now() - new Date(s.createdAt).getTime() < windowMs
  );
  if (existing) {
    Object.assign(existing, signal, { id: existing.id, createdAt: existing.createdAt });
    return existing;
  }
  data.trendSignals.unshift(signal);
  if (data.trendSignals.length > 2000) {
    data.trendSignals = data.trendSignals.slice(0, 2000);
  }
  return signal;
}

function upsertRecommendation(data, recommendation) {
  data.recommendations = Array.isArray(data.recommendations) ? data.recommendations : [];
  const existing = data.recommendations.find(
    (r) =>
      r.vehicleId === recommendation.vehicleId &&
      r.title === recommendation.title &&
      r.status === "open"
  );
  if (existing) {
    Object.assign(existing, recommendation, { id: existing.id, createdAt: existing.createdAt });
    return existing;
  }
  data.recommendations.unshift(recommendation);
  if (data.recommendations.length > 2000) {
    data.recommendations = data.recommendations.slice(0, 2000);
  }
  return recommendation;
}

function updatePatternSignature(data, vehicleId, maintenanceType, preWindowDays, occurredAt) {
  const end = occurredAt ? new Date(occurredAt).getTime() : Date.now();
  const start = end - preWindowDays * 86400000;
  const snaps = getSnapshotsInWindow(data, vehicleId, start, end);
  if (!snaps.length) return;
  const dtcCount = snaps.reduce((acc, snap) => acc + (snap.dtcCodes || []).length, 0);
  const alertCount = (data.events || []).filter(
    (evt) =>
      evt.vehicle_id === vehicleId &&
      parseRecordTimestamp(evt.detected_at) >= start &&
      parseRecordTimestamp(evt.detected_at) <= end
  ).length;
  BASELINE_METRICS.forEach((metricKey) => {
    const samples = getSamplesForMetric(snaps, metricKey);
    if (!samples.length) return;
    const stats = computeStats(samples.map((s) => s.value));
    const slope = computeSlopePerDay(samples) || 0;
    const signature = {
      mean: stats.mean,
      std: stats.stdDev,
      min: stats.min,
      max: stats.max,
      slope,
      dtcFrequency: dtcCount / preWindowDays,
      alertFrequency: alertCount / preWindowDays
    };
    data.patternSignatures = Array.isArray(data.patternSignatures) ? data.patternSignatures : [];
    const existing = data.patternSignatures.find(
      (sig) =>
        sig.vehicleId === vehicleId &&
        sig.maintenanceType === maintenanceType &&
        sig.metricKey === metricKey &&
        sig.preWindowDays === preWindowDays
    );
    if (!existing) {
      data.patternSignatures.unshift({
        id: makeId("SIG"),
        orgId: resolveOrgIdForVehicle(data, vehicleId),
        vehicleId,
        maintenanceType,
        preWindowDays,
        metricKey,
        signature,
        observedCount: 1,
        lastUpdatedAt: nowIso()
      });
      return;
    }
    const count = existing.observedCount || 1;
    const weight = count + 1;
    const avg = (a, b) => (a * count + b) / weight;
    existing.signature = {
      mean: avg(existing.signature.mean || 0, signature.mean || 0),
      std: avg(existing.signature.std || 0, signature.std || 0),
      min: Math.min(existing.signature.min ?? signature.min, signature.min ?? existing.signature.min),
      max: Math.max(existing.signature.max ?? signature.max, signature.max ?? existing.signature.max),
      slope: avg(existing.signature.slope || 0, signature.slope || 0),
      dtcFrequency: avg(existing.signature.dtcFrequency || 0, signature.dtcFrequency || 0),
      alertFrequency: avg(existing.signature.alertFrequency || 0, signature.alertFrequency || 0)
    };
    existing.observedCount = weight;
    existing.lastUpdatedAt = nowIso();
  });
}

function severityRank(sev) {
  return sev === "critical" ? 3 : sev === "warn" ? 2 : sev === "info" ? 1 : 0;
}

function formatEventTitle(type) {
  const map = {
    COOLING_TREND_ANOMALY: "Cooling Trend Anomaly",
    BATTERY_CHARGING_ANOMALY: "Charging System Anomaly",
    FUEL_EFFICIENCY_OR_COMBUSTION_ANOMALY: "Fuel Efficiency / Combustion Anomaly"
  };
  return map[type] || "Maintenance Alert";
}

function buildFallbackExplanation(event) {
  const title = formatEventTitle(event.type);
  const summary = `Detected a ${event.type.replace(/_/g, " ").toLowerCase()} based on recent telemetry trends.`;
  const recommended_actions = [
    "Review recent maintenance history and active DTCs for the unit.",
    "Inspect related components during the next service window.",
    "Monitor telemetry for continued deviation over the next 24 hours."
  ];
  const safety_note = "Findings are probabilistic; confirm with on-vehicle inspection before action.";
  return {
    title,
    summary,
    recommended_actions,
    safety_note,
    explanation_source: "fallback"
  };
}

function generateDigits(length) {
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += Math.floor(Math.random() * 10);
  }
  return out;
}

function generateTempPassword() {
  return crypto.randomBytes(8).toString("hex");
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

function safeParseJson(text) {
  if (!text) return null;
  const cleaned = String(text).trim().replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    return null;
  }
}

async function generateEventExplanation(event, context) {
  if (!OPENAI_EXPLANATIONS_ENABLED || !aiEnabled()) {
    return buildFallbackExplanation(event);
  }
  const vehicle = context?.vehicle || {};
  const prompt = {
    model: OPENAI_MODEL,
    messages: [
      {
        role: "system",
        content: [
          "You are a fleet maintenance analyst.",
          "Explain alerts clearly using probabilistic language.",
          "Respond in JSON with keys: title, summary, recommended_actions, safety_note.",
          "recommended_actions must be an array of short action strings.",
          "Never claim certainty."
        ].join(" ")
      },
      {
        role: "user",
        content: JSON.stringify({
          event: {
            type: event.type,
            severity: event.severity,
            metrics_snapshot: event.metrics_snapshot || {}
          },
          vehicle: {
            vehicleId: vehicle.vehicleId || vehicle.id || "",
            vin: vehicle.vin || "",
            unitName: vehicle.unitName || ""
          },
          dtcs: context?.dtcs || []
        })
      }
    ],
    temperature: 0.3,
    max_tokens: 400
  };
  try {
    const response = await postJson("https://api.openai.com/v1/chat/completions", prompt, {
      Authorization: `Bearer ${OPENAI_API_KEY}`
    });
    if (response.status >= 200 && response.status < 300) {
      const parsed = JSON.parse(response.body || "{}");
      const content = parsed?.choices?.[0]?.message?.content;
      const json = safeParseJson(content);
      if (json && json.title && json.summary) {
        return {
          title: sanitizeString(json.title, 200),
          summary: sanitizeString(json.summary, 1000),
          recommended_actions: Array.isArray(json.recommended_actions)
            ? json.recommended_actions.map((a) => sanitizeString(a, 200)).filter(Boolean)
            : [],
          safety_note: sanitizeString(json.safety_note || "", 400),
          explanation_source: "openai"
        };
      }
    }
  } catch (err) {
  }
  return buildFallbackExplanation(event);
}

function shouldRenotify(event) {
  if (!event.last_notified_at) return true;
  const last = new Date(event.last_notified_at).getTime();
  if (!Number.isFinite(last)) return true;
  return Date.now() - last >= ALERT_RENOTIFY_HOURS * 60 * 60 * 1000;
}

function createNotificationsForEvent(data, event) {
  data.notifications = Array.isArray(data.notifications) ? data.notifications : [];
  const title = formatEventTitle(event.type);
  const body = event.explanation || "Anomaly detected. Review recent telemetry and maintenance history.";
  const base = {
    org_id: event.org_id,
    vehicle_id: event.vehicle_id,
    event_id: event.id,
    title,
    body,
    severity: event.severity,
    status: "unread",
    created_at: nowIso()
  };

  data.notifications.unshift({
    id: makeId("NOTIF"),
    recipient_type: "fleet_manager",
    recipient_id: event.org_id,
    ...base
  });

  const pairing = (data.pairings || []).find(
    (p) => p.vehicleId === event.vehicle_id && p.status === "active"
  );
  if (pairing?.driverId) {
    data.notifications.unshift({
      id: makeId("NOTIF"),
      recipient_type: "driver",
      recipient_id: pairing.driverId,
      ...base
    });
  }

  if (data.notifications.length > 5000) {
    data.notifications = data.notifications.slice(0, 5000);
  }
}

async function upsertEvent(data, candidate) {
  data.events = Array.isArray(data.events) ? data.events : [];
  const dedupeKey = `${candidate.type}:${candidate.org_id}:${candidate.vehicle_id}`;
  const now = Date.now();
  const dedupeWindowMs = ALERT_DEDUPE_WINDOW_HOURS * 60 * 60 * 1000;
  const existing = data.events.find(
    (e) => e.dedupe_key === dedupeKey && e.status !== "resolved"
  );

  if (existing) {
    const lastDetected = new Date(existing.detected_at).getTime();
    if (Number.isFinite(lastDetected) && now - lastDetected <= dedupeWindowMs) {
      const prevSeverity = existing.severity || "info";
      const severityUp = severityRank(candidate.severity) > severityRank(prevSeverity);
      existing.severity = candidate.severity;
      existing.metrics_snapshot = candidate.metrics_snapshot || existing.metrics_snapshot;
      existing.updated_at = nowIso();
      if (severityUp || shouldRenotify(existing)) {
        existing.last_notified_at = nowIso();
        createNotificationsForEvent(data, existing);
      }
      if (!existing.explanation || severityUp) {
        const explanation = await generateEventExplanation(existing, candidate.context || {});
        existing.explanation = explanation.summary;
        existing.recommended_actions = explanation.recommended_actions || [];
        existing.explanation_source = explanation.explanation_source || "fallback";
      }
      return existing;
    }
  }

  const created = {
    id: makeId("EVT"),
    org_id: candidate.org_id,
    vehicle_id: candidate.vehicle_id,
    type: candidate.type,
    severity: candidate.severity,
    status: "open",
    detected_at: nowIso(),
    created_at: nowIso(),
    updated_at: nowIso(),
    metrics_snapshot: candidate.metrics_snapshot || {},
    dedupe_key: dedupeKey,
    last_notified_at: nowIso(),
    explanation: "",
    recommended_actions: [],
    explanation_source: "fallback"
  };

  const explanation = await generateEventExplanation(created, candidate.context || {});
  created.explanation = explanation.summary;
  created.recommended_actions = explanation.recommended_actions || [];
  created.explanation_source = explanation.explanation_source || "fallback";
  data.events.unshift(created);
  createNotificationsForEvent(data, created);
  if (data.events.length > 2000) {
    data.events = data.events.slice(0, 2000);
  }
  return created;
}

function buildMetricsSnapshot(label, agg) {
  return {
    metric: label,
    avg_last_period: agg.last24.avg,
    avg_prev_period: agg.prev24.avg,
    delta_avg: agg.delta24,
    percent_time_over_threshold_last: agg.last24.overPct,
    percent_time_over_threshold_prev: agg.prev24.overPct,
    sample_count: agg.last24.count,
    avg_last_30d: agg.last30.avg,
    avg_prev_30d: agg.prev30.avg,
    delta_avg_30d: agg.delta30,
    sample_count_30d: agg.last30.count
  };
}

async function runTelemetryPipeline() {
  if (!ALERTS_ENABLED) return;
  if (telemetryPipelineRunning) return;
  telemetryPipelineRunning = true;
  try {
    const data = await readData();
    const vehicles = (data.vehicles || []).map((v) => v.vehicleId);
    const now = Date.now();

    for (const vehicleId of vehicles) {
      const records = getTelemetryRecordsForVehicle(data, vehicleId);
      if (!records.length) continue;

      const orgId = resolveOrgIdForVehicle(data, vehicleId);
      const coolantAgg = buildAggregateSnapshot(records, TELEMETRY_ALIASES.coolant, now, COOLANT_OVERHEAT_THRESHOLD);
      const batteryAgg = buildAggregateSnapshot(records, TELEMETRY_ALIASES.battery, now, null);
      const fuelAgg = buildAggregateSnapshot(records, TELEMETRY_ALIASES.fuelEff, now, null);

      const aggregateEntry = {
        id: makeId("AGG"),
        org_id: orgId,
        vehicle_id: vehicleId,
        computed_at: nowIso(),
        avg_coolant_temp_last_period: coolantAgg.last24.avg,
        avg_coolant_temp_prev_period: coolantAgg.prev24.avg,
        delta_avg_coolant_temp: coolantAgg.delta24,
        percent_time_over_threshold_last: coolantAgg.last24.overPct,
        percent_time_over_threshold_prev: coolantAgg.prev24.overPct,
        sample_count: coolantAgg.last24.count,
        avg_coolant_temp_last_30d: coolantAgg.last30.avg,
        avg_coolant_temp_prev_30d: coolantAgg.prev30.avg,
        delta_avg_coolant_temp_30d: coolantAgg.delta30,
        sample_count_30d: coolantAgg.last30.count
      };
      data.telemetryAggregates = (data.telemetryAggregates || []).filter(
        (agg) => agg.vehicle_id !== vehicleId
      );
      data.telemetryAggregates.unshift(aggregateEntry);

      if (coolantAgg.last24.count >= 6) {
        let severity = null;
        if (coolantAgg.last24.avg !== null && coolantAgg.last24.avg >= COOLANT_OVERHEAT_THRESHOLD + 10) {
          severity = "critical";
        } else if (coolantAgg.delta24 >= COOLANT_DELTA_CRIT || coolantAgg.last24.overPct >= 0.2) {
          severity = "critical";
        } else if (coolantAgg.delta24 >= COOLANT_DELTA_WARN || coolantAgg.last24.overPct >= 0.1) {
          severity = "warn";
        }
        if (severity) {
          await upsertEvent(data, {
            org_id: orgId,
            vehicle_id: vehicleId,
            type: "COOLING_TREND_ANOMALY",
            severity,
            metrics_snapshot: buildMetricsSnapshot("coolant_temp", coolantAgg),
            context: { vehicle: (data.vehicles || []).find((v) => v.vehicleId === vehicleId) }
          });
        }
      }

      if (batteryAgg.last24.count >= 6) {
        let severity = null;
        if (batteryAgg.last24.avg !== null && batteryAgg.last24.avg <= BATTERY_VOLT_CRIT) {
          severity = "critical";
        } else if (batteryAgg.delta24 <= BATTERY_DELTA_CRIT) {
          severity = "critical";
        } else if (batteryAgg.last24.avg !== null && batteryAgg.last24.avg <= BATTERY_VOLT_WARN) {
          severity = "warn";
        } else if (batteryAgg.delta24 <= BATTERY_DELTA_WARN) {
          severity = "warn";
        }
        if (severity) {
          await upsertEvent(data, {
            org_id: orgId,
            vehicle_id: vehicleId,
            type: "BATTERY_CHARGING_ANOMALY",
            severity,
            metrics_snapshot: buildMetricsSnapshot("battery_voltage", batteryAgg),
            context: { vehicle: (data.vehicles || []).find((v) => v.vehicleId === vehicleId) }
          });
        }
      }

      if (fuelAgg.last24.count >= 6 && fuelAgg.prev24.avg) {
        const drop = 1 - (fuelAgg.last24.avg / fuelAgg.prev24.avg);
        let severity = null;
        if (drop >= FUEL_EFF_DROP_CRIT) severity = "critical";
        else if (drop >= FUEL_EFF_DROP_WARN) severity = "warn";
        if (severity) {
          await upsertEvent(data, {
            org_id: orgId,
            vehicle_id: vehicleId,
            type: "FUEL_EFFICIENCY_OR_COMBUSTION_ANOMALY",
            severity,
            metrics_snapshot: buildMetricsSnapshot("fuel_efficiency", fuelAgg),
            context: { vehicle: (data.vehicles || []).find((v) => v.vehicleId === vehicleId) }
          });
        }
      }
    }

    await writeData(data);
  } finally {
    telemetryPipelineRunning = false;
  }
}

let telemetryPipelineRunning = false;
let telemetryPipelinePending = false;
function triggerTelemetryPipeline() {
  if (telemetryPipelinePending) return;
  telemetryPipelinePending = true;
  setTimeout(() => {
    telemetryPipelinePending = false;
    runTelemetryPipeline().catch(() => {});
  }, 1200);
}

let baselineJobRunning = false;
let patternJobRunning = false;
let lastBaselineRun = 0;
let telemetrySnapshotCounter = 0;

async function runBaselineJob(force) {
  if (baselineJobRunning) return;
  if (!force && Date.now() - lastBaselineRun < 6 * 60 * 60 * 1000) return;
  baselineJobRunning = true;
  try {
    const data = await readData();
    const vehicles = (data.vehicles || []).map((v) => v.vehicleId);
    vehicles.forEach((vehicleId) => {
      const baselines = computeBaselinesForVehicle(data, vehicleId);
      upsertBaselines(data, vehicleId, baselines);
    });
    await writeData(data);
    lastBaselineRun = Date.now();
    console.log(`[pattern-engine] baselines updated for ${vehicles.length} vehicles`);
  } finally {
    baselineJobRunning = false;
  }
}

async function runPatternDetection(force) {
  if (patternJobRunning) return;
  patternJobRunning = true;
  try {
    const data = await readData();
    const vehicles = (data.vehicles || []).map((v) => v.vehicleId);
    const now = Date.now();
    for (const vehicleId of vehicles) {
      const orgId = resolveOrgIdForVehicle(data, vehicleId);
      for (const rule of PREDICTIVE_RULES) {
        if (rule.metricKey === "dtcCodes") {
          const { current, previous } = computeDtcStats(data, vehicleId, rule.windowDays);
          const dtcCodes = Object.keys(current);
          if (!dtcCodes.length) continue;
          const repeats = dtcCodes.filter((code) => current[code] >= 3);
          const newCodes = dtcCodes.filter((code) => !previous[code]);
          if (!repeats.length && !newCodes.length) continue;
          const code = repeats[0] || newCodes[0];
          const severity = dtcSeverity(code);
          const serviceWindows = buildServiceWindow(data, vehicleId, rule.serviceWindowDays[severity] || 7);
          const signal = {
            id: makeId("SIG"),
            orgId,
            vehicleId,
            metricKey: "dtcCodes",
            startTs: new Date(now - rule.windowDays * 86400000).toISOString(),
            endTs: new Date().toISOString(),
            slopePerDay: null,
            delta: null,
            baselineMean: null,
            baselineStdDev: null,
            zScore: null,
            ruleId: rule.id,
            severity,
            confidence: 0.6,
            recommendedAction: rule.recommendedAction,
            serviceWindow: serviceWindows,
            createdAt: nowIso(),
            status: "open",
            details: {
              dtcCodes: dtcCodes,
              newCodes,
              repeatCodes: repeats
            }
          };
          upsertTrendSignal(data, signal);
          upsertRecommendation(data, {
            id: makeId("REC"),
            orgId,
            vehicleId,
            title: `DTC recurrence detected (${code})`,
            summary: "Diagnostic trouble codes have appeared multiple times recently.",
            rationale: signal.details,
            severity,
            confidence: signal.confidence,
            serviceWindow: serviceWindows,
            createdAt: nowIso(),
            status: "open"
          });
          continue;
        }

        const baseline = findBaseline(data, vehicleId, rule.metricKey, 14);
        if (!baseline || baseline.mean == null) continue;
        const windowStart = now - rule.windowDays * 86400000;
        const snaps = getSnapshotsInWindow(data, vehicleId, windowStart, now);
        const samples = getSamplesForMetric(snaps, rule.metricKey);
        if (!samples.length) continue;
        const stats = computeStats(samples.map((s) => s.value));
        const slopePerDay = computeSlopePerDay(samples) || 0;
        const delta = stats.mean != null && baseline.mean != null ? stats.mean - baseline.mean : null;
        const zScore =
          stats.mean != null && baseline.stdDev ? (stats.mean - baseline.mean) / baseline.stdDev : null;
        const severity = rule.severity({
          mean: stats.mean,
          baselineMean: baseline.mean,
          baselineStdDev: baseline.stdDev || 0,
          baselineP90: baseline.p90,
          slopePerDay
        });
        if (!severity) continue;
        const serviceWindows = buildServiceWindow(data, vehicleId, rule.serviceWindowDays[severity] || 7);
        let confidence = baseline.sampleCount >= BASELINE_MIN_SAMPLES[14] ? 0.7 : 0.5;
        const signatures = (data.patternSignatures || []).filter(
          (sig) => sig.vehicleId === vehicleId && sig.metricKey === rule.metricKey && sig.observedCount >= 2
        );
        let rationaleNote = null;
        if (signatures.length) {
          confidence = Math.min(0.95, confidence + 0.15);
          rationaleNote = "This trend has preceded maintenance events in your history.";
        }
        const signal = {
          id: makeId("SIG"),
          orgId,
          vehicleId,
          metricKey: rule.metricKey,
          startTs: new Date(windowStart).toISOString(),
          endTs: new Date().toISOString(),
          slopePerDay,
          delta,
          baselineMean: baseline.mean,
          baselineStdDev: baseline.stdDev,
          zScore,
          ruleId: rule.id,
          severity,
          confidence,
          recommendedAction: rule.recommendedAction,
          serviceWindow: serviceWindows,
          createdAt: nowIso(),
          status: "open",
          details: { rationaleNote }
        };
        upsertTrendSignal(data, signal);
        upsertRecommendation(data, {
          id: makeId("REC"),
          orgId,
          vehicleId,
          title: `${rule.id.replace(/_/g, " ")} recommendation`,
          summary: rule.recommendedAction,
          rationale: {
            delta,
            baselineMean: baseline.mean,
            slopePerDay,
            zScore,
            rationaleNote
          },
          severity,
          confidence,
          serviceWindow: serviceWindows,
          createdAt: nowIso(),
          status: "open"
        });
      }
    }
    await writeData(data);
    if (force) {
      console.log("[pattern-engine] recompute completed");
    }
  } finally {
    patternJobRunning = false;
  }
}

function startTelemetryScheduler() {
  if (!ALERTS_ENABLED) return;
  setInterval(() => {
    runTelemetryPipeline().catch(() => {});
  }, ALERTS_AGGREGATION_INTERVAL_MS);
  setInterval(() => {
    runBaselineJob().catch(() => {});
  }, 6 * 60 * 60 * 1000);
  setInterval(() => {
    runPatternDetection().catch(() => {});
  }, 15 * 60 * 1000);
}


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

function defaultBillingSettings(data) {
  const price = data.settings?.defaultPilotPrice ?? 59;
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
  const { name, industry, fleetSize, status, notes, primaryContactName, primaryContactEmail, phone, billingPlan, activeVehicles } = req.body || {};
  if (!name) {
    return res.status(400).json({ error: "Org name required" });
  }
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

app.get("/api/leads/public-status", (req, res) => {
  res.json({ ok: true });
});

async function handleCreateLead(req, res, next, leadTypeOverride, sourceOverride) {
  const ipKey = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "local";
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

app.post("/api/leads", (req, res, next) => handleCreateLead(req, res, next));
app.post("/api/leads/request-demo", (req, res, next) => handleCreateLead(req, res, next, "DEMO", "request-demo"));
app.post("/api/leads/pilot-apply", (req, res, next) => handleCreateLead(req, res, next, "PILOT", "pilot"));
app.post("/api/leads/apply-pilot", (req, res, next) => handleCreateLead(req, res, next, "PILOT", "pilot"));

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
      return sum + vehicles * 59;
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
    const includeDeleted = req.query.includeDeleted === "1" || req.query.includeDeleted === "true";
    const orgs = (data.orgs || [])
      .filter((org) => {
        if (includeDeleted) return true;
        return String(org.status || "").toUpperCase() !== "DELETED" && !org.deletedAt;
      })
      .map((org) => {
      const orgId = org.orgId || org.id || makeId("ORG");
      return Object.assign({}, org, {
        id: org.id || orgId,
        orgId,
        status: normalizeOrgStatus(org.status || "LEAD"),
        billingPlan: org.billingPlan || "PILOT_CORE",
        activeVehicles: Number.isFinite(Number(org.activeVehicles)) ? Number(org.activeVehicles) : 0,
        fleetSizeEstimate: Number.isFinite(Number(org.fleetSizeEstimate)) ? Number(org.fleetSizeEstimate) : 0
      });
    });
    orgs.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    res.json({ ok: true, data: orgs });
  } catch (err) {
    next(err);
  }
});

app.post("/api/orgs", requireEmployeeApi, requireRole(["SUPER_ADMIN"]), async (req, res, next) => {
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
    await writeData(data);
    res.status(201).json({ ok: true, data: org });
  } catch (err) {
    next(err);
  }
});

app.get("/api/orgs/:orgId", requireEmployeeApi, async (req, res, next) => {
  try {
    const data = await readData();
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
    const lead = (data.leads || []).find((l) => (l.leadId || l.id) === req.params.leadId || l.id === req.params.leadId);
    if (!lead) return res.status(404).json({ error: "Lead not found" });
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
    await writeData(data);
    res.json({ ok: true, data: { lead, org } });
  } catch (err) {
    next(err);
  }
});

app.get("/api/employees", requireEmployeeApi, async (req, res, next) => {
  try {
    const data = await readData();
    const roles = ["SUPER_ADMIN", "ADMIN", "SUPPORT", "SALES"];
    const employees = (data.users || []).filter((u) => roles.includes(u.role));
    res.json({ ok: true, data: employees });
  } catch (err) {
    next(err);
  }
});

app.post("/api/employees", requireEmployeeApi, requireRole(["SUPER_ADMIN"]), async (req, res, next) => {
  const { email, role } = req.body || {};
  const roles = ["SUPER_ADMIN", "ADMIN", "SUPPORT", "SALES"];
  const cleanEmail = normalizeEmail(email);
  if (!cleanEmail || !role || !roles.includes(role)) {
    return res.status(400).json({ error: "Valid email and role required." });
  }
  try {
    const data = await readData();
    const exists = (data.users || []).some((u) => u.email === cleanEmail);
    if (exists) return res.status(409).json({ error: "User already exists" });
    const tempPassword = generateTempPassword();
    const passwordHash = await bcrypt.hash(tempPassword, 12);
    const user = {
      id: makeId("USR"),
      email: cleanEmail,
      role,
      orgId: null,
      isActive: true,
      mustResetPassword: true,
      createdAt: nowIso(),
      lastLoginAt: null,
      passwordHash
    };
    data.users.push(user);
    addAudit(data, "USER_CREATED", `${user.id}:${user.email}`);
    await writeData(data);
    res.status(201).json({ ok: true, data: { email: user.email, role: user.role, tempPassword } });
  } catch (err) {
    next(err);
  }
});

app.post("/api/orgs/:orgId/create-customer-login", requireEmployeeApi, requireRole(["SUPER_ADMIN"]), async (req, res, next) => {
  try {
    const rate = getRateState(`cust-create:${req.employee?.userId || req.employee?.email || "unknown"}`);
    if (!rate.allowed) return res.status(429).json({ error: "Too many requests. Try again later." });
    const data = await readData();
    const org = (data.orgs || []).find((o) => (o.orgId || o.id) === req.params.orgId || o.id === req.params.orgId);
    if (!org) return res.status(404).json({ error: "Org not found" });
    if (String(org.status || "").toUpperCase() === "DELETED") {
      return res.status(400).json({ error: "Org is deleted" });
    }
    const email = normalizeEmail(req.body?.email || org.primaryContactEmail);
    if (!email) return res.status(400).json({ error: "Valid email required" });
    const exists = (data.users || []).some((u) => u.email === email);
    if (exists) return res.status(409).json({ error: "User already exists" });
    const tempPassword = generateTempPassword();
    const passwordHash = await bcrypt.hash(tempPassword, 12);
    const user = {
      id: makeId("USR"),
      email,
      role: "ORG_ADMIN",
      orgId: org.orgId || org.id,
      displayName: sanitizeString(req.body?.contactName || org.primaryContactName || "", 200),
      status: "ACTIVE",
      isActive: true,
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
    data.users.push(user);
    addAudit(data, "CUSTOMER_LOGIN_CREATED", `${user.id}:${user.email}`);
    await writeData(data);
    res.status(201).json({ ok: true, data: { email: user.email, tempPassword } });
  } catch (err) {
    next(err);
  }
});

app.post("/api/orgs/:orgId/customer/create", requireEmployeeApi, requireRole(["SUPER_ADMIN"]), async (req, res, next) => {
  req.url = `/api/orgs/${req.params.orgId}/create-customer-login`;
  app.handle(req, res, next);
});

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
    const user = (data.users || []).find((u) => u.email === email && ["CUSTOMER_ADMIN", "ORG_ADMIN"].includes(u.role));
    if (!user) return res.status(404).json({ error: "Customer user not found" });
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
    user.lastLoginAt = null;
    addAudit(data, "CUSTOMER_PASSWORD_RESET", `${user.id}:${user.email}`);
    await writeData(data);
    res.json({ ok: true, data: { email: user.email, tempPassword } });
  } catch (err) {
    next(err);
  }
});

app.get("/api/invites", requireEmployeeApi, async (req, res, next) => {
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

app.get("/api/org/billing", async (req, res, next) => {
  try {
    const data = await readData();
    const billing = Object.assign({}, defaultBillingSettings(data), data.orgBillingSettings || {});
    res.json({ ok: true, data: billing });
  } catch (err) {
    next(err);
  }
});

app.post("/api/org/billing", async (req, res, next) => {
  try {
    const data = await readData();
    const current = Object.assign({}, defaultBillingSettings(data), data.orgBillingSettings || {});
    const updates = req.body || {};
    const allowedStatus = ["NONE", "PILOT", "ACTIVE"];
    if (updates.status && !allowedStatus.includes(updates.status)) {
      return res.status(400).json({ error: "Invalid billing status." });
    }
    const nextBilling = Object.assign({}, current, updates);
    nextBilling.plan = nextBilling.plan || "PILOT_CORE";
    nextBilling.priceMonthly = nextBilling.priceMonthly || data.settings?.defaultPilotPrice || 59;
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
    data.orgBillingSettings = nextBilling;
    addAudit(data, "ORG_BILLING_UPDATED", "org");
    await writeData(data);
    res.json({ ok: true, data: nextBilling });
  } catch (err) {
    next(err);
  }
});

app.get("/api/org/billing-settings", async (req, res, next) => {
  try {
    const data = await readData();
    const billing = Object.assign({}, defaultBillingSettings(data), data.orgBillingSettings || {});
    res.json({ ok: true, data: billing });
  } catch (err) {
    next(err);
  }
});

app.post("/api/org/billing-settings", async (req, res, next) => {
  try {
    const data = await readData();
    const current = Object.assign({}, defaultBillingSettings(data), data.orgBillingSettings || {});
    const updates = req.body || {};
    const allowedStatus = ["NONE", "PILOT", "ACTIVE"];
    if (updates.status && !allowedStatus.includes(updates.status)) {
      return res.status(400).json({ error: "Invalid billing status." });
    }
    const nextBilling = Object.assign({}, current, updates);
    nextBilling.plan = nextBilling.plan || "PILOT_CORE";
    nextBilling.priceMonthly = nextBilling.priceMonthly || data.settings?.defaultPilotPrice || 59;
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
    data.orgBillingSettings = nextBilling;
    addAudit(data, "ORG_BILLING_UPDATED", "org");
    await writeData(data);
    res.json({ ok: true, data: nextBilling });
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

app.get("/api/org/payment-method", async (req, res, next) => {
  try {
    const data = await readData();
    const payment = Object.assign({}, defaultPaymentMethod(), data.paymentMethod || {});
    res.json({ ok: true, data: payment });
  } catch (err) {
    next(err);
  }
});

app.post("/api/org/payment-method", async (req, res, next) => {
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
      data.paymentMethod = {
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
      data.paymentMethod = {
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
    addAudit(data, "PAYMENT_METHOD_UPDATED", "org");
    await writeData(data);
    res.json({ ok: true, data: data.paymentMethod });
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

async function handleCustomerLogin(req, res, next) {
  const { email, password } = req.body || {};
  authLog(`[REQ] ${req.method} ${req.path}`);
  authLog(`[AUTH-CUSTOMER] login attempt ${email || "unknown"}`);
  try {
    let data = await readData();
    const restored = await restoreUsersIfEmpty(data);
    data = restored.data;
    const boot = await ensureBootstrapCustomer(data);
    if (boot.created) {
      data = await readData();
    }
    const result = await authService.authenticate("customer", email, password);
    if (!result.ok) {
      if (
        !IS_PROD
        && DEV_SETUP
        && result.error.code === AUTH_ERRORS.INVALID_CREDENTIALS.code
        && password
        && password === DEV_SETUP_PASSWORD
      ) {
        const devLookup = await authService.getUserByEmail("customer", email);
        if (devLookup && devLookup.user) {
          const devSession = issueSession("customer", devLookup.user);
          setCustomerSessionCookie(res, devSession.id);
          return res.status(200).json({
            ok: true,
            code: "OK",
            message: "Authenticated",
            token: devSession.id,
            session: {
              token: devSession.id,
              expiresAt: devSession.expiresAt,
              user: {
                id: devLookup.user.id,
                email: devLookup.user.email,
                role: devLookup.user.role,
                orgId: devLookup.user.orgId || null,
                displayName: devLookup.user.displayName || ""
              }
            },
            user: {
              id: devLookup.user.id,
              email: devLookup.user.email,
              role: devLookup.user.role,
              orgId: devLookup.user.orgId || null,
              displayName: devLookup.user.displayName || ""
            }
          });
        }
      }
      if (result.error.code === AUTH_ERRORS.PASSWORD_SETUP_REQUIRED.code) {
        return res.status(result.error.status).json({
          ok: false,
          code: result.error.code,
          setupToken: result.next.token,
          email: authService.normalizeEmail(email),
          message: result.error.message
        });
      }
      return res.status(result.error.status).json({
        ok: false,
        code: result.error.code,
        message: result.error.message
      });
    }
    const session = result.session;
    setCustomerSessionCookie(res, session.id);
    return res.status(200).json({
      ok: true,
      code: "OK",
      message: "Authenticated",
      token: session.id,
      session: {
        token: session.id,
        expiresAt: session.expiresAt,
        user: { id: result.user.id, email: result.user.email, role: result.user.role, orgId: result.user.orgId || null, displayName: result.user.displayName || "" }
      },
      user: { id: result.user.id, email: result.user.email, role: result.user.role, orgId: result.user.orgId || null, displayName: result.user.displayName || "" }
    });
  } catch (err) {
    next(err);
  }
}

app.post("/api/auth/org/login", handleCustomerLogin);
app.post("/api/auth/customer/login", handleCustomerLogin);
app.post("/api/auth/login", handleCustomerLogin);
app.post("/api/auth/login-customer", handleCustomerLogin);
app.post("/api/customer/login", handleCustomerLogin);

app.get("/api/auth/customer/session", (req, res) => {
  const session = getCustomerSession(req);
  if (!session) {
    return res.status(401).json({ error: "Not authenticated." });
  }
  res.json({ ok: true, user: { id: session.userId, email: session.email, role: session.role, orgId: session.orgId } });
});

app.get("/api/auth/whoami", (req, res) => {
  const employee = getSessionFromRequest(req);
  if (employee && employee.session) {
    const session = employee.session;
    return res.json({
      ok: true,
      type: "employee",
      source: employee.source,
      user: { id: session.userId || null, email: session.email, role: session.role, orgId: session.orgId || null }
    });
  }
  const customer = getCustomerSession(req);
  if (customer) {
    return res.json({
      ok: true,
      type: "customer",
      source: "cookie",
      user: { id: customer.userId, email: customer.email, role: customer.role, orgId: customer.orgId || null }
    });
  }
  return res.status(401).json({ ok: false, error: "Not authenticated" });
});

app.get("/api/admin/config-status", requireSuperAdmin, (req, res) => {
  res.json({
    ok: true,
    data: {
      status: dataLoadStatus,
      lastError: dataLoadError,
      note: dataLoadNote,
      lastWriteAt: lastDataWriteAt
    },
    schemaVersion: DATA_SCHEMA_VERSION,
    dataPath: DATA_PATH
  });
});

app.get("/api/system/watchdog", (req, res) => {
  if (!watchdogInstance) {
    return res.json({ ok: false, error: "watchdog_not_started" });
  }
  return res.json({ ok: true, ...watchdogInstance.getState() });
});

app.get("/api/system/telemetry/status", (req, res) => {
  const lastTelemetryAt = telemetryLastSeen?.ts || telemetryState.lastSampleAt || null;
  const ageMs = lastTelemetryAt ? Date.now() - new Date(lastTelemetryAt).getTime() : null;
  res.json({
    ok: true,
    connectedDevicesCount: telemetryLatest.size,
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

app.get("/api/me", requireCustomerApi, (req, res) => {
  const session = req.customer;
  readData()
    .then((data) => {
      const user = (data.users || []).find((u) => u.id === session.userId);
      res.json({
        ok: true,
        user: {
          id: session.userId,
          email: session.email,
          role: session.role,
          orgId: session.orgId,
          displayName: session.displayName || "",
          passwordLastSetAt: user?.passwordLastSetAt || user?.lastPasswordChangeAt || null,
          mustSetPassword: Boolean(user?.mustSetPassword || user?.isTemporaryPassword)
        },
        resetRequired: Boolean(session.resetRequired),
        requirePasswordReset: Boolean(session.resetRequired),
        mustResetPassword: Boolean(session.resetRequired),
        mustSetPassword: Boolean(session.mustSetPassword)
      });
    })
    .catch((err) => {
      res.status(500).json({ error: "Failed to load profile." });
    });
});

app.post("/api/auth/reset-password", requireCustomerApi, async (req, res, next) => {
  const { newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 10) {
    return res.status(400).json({ error: "Password must be at least 10 characters." });
  }
  try {
    const data = await readData();
    const user = (data.users || []).find((u) => u.id === req.customer.userId);
    if (!user) return res.status(404).json({ error: "User not found" });
    if (!req.customer.resetRequired && !user.mustResetPassword && !user.requirePasswordReset) {
      return res.status(400).json({ error: "Password reset not required." });
    }
    user.passwordHash = await bcrypt.hash(String(newPassword), 12);
    user.mustResetPassword = false;
    user.requirePasswordReset = false;
    user.lastPasswordChangeAt = nowIso();
    user.passwordLastSetAt = nowIso();
    user.isTemporaryPassword = false;
    user.mustSetPassword = false;
    user.status = user.status || "ACTIVE";
    user.lastLoginAt = nowIso();
    await writeData(data);
    req.customer.resetRequired = false;
    const session = customerSessionStore.get(req.customer.id);
    if (session) {
      session.resetRequired = false;
      session.mustSetPassword = false;
    }
    res.json({ ok: true, redirectTo: "/ui/fleetai-dashboard.html" });
  } catch (err) {
    next(err);
  }
});
app.post("/api/auth/org/reset-password", requireCustomerApi, (req, res, next) => {
  req.url = "/api/auth/reset-password";
  app.handle(req, res, next);
});

app.post("/api/auth/password/update", requireCustomerApi, async (req, res, next) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: "Current and new password required." });
  }
  if (String(newPassword).length < 10) {
    return res.status(400).json({ error: "Password must be at least 10 characters." });
  }
  try {
    const data = await readData();
    const user = (data.users || []).find((u) => u.id === req.customer.userId);
    if (!user) return res.status(404).json({ error: "User not found" });
    const ok = await bcrypt.compare(String(currentPassword), user.passwordHash || "");
    if (!ok) return res.status(401).json({ error: "Current password is incorrect." });
    user.passwordHash = await bcrypt.hash(String(newPassword), 12);
    user.mustResetPassword = false;
    user.requirePasswordReset = false;
    user.isTemporaryPassword = false;
    user.mustSetPassword = false;
    user.lastPasswordChangeAt = nowIso();
    user.passwordLastSetAt = nowIso();
    user.lastLoginAt = nowIso();
    await writeData(data);
    req.customer.resetRequired = false;
    req.customer.mustSetPassword = false;
    const session = customerSessionStore.get(req.customer.id);
    if (session) {
      session.resetRequired = false;
      session.mustSetPassword = false;
    }
    res.json({ ok: true, redirectTo: "/ui/fleetai-dashboard.html" });
  } catch (err) {
    next(err);
  }
});

app.get("/api/orgs/:orgId/public-profile", requireCustomerApi, async (req, res, next) => {
  try {
    if (req.customer.orgId && req.customer.orgId !== req.params.orgId) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const data = await readData();
    const org = (data.orgs || []).find((o) => (o.orgId || o.id) === req.params.orgId || o.id === req.params.orgId);
    if (!org || String(org.status || "").toUpperCase() === "DELETED") {
      return res.status(404).json({ error: "Org not found" });
    }
    res.json({ ok: true, data: { orgId: org.orgId || org.id, name: org.name || "Fleet AI" } });
  } catch (err) {
    next(err);
  }
});

app.post("/api/auth/customer/logout", (req, res) => {
  const session = getCustomerSession(req);
  if (session) {
    customerSessionStore.delete(session.id);
  }
  clearCustomerSessionCookie(res);
  res.json({ ok: true });
});

app.get("/api/telemetry", async (req, res, next) => {
  try {
    const vehicleId = sanitizeString(req.query.vehicle_id || "", 80);
    if (!vehicleId) {
      return res.status(400).json({ error: "vehicle_id required" });
    }
    const cached = telemetryLatest.get(vehicleId);
    if (cached) {
      return res.json(cached);
    }
    const data = await readData();
    const snapshot = getLatestTelemetrySnapshot(data, vehicleId);
    res.json(snapshot || {});
  } catch (err) {
    next(err);
  }
});

app.post("/api/telemetry/ingest", async (req, res, next) => {
  try {
    const payload = req.body || {};
    const vehicleId = sanitizeString(payload.vehicleId || payload.vehicle_id || "", 80);
    const orgId = sanitizeString(payload.orgId || payload.org_id || "", 80) || null;
    const protocol = sanitizeString(payload.protocol || payload.sourceProtocol || "UNKNOWN", 40);
    const frames = Array.isArray(payload.frames) ? payload.frames : [];
    const metrics = payload.metrics && typeof payload.metrics === "object" ? payload.metrics : null;
    const rawPids = payload.rawPids && typeof payload.rawPids === "object" ? payload.rawPids : null;
    const derivedMetrics = payload.derivedMetrics && typeof payload.derivedMetrics === "object" ? payload.derivedMetrics : {};
    if (!vehicleId || (!frames.length && !metrics && !rawPids)) {
      return res.status(400).json({ error: "vehicleId and frames or metrics required" });
    }
    const data = await readData();
    const resolvedOrgId = orgId || resolveOrgIdForVehicle(data, vehicleId);
    const adapter = detectAdapter({ protocol, frames, metrics, rawPids });
  const decoded = frames.length
    ? adapter.decodeFrames(frames)
    : adapter.decodeMetrics(metrics || rawPids || {});
  const normalized = normalizeMetrics({
    decoded,
    protocol: adapter.protocol,
    timestamp: payload.timestamp || nowIso(),
    orgId: resolvedOrgId,
    vehicleId
  });
  const snapshot = storeNormalizedSnapshot(data, normalized, {
    driverId: sanitizeString(payload.driverId || "", 80) || null,
    deviceId: sanitizeString(payload.deviceId || "", 80) || null,
    rawPids: rawPids || metrics || {},
      derivedMetrics,
      odometerMiles: parseNumberField(payload.odometerMiles || payload.odometer || null),
      engineHours: parseNumberField(payload.engineHours || null)
    });
    snapshot.obdConnected = Boolean(payload.obdConnected ?? payload.obd?.connected ?? true);
    snapshot.lastObdPacketAt = payload.lastObdPacketAt || payload.timestamp || nowIso();
    if (frames.length) {
      appendFrames(data, frames.map((frame) => ({
        timestamp: payload.timestamp || nowIso(),
        protocol: adapter.protocol,
        payload: frame,
        decodedSummary: decoded.metrics || {}
      })));
    }
    await writeData(data);
    console.log("[TEL-IN]", {
      vehicleId,
      driverId: payload.driverId || null,
      deviceId: payload.deviceId || null,
      protocol,
      ts: normalized.timestamp || payload.timestamp || nowIso()
    });
  const latestPayload = {
    type: "telemetry",
    vehicleId,
    driverId: snapshot.driverId || null,
    deviceId: snapshot.deviceId || null,
    ts: snapshot.timestamp || nowIso(),
    obdConnected: snapshot.obdConnected,
    lastObdPacketAt: snapshot.lastObdPacketAt,
    metrics: snapshot.metrics || snapshot.decodedMetrics || decoded.metrics || {},
    meta: {
      vin: snapshot.meta?.vin || decoded.meta?.vin || null,
      vinDecoded: snapshot.meta?.vinDecoded || decoded.meta?.vinDecoded || null,
      sourceProtocol: adapter.protocol
    }
  };
    telemetryLatest.set(vehicleId, latestPayload);
    telemetryLastSeen = {
      vehicleId,
      driverId: snapshot.driverId || null,
      deviceId: snapshot.deviceId || null,
      ts: latestPayload.ts
    };
    setTelemetryState("CONNECTED", latestPayload.ts, 0);
    telemetrySubscribers.forEach((res) => {
      try {
        res.write(`data: ${JSON.stringify(latestPayload)}\n\n`);
      } catch (err) {
        // drop dead subscriber
        telemetrySubscribers.delete(res);
      }
    });
    triggerTelemetryPipeline();
    telemetrySnapshotCounter += frames.length ? frames.length : 1;
    if (telemetrySnapshotCounter >= 200) {
      telemetrySnapshotCounter = 0;
      runBaselineJob(true).catch(() => {});
    }
    runPatternDetection().catch(() => {});
    res.json({ ok: true, stored: 1 });
  } catch (err) {
    next(err);
  }
});

app.get("/api/telemetry/latest", async (req, res, next) => {
  try {
    const vehicleId = sanitizeString(req.query.vehicleId || "", 80);
    if (!vehicleId) {
      return res.status(400).json({ error: "vehicleId required" });
    }
    const cached = telemetryLatest.get(vehicleId);
    if (cached) {
      return res.json({ ok: true, data: cached });
    }
    const data = await readData();
    const snapshot = getLatestTelemetrySnapshot(data, vehicleId);
    res.json({ ok: true, data: snapshot });
  } catch (err) {
    next(err);
  }
});

app.get("/api/telemetry/window", async (req, res, next) => {
  try {
    const vehicleId = sanitizeString(req.query.vehicleId || "", 80);
    const minutes = Math.min(Number(req.query.minutes || 60), 1440);
    if (!vehicleId) {
      return res.status(400).json({ error: "vehicleId required" });
    }
    const data = await readData();
    const now = Date.now();
    const start = now - minutes * 60 * 1000;
    const records = (data.telemetryRecords || []).filter((rec) => {
      if (rec.vehicle_id !== vehicleId) return false;
      const ts = parseRecordTimestamp(rec.timestamp);
      return ts && ts >= start;
    });
    res.json({ ok: true, records });
  } catch (err) {
    next(err);
  }
});

app.get("/api/telemetry/history", async (req, res, next) => {
  try {
    const vehicleId = sanitizeString(req.query.vehicleId || "", 80);
    const from = req.query.from ? new Date(req.query.from).getTime() : null;
    const to = req.query.to ? new Date(req.query.to).getTime() : null;
    if (!vehicleId) {
      return res.status(400).json({ error: "vehicleId required" });
    }
    const data = await readData();
    let samples = Array.isArray(data.telemetrySamples) ? data.telemetrySamples : [];
    samples = samples.filter((s) => s.vehicleId === vehicleId);
    if (from) samples = samples.filter((s) => new Date(s.ts).getTime() >= from);
    if (to) samples = samples.filter((s) => new Date(s.ts).getTime() <= to);
    samples.sort((a, b) => new Date(a.ts) - new Date(b.ts));
    res.json({ ok: true, data: samples });
  } catch (err) {
    next(err);
  }
});

app.get("/api/telemetry/summary", async (req, res, next) => {
  try {
    const vehicleId = sanitizeString(req.query.vehicleId || "", 80);
    const days = Math.min(Number(req.query.days || 30), 90);
    if (!vehicleId) {
      return res.status(400).json({ error: "vehicleId required" });
    }
    const data = await readData();
    const now = Date.now();
    const records = getTelemetryRecordsForVehicle(data, vehicleId);
    const coolantAgg = buildAggregateSnapshot(records, TELEMETRY_ALIASES.coolant, now, COOLANT_OVERHEAT_THRESHOLD);
    const batteryAgg = buildAggregateSnapshot(records, TELEMETRY_ALIASES.battery, now, null);
    const fuelAgg = buildAggregateSnapshot(records, TELEMETRY_ALIASES.fuelEff, now, null);
    res.json({
      ok: true,
      summary: {
        windowDays: days,
        coolant: buildMetricsSnapshot("coolant_temp", coolantAgg),
        battery: buildMetricsSnapshot("battery_voltage", batteryAgg),
        fuelEfficiency: buildMetricsSnapshot("fuel_efficiency", fuelAgg)
      }
    });
  } catch (err) {
    next(err);
  }
});

app.get("/api/telemetry/stream", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });
  res.flushHeaders();
  telemetrySubscribers.add(res);
  // send initial snapshots
  telemetryLatest.forEach((snap) => {
    try {
      res.write(`data: ${JSON.stringify(snap)}\n\n`);
    } catch (err) {}
  });
  const heartbeat = setInterval(() => {
    try {
      res.write(`data: ${JSON.stringify({ type: "heartbeat", time: nowIso() })}\n\n`);
    } catch (err) {
      clearInterval(heartbeat);
      telemetrySubscribers.delete(res);
      try { res.end(); } catch (_) {}
    }
  }, 5000);
  req.on("close", () => {
    clearInterval(heartbeat);
    telemetrySubscribers.delete(res);
  });
});

app.get("/api/telemetry/health", (req, res) => {
  const now = Date.now();
  const latest = {};
  telemetryLatest.forEach((snap, vid) => {
    latest[vid] = {
      ts: snap.ts || snap.timestamp || null,
      obdConnected: snap.obdConnected ?? null,
      ageMs: snap.ts ? now - new Date(snap.ts).getTime() : null
    };
  });
  res.json({
    ok: true,
    serverTime: nowIso(),
    subscribers: telemetrySubscribers.size,
    vehiclesStreaming: telemetryLatest.size,
    lastPacketPerVehicle: latest
  });
});

app.get("/api/telemetry/status", (req, res) => {
  const vid = sanitizeString(req.query.vehicleId || req.query.vehicle_id || "", 80);
  const snapshot = vid ? telemetryLatest.get(vid) : null;
  const now = Date.now();
  res.json({
    ok: true,
    serverTime: nowIso(),
    backendConnected: true,
    vehicleId: vid || null,
    snapshot: snapshot ? {
      ts: snapshot.ts || snapshot.timestamp || null,
      ageMs: snapshot.ts ? now - new Date(snapshot.ts).getTime() : null,
      obdConnected: snapshot.obdConnected ?? null,
      metrics: snapshot.metrics || {},
      deviceId: snapshot.deviceId || null,
      driverId: snapshot.driverId || null,
      protocol: snapshot.sourceProtocol || "J1979",
      vin: snapshot.meta ? snapshot.meta.vin || null : null
    } : null,
    vehiclesStreaming: telemetryLatest.size,
    subscribers: telemetrySubscribers.size,
    telemetryState
  });
});

app.get("/api/telemetry/active", (req, res) => {
  const vid = sanitizeString(req.query.vehicleId || req.query.vehicle_id || "", 80);
  const now = Date.now();
  let snap = null;
  if (vid) {
    snap = telemetryLatest.get(vid) || null;
  } else if (telemetryLatest.size) {
    telemetryLatest.forEach((s) => {
      if (!snap) snap = s;
      else {
        const a = new Date(snap.ts || snap.timestamp || 0).getTime();
        const b = new Date(s.ts || s.timestamp || 0).getTime();
        if (b > a) snap = s;
      }
    });
  }
  const ts = snap ? new Date(snap.ts || snap.timestamp || 0).getTime() : 0;
  const ageMs = ts ? now - ts : null;
  res.set({
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    Pragma: "no-cache",
    Expires: "0",
    "Surrogate-Control": "no-store",
    "Content-Type": "application/json"
  });
  res.json({
    ok: true,
    connected: ageMs !== null && ageMs < 10_000,
    obdConnected: snap ? Boolean(snap.obdConnected) : false,
    lastSampleAt: ts ? new Date(ts).toISOString() : null,
    telemetryAgeMs: ageMs,
    vehicleId: snap ? snap.vehicleId || null : null,
    driverId: snap ? snap.driverId || null : null,
    deviceId: snap ? snap.deviceId || null : null,
    protocol: snap ? snap.sourceProtocol || "J1979" : null,
    vin: snap && snap.meta ? snap.meta.vin || null : null,
    metrics: snap ? snap.metrics || {} : {},
    telemetryState
  });
});

app.get("/api/telemetry/debug/protocol", (req, res) => {
  const vehicleId = sanitizeString(req.query.vehicleId || req.query.vehicle_id || "", 80);
  const now = Date.now();
  const items = [];
  telemetryLatest.forEach((snap, vid) => {
    if (vehicleId && vid !== vehicleId) return;
    const ts = snap ? new Date(snap.ts || snap.timestamp || 0).getTime() : 0;
    const metrics = (snap && snap.metrics && typeof snap.metrics === "object") ? snap.metrics : {};
    items.push({
      vehicleId: vid,
      protocol: snap ? (snap.sourceProtocol || snap.meta?.sourceProtocol || "UNKNOWN") : "UNKNOWN",
      obdConnected: snap ? Boolean(snap.obdConnected) : false,
      lastSampleAt: ts ? new Date(ts).toISOString() : null,
      ageMs: ts ? now - ts : null,
      metricCount: Object.keys(metrics).length,
      metricKeys: Object.keys(metrics).slice(0, 20),
      driverId: snap?.driverId || null,
      deviceId: snap?.deviceId || null,
      vin: snap?.meta?.vin || null
    });
  });
  items.sort((a, b) => {
    const at = a.lastSampleAt ? new Date(a.lastSampleAt).getTime() : 0;
    const bt = b.lastSampleAt ? new Date(b.lastSampleAt).getTime() : 0;
    return bt - at;
  });
  res.json({
    ok: true,
    serverTime: nowIso(),
    count: items.length,
    vehicleFilter: vehicleId || null,
    items,
    telemetryState
  });
});

function handleActiveStatus(req, res) {
  const now = Date.now();
  let snap = null;
  telemetryLatest.forEach((s) => {
    if (!snap) snap = s;
    else {
      const a = new Date(snap.ts || snap.timestamp || 0).getTime();
      const b = new Date(s.ts || s.timestamp || 0).getTime();
      if (b > a) snap = s;
    }
  });
  const ts = snap ? new Date(snap.ts || snap.timestamp || 0).getTime() : 0;
  const ageMs = ts ? now - ts : null;
  setTelemetryState(ageMs !== null && ageMs < 10_000 ? "CONNECTED" : "DISCONNECTED", ts ? new Date(ts).toISOString() : null, ageMs);
  logTelemetryHeartbeat(telemetryState.status, ageMs, snap?.meta?.source || "live", snap ? snap.metrics : null);
  res.set({
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    Pragma: "no-cache",
    Expires: "0",
    "Surrogate-Control": "no-store",
    "Content-Type": "application/json"
  });
  res.json({
    ok: true,
    serverTime: nowIso(),
    serverUptimeSec: Math.round(process.uptime()),
    connected: telemetryState.status === "CONNECTED",
    lastTelemetryAt: telemetryState.lastSampleAt,
    ageMs: telemetryState.ageMs,
    source: "tablet",
    vehicleId: snap ? snap.vehicleId || null : null,
    driverId: snap ? snap.driverId || null : null,
    activePair: snap || null,
    telemetryState
  });
}

app.get("/api/active", handleActiveStatus);
app.get("/active", handleActiveStatus);

// Diagnostics: latest telemetry frames (decoded only, raw not persisted here)
app.get("/api/diag/latest", (req, res) => {
  const latest = [];
  telemetryLatest.forEach((snap, vid) => {
    latest.push({
      vehicleId: vid,
      ts: snap.ts || snap.timestamp || null,
      obdConnected: snap.obdConnected ?? null,
      metrics: snap.metrics || {}
    });
  });
  res.json({
    ok: true,
    count: latest.length,
    latest,
    telemetryState
  });
});

// Telemetry state watcher to avoid flicker between statuses
setInterval(() => {
  const now = Date.now();
  let newestTs = null;
  telemetryLatest.forEach((snap) => {
    const ts = snap && snap.ts ? new Date(snap.ts).getTime() : null;
    if (ts && (!newestTs || ts > newestTs)) newestTs = ts;
  });
  if (!newestTs) {
    setTelemetryState("DISCONNECTED", null, null);
    return;
  }
  const ageMs = now - newestTs;
  if (ageMs < 5000) {
    setTelemetryState("CONNECTED", new Date(newestTs).toISOString(), ageMs);
  } else if (ageMs < 15000) {
    setTelemetryState("DEGRADED", new Date(newestTs).toISOString(), ageMs);
  } else {
    setTelemetryState("DISCONNECTED", new Date(newestTs).toISOString(), ageMs);
  }
}, 5000);

app.get("/active", (req, res) => {
  const now = Date.now();
  let latest = null;
  telemetryLatest.forEach((snap) => {
    if (!snap || !snap.ts) return;
    const ts = new Date(snap.ts).getTime();
    if (!ts) return;
    if (!latest || ts > latest.tsMs) {
      latest = {
        tsMs: ts,
        vehicleId: snap.vehicleId || null,
        driverId: snap.driverId || null,
        deviceId: snap.deviceId || null
      };
    }
  });
  const ageMs = latest ? now - latest.tsMs : null;
  res.set({
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    Pragma: "no-cache",
    Expires: "0",
    "Surrogate-Control": "no-store",
    "Content-Type": "application/json"
  });
  res.json({
    ok: true,
    serverTime: nowIso(),
    serverUptimeSec: Math.round(process.uptime()),
    connected: ageMs !== null && ageMs < 10_000,
    lastTelemetryAt: latest ? new Date(latest.tsMs).toISOString() : null,
    ageMs: ageMs,
    source: "tablet",
    vehicleId: latest ? latest.vehicleId : null,
    driverId: latest ? latest.driverId : null,
    activePair: latest
  });
});

app.get("/api/ml/state", async (req, res, next) => {
  try {
    const vehicleId = sanitizeString(req.query.vehicleId || "", 80);
    if (!vehicleId) {
      return res.status(400).json({ error: "vehicleId required" });
    }
    const data = await readData();
    const state = ml.computeModelState(data, vehicleId);
    ml.upsertModelState(data, state);
    const alerts = ml.generateAlertsFromState(state);
    if (alerts.length) {
      data.alerts = Array.isArray(data.alerts) ? data.alerts : [];
      const recent = data.alerts.filter((a) => a.vehicleId === vehicleId);
      alerts.forEach((alert) => {
        const dup = recent.find((a) => a.type === alert.type && Math.abs(new Date(a.createdAt) - new Date(alert.createdAt)) < 6 * 3600000);
        if (!dup) data.alerts.unshift(alert);
      });
    }
    await writeData(data);
    res.json({ ok: true, data: state });
  } catch (err) {
    next(err);
  }
});

app.post("/api/ml/recompute", async (req, res, next) => {
  try {
    const vehicleId = sanitizeString(req.query.vehicleId || req.body?.vehicleId || "", 80);
    if (!vehicleId) {
      return res.status(400).json({ error: "vehicleId required" });
    }
    const data = await readData();
    const state = ml.computeModelState(data, vehicleId);
    ml.upsertModelState(data, state);
    const alerts = ml.generateAlertsFromState(state);
    if (alerts.length) {
      data.alerts = Array.isArray(data.alerts) ? data.alerts : [];
      const recent = data.alerts.filter((a) => a.vehicleId === vehicleId);
      alerts.forEach((alert) => {
        const dup = recent.find((a) => a.type === alert.type && Math.abs(new Date(a.createdAt) - new Date(alert.createdAt)) < 6 * 3600000);
        if (!dup) data.alerts.unshift(alert);
      });
    }
    await writeData(data);
    res.json({ ok: true, data: state });
  } catch (err) {
    next(err);
  }
});

app.get("/api/ml/alerts", async (req, res, next) => {
  try {
    const orgId = sanitizeString(req.query.orgId || "", 80);
    const data = await readData();
    let alerts = Array.isArray(data.alerts) ? data.alerts : [];
    if (orgId) alerts = alerts.filter((a) => a.orgId === orgId);
    alerts.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    res.json({ ok: true, data: alerts });
  } catch (err) {
    next(err);
  }
});

app.get("/api/vehicles/:id/metrics/latest", async (req, res, next) => {
  try {
    const data = await readData();
    const snapshot = getLatestNormalizedMetrics(data, req.params.id);
    res.json({ ok: true, data: snapshot || null });
  } catch (err) {
    next(err);
  }
});

app.get("/api/vehicles/:id/metrics/history", async (req, res, next) => {
  try {
    const data = await readData();
    const rangeMs = parseRangeToMs(req.query.range || "24h");
    const since = Date.now() - rangeMs;
    const metricKey = sanitizeString(req.query.metricKey || "", 40);
    const history = (data.telemetrySnapshots || [])
      .filter((snap) => snap.vehicleId === req.params.id)
      .filter((snap) => parseRecordTimestamp(snap.ts) >= since)
      .map((snap) => {
        const entry = {
          ts: snap.ts
        };
        if (metricKey) {
          entry.value = getMetricValueFromSnapshot(snap, metricKey);
        } else {
          entry.metrics = {
            rpm: snap.rpm,
            coolantTempC: snap.coolantTemp,
            batteryVoltageV: snap.batteryVoltage,
            engineLoadPct: snap.engineLoad,
            fuelLevelPct: snap.fuelLevelPct,
            speedKph: snap.speedKph
          };
        }
        return entry;
      });
    res.json({ ok: true, data: history });
  } catch (err) {
    next(err);
  }
});

app.get("/api/vehicles/:id/dtc-history", async (req, res, next) => {
  try {
    const data = await readData();
    const rangeMs = parseRangeToMs(req.query.range || "14d");
    const since = Date.now() - rangeMs;
    const items = (data.telemetrySnapshots || [])
      .filter((snap) => snap.vehicleId === req.params.id)
      .filter((snap) => parseRecordTimestamp(snap.ts) >= since)
      .flatMap((snap) => (snap.dtcCodes || []).map((code) => ({
        code,
        ts: snap.ts,
        protocol: snap.sourceProtocol || "UNKNOWN"
      })));
    res.json({ ok: true, data: items });
  } catch (err) {
    next(err);
  }
});

app.get("/api/fuel/events", async (req, res, next) => {
  try {
    const data = await readData();
    const vehicleId = sanitizeString(req.query.vehicleId || "", 80);
    let events = Array.isArray(data.fuelEvents) ? data.fuelEvents : [];
    if (vehicleId) events = events.filter((e) => e.vehicleId === vehicleId);
    const samples = vehicleId
      ? (data.telemetrySamples || []).filter((s) => s.vehicleId === vehicleId)
      : (data.telemetrySamples || []);
    const fuelSignalAvailable = samples.some((s) => s.metrics && s.metrics.fuelLevel != null);
    res.json({ ok: true, data: events, fuelSignalAvailable });
  } catch (err) {
    next(err);
  }
});

app.post("/api/fuel/manual", requireEmployeeOrCustomerApi, async (req, res, next) => {
  try {
    const payload = req.body || {};
    const vehicleId = sanitizeString(payload.vehicleId || "", 80);
    if (!vehicleId) return res.status(400).json({ error: "vehicleId required" });
    const data = await readData();
    const orgId = resolveOrgIdForVehicle(data, vehicleId);
    const event = {
      id: makeId("FUEL"),
      orgId,
      vehicleId,
      tsStart: parseIsoDate(payload.tsStart || payload.ts || nowIso()),
      tsEnd: parseIsoDate(payload.tsEnd || payload.ts || nowIso()),
      detectedBy: "MANUAL",
      fuelLevelBefore: parseNumberField(payload.fuelLevelBefore, null),
      fuelLevelAfter: parseNumberField(payload.fuelLevelAfter, null),
      gallonsEstimated: parseNumberField(payload.gallonsEstimated, null),
      location: sanitizeString(payload.location || "", 200),
      confidence: parseNumberField(payload.confidence, 0.5),
      note: sanitizeString(payload.note || payload.notes || "", 800)
    };
    data.fuelEvents = Array.isArray(data.fuelEvents) ? data.fuelEvents : [];
    data.fuelEvents.unshift(event);
    addAudit(data, "FUEL_EVENT_MANUAL", `Fuel event logged for ${vehicleId}`);
    await writeData(data);
    res.json({ ok: true, data: event });
  } catch (err) {
    next(err);
  }
});

app.get("/api/tire-risk", (req, res) => {
  res.status(204).end();
});

app.get("/api/alerts", async (req, res, next) => {
  try {
    const vehicleId = sanitizeString(req.query.vehicle_id || "", 80);
    const orgId = sanitizeString(req.query.orgId || "", 80);
    const limit = Math.min(Number(req.query.limit || 20), 50);
    const data = await readData();
    let events = Array.isArray(data.events) ? data.events : [];
    let signals = Array.isArray(data.trendSignals) ? data.trendSignals : [];
    let mlAlerts = Array.isArray(data.alerts) ? data.alerts : [];
    if (orgId) {
      events = events.filter((evt) => evt.org_id === orgId);
      signals = signals.filter((sig) => sig.orgId === orgId);
      mlAlerts = mlAlerts.filter((evt) => evt.orgId === orgId);
    }
    if (vehicleId) {
      events = events.filter((evt) => evt.vehicle_id === vehicleId);
      signals = signals.filter((sig) => sig.vehicleId === vehicleId);
      mlAlerts = mlAlerts.filter((evt) => evt.vehicleId === vehicleId);
    }
    const alerts = events.slice(0, limit).map((evt) => ({
      alert_id: evt.id,
      vehicle_id: evt.vehicle_id,
      severity: evt.severity === "warn" ? "warning" : evt.severity,
      title: formatEventTitle(evt.type),
      details: evt.explanation || "Anomaly detected. Review telemetry for details.",
      recommended_action: (evt.recommended_actions || [])[0] || "",
      timestamp: evt.detected_at,
      category: "event",
      service_window: null
    }));
    const predictive = signals.slice(0, limit).map((sig) => ({
      alert_id: sig.id,
      vehicle_id: sig.vehicleId,
      severity: sig.severity,
      title: sig.ruleId.replace(/_/g, " "),
      details: sig.delta != null && sig.baselineMean != null
        ? `Mean ${sig.metricKey} shifted by ${sig.delta.toFixed(2)} from baseline ${sig.baselineMean.toFixed(2)}.`
        : "Trend detected based on recent telemetry history.",
      recommended_action: sig.recommendedAction || "",
      timestamp: sig.createdAt,
      category: "predictive",
      service_window: sig.serviceWindow || []
    }));
    const tier2 = mlAlerts.map((evt) => ({
      alert_id: evt.id,
      vehicle_id: evt.vehicleId,
      severity: evt.severity === "warning" ? "warning" : evt.severity,
      title: evt.type || "Alert",
      details: evt.explanation || "Anomaly detected.",
      recommended_action: (evt.recommendedChecks || [])[0] || "",
      timestamp: evt.createdAt,
      category: "ml",
      service_window: null
    }));
    res.json(tier2.concat(alerts, predictive).slice(0, limit));
  } catch (err) {
    next(err);
  }
});

app.post("/api/alerts/:id/ack", async (req, res, next) => {
  try {
    const data = await readData();
    const event = (data.events || []).find((evt) => evt.id === req.params.id);
    if (!event) return res.status(404).json({ error: "Alert not found" });
    event.status = "acknowledged";
    event.updated_at = nowIso();
    await writeData(data);
    res.json({ ok: true, data: event });
  } catch (err) {
    next(err);
  }
});

app.post("/api/alerts/:id/resolve", async (req, res, next) => {
  try {
    const data = await readData();
    const event = (data.events || []).find((evt) => evt.id === req.params.id);
    if (!event) return res.status(404).json({ error: "Alert not found" });
    event.status = "resolved";
    event.updated_at = nowIso();
    event.resolved_at = nowIso();
    await writeData(data);
    res.json({ ok: true, data: event });
  } catch (err) {
    next(err);
  }
});

app.get("/api/orgs/:orgId/events", async (req, res, next) => {
  try {
    const data = await readData();
    const orgId = req.params.orgId;
    const events = (data.events || []).filter((evt) => evt.org_id === orgId);
    res.json({ ok: true, events });
  } catch (err) {
    next(err);
  }
});

app.get("/api/vehicles/:vehicleId/events", async (req, res, next) => {
  try {
    const data = await readData();
    const vehicleId = req.params.vehicleId;
    const events = (data.events || []).filter((evt) => evt.vehicle_id === vehicleId);
    res.json({ ok: true, events });
  } catch (err) {
    next(err);
  }
});

app.get("/api/orgs/:orgId/notifications", async (req, res, next) => {
  try {
    const data = await readData();
    const orgId = req.params.orgId;
    const notifications = (data.notifications || []).filter((n) => n.org_id === orgId);
    res.json({ ok: true, notifications });
  } catch (err) {
    next(err);
  }
});

app.post("/api/notifications/:id/read", async (req, res, next) => {
  try {
    const data = await readData();
    const notif = (data.notifications || []).find((n) => n.id === req.params.id);
    if (!notif) {
      return res.status(404).json({ error: "Notification not found" });
    }
    notif.status = "read";
    await writeData(data);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.post("/api/reports/30day-summary", (req, res) => {
  res.json({ ok: true, report: null });
});

app.post("/api/reports/cost-avoidance", (req, res) => {
  res.json({ ok: true, report: null });
});

app.post("/api/reports/maintenance-priority", (req, res) => {
  res.json({ ok: true, report: null });
});

app.get("/api/safety/events", (req, res) => {
  res.json({ ok: true, events: [] });
});

app.get("/api/compliance/issues", (req, res) => {
  res.json({ ok: true, issues: [] });
});

app.get("/api/gps/latest", (req, res) => {
  res.json({ ok: true, data: null });
});

app.get("/api/cameras/events", (req, res) => {
  res.json({ ok: true, events: [] });
});

app.get("/api/orgs/:orgId/vehicles/:vehicleId/maintenance-logs", requireEmployeeOrCustomerApi, async (req, res, next) => {
  try {
    const data = await readData();
    const orgId = sanitizeString(req.params.orgId || "", 80);
    const vehicleId = sanitizeString(req.params.vehicleId || "", 80);
    if (!orgId || !vehicleId) {
      return res.status(400).json({ error: "orgId and vehicleId required" });
    }
    const resolvedOrgId = resolveOrgIdForVehicle(data, vehicleId);
    if (req.customer && req.customer.orgId && req.customer.orgId !== orgId) {
      return res.status(403).json({ error: "Forbidden" });
    }
    if (resolvedOrgId && resolvedOrgId !== orgId) {
      return res.status(404).json({ error: "Vehicle not found for org" });
    }
    let logs = Array.isArray(data.maintenanceLogs) ? data.maintenanceLogs : [];
    logs = logs.filter((log) => log.vehicleId === vehicleId && (!log.orgId || log.orgId === orgId));
    logs = logs.filter((log) => !log.deletedAt);
    if (req.query.range) {
      const rangeMs = parseRangeToMs(req.query.range);
      const since = Date.now() - rangeMs;
      logs = logs.filter((log) => {
        const ts = new Date(log.occurredAt || log.createdAt || 0).getTime();
        return ts && ts >= since;
      });
    }
    logs.sort((a, b) => new Date(b.occurredAt || b.createdAt) - new Date(a.occurredAt || a.createdAt));
    res.json({ ok: true, data: logs });
  } catch (err) {
    next(err);
  }
});

app.post("/api/orgs/:orgId/vehicles/:vehicleId/maintenance-logs", requireEmployeeOrCustomerApi, async (req, res, next) => {
  try {
    const data = await readData();
    const orgId = sanitizeString(req.params.orgId || "", 80);
    const vehicleId = sanitizeString(req.params.vehicleId || "", 80);
    if (!orgId || !vehicleId) {
      return res.status(400).json({ error: "orgId and vehicleId required" });
    }
    const resolvedOrgId = resolveOrgIdForVehicle(data, vehicleId);
    if (req.customer && req.customer.orgId && req.customer.orgId !== orgId) {
      return res.status(403).json({ error: "Forbidden" });
    }
    if (resolvedOrgId && resolvedOrgId !== orgId) {
      return res.status(404).json({ error: "Vehicle not found for org" });
    }
    const payload = req.body || {};
    const occurredAt = payload.occurredAt ? parseIsoDate(payload.occurredAt) : null;
    const category = normalizeMaintenanceCategory(payload.category || "");
    const categoryEnum = normalizeMaintenanceEnum(payload.category || "");
    const item = sanitizeString(payload.item || "", 200);
    if (!occurredAt || !category || !item) {
      return res.status(400).json({ error: "occurredAt, category, and item are required" });
    }
    const odometerKm = parseNumberField(payload.odometerKm, null);
    const cost = parseNumberField(payload.cost, null);
    const labels = ml.generateMaintenanceLabels({
      category: categoryEnum,
      item,
      notes: payload.notes,
      parts: payload.parts
    });
    const log = {
      id: makeId("ML"),
      orgId,
      vehicleId,
      createdByEmployeeId: req.employee?.userId || null,
      createdByUserEmail: req.employee?.email || req.customer?.email || null,
      createdAt: nowIso(),
      ts: nowIso(),
      serviceDate: occurredAt,
      odometerAtService: odometerKm,
      engineHoursAtService: parseNumberField(payload.engineHours, null),
      category: categoryEnum,
      title: item,
      notes: sanitizeString(payload.notes || "", 2000),
      partsUsed: payload.parts ? [sanitizeString(payload.parts, 200)] : [],
      partsUsedDetail: payload.parts ? sanitizePartsList([{ partName: payload.parts }]) : [],
      laborHours: null,
      cost,
      attachments: Array.isArray(payload.attachments) ? payload.attachments.map((a) => sanitizeString(a, 300)) : [],
      labels,
      occurredAt,
      odometerKm,
      engineHours: parseNumberField(payload.engineHours, null),
      categoryLabel: category,
      item,
      parts: sanitizeString(payload.parts || "", 500),
      vendor: sanitizeString(payload.vendor || "", 200),
      type: normalizeMaintenanceType(mapCategoryToType(category)),
      description: sanitizeString(item, 2000),
      partsUsedDetail: payload.parts ? sanitizePartsList([{ partName: payload.parts }]) : [],
      costTotal: cost,
      odometerMiles: odometerKm != null ? kmToMiles(odometerKm) : null,
      source: "manual",
      deletedAt: null
    };
    data.maintenanceLogs = Array.isArray(data.maintenanceLogs) ? data.maintenanceLogs : [];
    data.maintenanceLogs.unshift(log);
    addAudit(data, "MAINTENANCE_LOG_CREATED", `Maintenance log created for ${vehicleId}`);
    updatePatternSignature(data, vehicleId, log.type, 14, log.occurredAt);
    ml.markPreEventWindow(data, vehicleId, labels, occurredAt);
    await writeData(data);
    res.json({ ok: true, data: log });
  } catch (err) {
    next(err);
  }
});

app.put("/api/orgs/:orgId/vehicles/:vehicleId/maintenance-logs/:logId", requireEmployeeOrCustomerApi, async (req, res, next) => {
  try {
    const data = await readData();
    const orgId = sanitizeString(req.params.orgId || "", 80);
    const vehicleId = sanitizeString(req.params.vehicleId || "", 80);
    const logId = sanitizeString(req.params.logId || "", 80);
    if (!orgId || !vehicleId || !logId) {
      return res.status(400).json({ error: "orgId, vehicleId, and logId required" });
    }
    const resolvedOrgId = resolveOrgIdForVehicle(data, vehicleId);
    if (req.customer && req.customer.orgId && req.customer.orgId !== orgId) {
      return res.status(403).json({ error: "Forbidden" });
    }
    if (resolvedOrgId && resolvedOrgId !== orgId) {
      return res.status(404).json({ error: "Vehicle not found for org" });
    }
    const log = (data.maintenanceLogs || []).find((item) => item.id === logId);
    if (!log) return res.status(404).json({ error: "Maintenance log not found" });
    const payload = req.body || {};
    if (payload.occurredAt) {
      log.occurredAt = parseIsoDate(payload.occurredAt);
      log.serviceDate = log.occurredAt;
    }
    if (payload.category !== undefined) {
      log.categoryLabel = normalizeMaintenanceCategory(payload.category || "");
      log.category = normalizeMaintenanceEnum(payload.category || "");
      log.type = normalizeMaintenanceType(mapCategoryToType(log.categoryLabel || ""));
    }
    if (payload.item !== undefined) {
      log.item = sanitizeString(payload.item || "", 200);
      log.title = log.item;
      log.description = sanitizeString(payload.item || "", 2000);
    }
    if (payload.odometerKm !== undefined) {
      log.odometerKm = parseNumberField(payload.odometerKm, null);
      log.odometerMiles = log.odometerKm != null ? kmToMiles(log.odometerKm) : null;
      log.odometerAtService = log.odometerKm;
    }
    if (payload.engineHours !== undefined) {
      log.engineHours = parseNumberField(payload.engineHours, null);
      log.engineHoursAtService = log.engineHours;
    }
    if (payload.parts !== undefined) {
      log.parts = sanitizeString(payload.parts || "", 500);
      log.partsUsed = log.parts ? [log.parts] : [];
      log.partsUsedDetail = log.parts ? sanitizePartsList([{ partName: log.parts }]) : [];
    }
    if (payload.notes !== undefined) log.notes = sanitizeString(payload.notes || "", 2000);
    if (payload.cost !== undefined) {
      log.cost = parseNumberField(payload.cost, null);
      log.costTotal = log.cost;
    }
    if (payload.vendor !== undefined) log.vendor = sanitizeString(payload.vendor || "", 200);
    log.labels = ml.generateMaintenanceLabels({
      category: log.category,
      item: log.item,
      notes: log.notes,
      parts: log.parts,
      partsUsed: log.partsUsed
    });
    log.updatedAt = nowIso();
    addAudit(data, "MAINTENANCE_LOG_UPDATED", `Maintenance log updated for ${vehicleId}`);
    await writeData(data);
    res.json({ ok: true, data: log });
  } catch (err) {
    next(err);
  }
});

app.delete("/api/orgs/:orgId/vehicles/:vehicleId/maintenance-logs/:logId", requireEmployeeOrCustomerApi, async (req, res, next) => {
  try {
    const data = await readData();
    const orgId = sanitizeString(req.params.orgId || "", 80);
    const vehicleId = sanitizeString(req.params.vehicleId || "", 80);
    const logId = sanitizeString(req.params.logId || "", 80);
    if (!orgId || !vehicleId || !logId) {
      return res.status(400).json({ error: "orgId, vehicleId, and logId required" });
    }
    const resolvedOrgId = resolveOrgIdForVehicle(data, vehicleId);
    if (req.customer && req.customer.orgId && req.customer.orgId !== orgId) {
      return res.status(403).json({ error: "Forbidden" });
    }
    if (resolvedOrgId && resolvedOrgId !== orgId) {
      return res.status(404).json({ error: "Vehicle not found for org" });
    }
    const log = (data.maintenanceLogs || []).find((item) => item.id === logId);
    if (!log) {
      return res.status(404).json({ error: "Maintenance log not found" });
    }
    log.deletedAt = nowIso();
    log.deletedBy = req.employee?.userId || req.customer?.email || null;
    addAudit(data, "MAINTENANCE_LOG_DELETED", `Maintenance log deleted for ${vehicleId}`);
    await writeData(data);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.get("/api/maintenance-logs", async (req, res, next) => {
  try {
    const data = await readData();
    const vehicleId = sanitizeString(req.query.vehicleId || "", 80);
    const start = req.query.start ? new Date(req.query.start).getTime() : null;
    const end = req.query.end ? new Date(req.query.end).getTime() : null;
    const serviceType = normalizeServiceType(req.query.serviceType || req.query.type || "");
    let logs = Array.isArray(data.maintenanceLogs) ? data.maintenanceLogs : [];
    logs = logs.filter((l) => !l.deletedAt);
    if (vehicleId) logs = logs.filter((l) => l.vehicleId === vehicleId);
    if (req.query.serviceType || req.query.type) {
      if (!serviceType) {
        return res.status(400).json({ error: "Invalid serviceType" });
      }
      logs = logs.filter((l) => (l.serviceType || "") === serviceType);
    }
    if (start) logs = logs.filter((l) => getMaintenanceLogTimestamp(l) >= start);
    if (end) logs = logs.filter((l) => getMaintenanceLogTimestamp(l) <= end);
    res.json({ ok: true, data: logs });
  } catch (err) {
    next(err);
  }
});

app.post("/api/maintenance-logs", async (req, res, next) => {
  try {
    const payload = req.body || {};
    const vehicleId = sanitizeString(payload.vehicleId || "", 80);
    if (!vehicleId) return res.status(400).json({ error: "vehicleId required" });
    const data = await readData();
    const vehicle = (data.vehicles || []).find((v) => v.vehicleId === vehicleId);
    if (!vehicle) return res.status(400).json({ error: "Vehicle not found" });
    const serviceType = normalizeServiceType(payload.serviceType || payload.type || "");
    if (!serviceType) return res.status(400).json({ error: "serviceType required" });
    const notes = sanitizeString(payload.notes || "", 2000);
    if (serviceType === "MANUAL" && !notes) {
      return res.status(400).json({ error: "notes required for manual entries" });
    }
    const performedInput = payload.performedAt || payload.occurredAt || payload.date || "";
    const performedAt = performedInput ? safeParseIsoDate(performedInput) : nowIso();
    if (performedInput && !performedAt) {
      return res.status(400).json({ error: "performedAt must be a valid date" });
    }
    const errors = [];
    const odometer = parseOptionalNumber(payload.odometer ?? payload.odometerKm ?? payload.odometerMiles, "odometer", errors);
    const engineHours = parseOptionalNumber(payload.engineHours ?? payload.engineHoursAtService, "engineHours", errors);
    const cost = parseOptionalNumber(payload.cost ?? payload.costTotal, "cost", errors);
    if (errors.length) {
      return res.status(400).json({ error: errors.join(", ") });
    }
    const partsUsed = normalizePartsList(payload.parts || payload.partsUsed || payload.partsList);
    const serviceSubType = sanitizeString(payload.serviceSubType || payload.subType || "", 200);
    const performedBy = sanitizeString(payload.performedBy || payload.vendor || "", 120);
    const categoryLabel = serviceTypeCategoryLabel(serviceType);
    const categoryEnum = normalizeMaintenanceEnum(categoryLabel);
    const title = sanitizeString(
      payload.title || (serviceSubType ? `${serviceTypeLabel(serviceType)}: ${serviceSubType}` : serviceTypeLabel(serviceType)),
      200
    );
    const log = {
      id: makeId("MAINT"),
      orgId: resolveOrgIdForVehicle(data, vehicleId),
      vehicleId,
      createdBy: req.employee?.userId || null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      performedAt,
      occurredAt: performedAt,
      serviceDate: performedAt,
      serviceType,
      serviceSubType,
      notes,
      performedBy,
      odometer,
      odometerAtService: odometer,
      engineHours,
      engineHoursAtService: engineHours,
      cost,
      costTotal: cost,
      parts: partsUsed.join(", "),
      partsUsed,
      attachments: Array.isArray(payload.attachments) ? payload.attachments.map((a) => sanitizeString(a, 300)).filter(Boolean) : [],
      category: categoryEnum,
      categoryLabel,
      title,
      description: sanitizeString(payload.description || notes || title, 2000),
      type: serviceTypeLegacyType(serviceType),
      source: sanitizeString(payload.source || "manual", 40),
      deletedAt: null
    };
    data.maintenanceLogs = Array.isArray(data.maintenanceLogs) ? data.maintenanceLogs : [];
    data.maintenanceLogs.unshift(log);
    updatePatternSignature(data, vehicleId, log.type, 14, log.occurredAt);
    addAudit(data, "MAINTENANCE_LOG_CREATED", `Maintenance log created for ${vehicleId}`);
    await writeData(data);
    res.json({ ok: true, data: log });
  } catch (err) {
    next(err);
  }
});

app.put("/api/maintenance-logs/:id", async (req, res, next) => {
  try {
    const data = await readData();
    const log = (data.maintenanceLogs || []).find((l) => l.id === req.params.id);
    if (!log) return res.status(404).json({ error: "Maintenance log not found" });
    const payload = req.body || {};
    if (payload.vehicleId) {
      const vehicleId = sanitizeString(payload.vehicleId || "", 80);
      const vehicle = (data.vehicles || []).find((v) => v.vehicleId === vehicleId);
      if (!vehicle) return res.status(400).json({ error: "Vehicle not found" });
      log.vehicleId = vehicleId;
      log.orgId = resolveOrgIdForVehicle(data, vehicleId);
    }
    if (payload.performedAt || payload.occurredAt || payload.date) {
      const performedAt = safeParseIsoDate(payload.performedAt || payload.occurredAt || payload.date);
      if (!performedAt) return res.status(400).json({ error: "performedAt must be a valid date" });
      log.performedAt = performedAt;
      log.occurredAt = performedAt;
      log.serviceDate = performedAt;
    }
    if (payload.serviceType || payload.type) {
      const serviceType = normalizeServiceType(payload.serviceType || payload.type || "");
      if (!serviceType) return res.status(400).json({ error: "serviceType required" });
      log.serviceType = serviceType;
      log.type = serviceTypeLegacyType(serviceType);
      const categoryLabel = serviceTypeCategoryLabel(serviceType);
      log.categoryLabel = categoryLabel;
      log.category = normalizeMaintenanceEnum(categoryLabel);
      const serviceSubType = sanitizeString(payload.serviceSubType || log.serviceSubType || "", 200);
      log.serviceSubType = serviceSubType;
      log.title = sanitizeString(
        payload.title || (serviceSubType ? `${serviceTypeLabel(serviceType)}: ${serviceSubType}` : serviceTypeLabel(serviceType)),
        200
      );
    }
    if (payload.notes !== undefined) log.notes = sanitizeString(payload.notes || "", 2000);
    if (log.serviceType === "MANUAL" && !log.notes) {
      return res.status(400).json({ error: "notes required for manual entries" });
    }
    if (payload.serviceSubType !== undefined) {
      log.serviceSubType = sanitizeString(payload.serviceSubType || "", 200);
    }
    if (payload.performedBy !== undefined) {
      log.performedBy = sanitizeString(payload.performedBy || "", 120);
      log.vendor = log.performedBy || log.vendor || "";
    }
    const errors = [];
    if (payload.odometer !== undefined || payload.odometerKm !== undefined || payload.odometerMiles !== undefined) {
      log.odometer = parseOptionalNumber(payload.odometer ?? payload.odometerKm ?? payload.odometerMiles, "odometer", errors);
      log.odometerAtService = log.odometer;
    }
    if (payload.engineHours !== undefined || payload.engineHoursAtService !== undefined) {
      log.engineHours = parseOptionalNumber(payload.engineHours ?? payload.engineHoursAtService, "engineHours", errors);
      log.engineHoursAtService = log.engineHours;
    }
    if (payload.cost !== undefined || payload.costTotal !== undefined) {
      log.cost = parseOptionalNumber(payload.cost ?? payload.costTotal, "cost", errors);
      log.costTotal = log.cost;
    }
    if (errors.length) {
      return res.status(400).json({ error: errors.join(", ") });
    }
    if (payload.parts !== undefined || payload.partsUsed !== undefined || payload.partsList !== undefined) {
      const partsUsed = normalizePartsList(payload.parts || payload.partsUsed || payload.partsList);
      log.parts = partsUsed.join(", ");
      log.partsUsed = partsUsed;
    }
    if (payload.attachments) {
      log.attachments = Array.isArray(payload.attachments)
        ? payload.attachments.map((a) => sanitizeString(a, 300)).filter(Boolean)
        : [];
    }
    log.description = sanitizeString(payload.description || log.notes || log.title || "", 2000);
    log.updatedAt = nowIso();
    addAudit(data, "MAINTENANCE_LOG_UPDATED", `Maintenance log updated for ${log.vehicleId || "vehicle"}`);
    await writeData(data);
    res.json({ ok: true, data: log });
  } catch (err) {
    next(err);
  }
});

app.delete("/api/maintenance-logs/:id", async (req, res, next) => {
  try {
    const data = await readData();
    const log = (data.maintenanceLogs || []).find((l) => l.id === req.params.id);
    if (!log) {
      return res.status(404).json({ error: "Maintenance log not found" });
    }
    log.deletedAt = nowIso();
    log.deletedBy = req.employee?.userId || req.customer?.email || null;
    addAudit(data, "MAINTENANCE_LOG_DELETED", `Maintenance log deleted for ${log.vehicleId || "vehicle"}`);
    await writeData(data);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.get("/api/maintenance", async (req, res, next) => {
  try {
    const data = await readData();
    const vehicleId = sanitizeString(req.query.vehicleId || "", 80);
    const type = normalizeMaintenanceType(req.query.type || "");
    const start = req.query.start ? new Date(req.query.start).getTime() : null;
    const end = req.query.end ? new Date(req.query.end).getTime() : null;
    let logs = Array.isArray(data.maintenanceLogs) ? data.maintenanceLogs : [];
    logs = logs.filter((l) => !l.deletedAt);
    if (vehicleId) logs = logs.filter((l) => l.vehicleId === vehicleId);
    if (req.query.type) logs = logs.filter((l) => l.type === type);
    if (start) logs = logs.filter((l) => new Date(l.occurredAt).getTime() >= start);
    if (end) logs = logs.filter((l) => new Date(l.occurredAt).getTime() <= end);
    res.json({ ok: true, data: logs });
  } catch (err) {
    next(err);
  }
});

app.post("/api/maintenance", requireEmployeeOrCustomerApi, async (req, res, next) => {
  try {
    const payload = req.body || {};
    const vehicleId = sanitizeString(payload.vehicleId || "", 80);
    if (!vehicleId) return res.status(400).json({ error: "vehicleId required" });
    const data = await readData();
    const orgId = resolveOrgIdForVehicle(data, vehicleId);
    const serviceDate = parseIsoDate(payload.serviceDate || payload.occurredAt || payload.date || nowIso());
    const title = sanitizeString(payload.title || payload.item || payload.description || "", 200);
    if (!serviceDate || !title) {
      return res.status(400).json({ error: "serviceDate and title required" });
    }
    const categoryEnum = normalizeMaintenanceEnum(payload.category || payload.type || "");
    const partsInput = Array.isArray(payload.partsUsed)
      ? payload.partsUsed.map((p) => sanitizeString(p, 200)).filter(Boolean)
      : (payload.parts ? [sanitizeString(payload.parts, 200)] : []);
    const partsDetail = payload.parts ? sanitizePartsList([{ partName: payload.parts }]) : [];
    const labels = ml.generateMaintenanceLabels({
      category: categoryEnum,
      item: title,
      notes: payload.notes || payload.description,
      parts: payload.parts,
      partsUsed: partsInput
    });
    const log = {
      id: makeId("MAINT"),
      orgId,
      vehicleId,
      createdBy: req.employee?.userId || null,
      ts: nowIso(),
      createdAt: nowIso(),
      serviceDate,
      odometerAtService: parseNumberField(payload.odometerAtService || payload.odometerKm || payload.odometerMiles, null),
      engineHoursAtService: parseNumberField(payload.engineHoursAtService || payload.engineHours, null),
      category: categoryEnum,
      title,
      notes: sanitizeString(payload.notes || payload.description || "", 2000),
      parts: sanitizeString(payload.parts || "", 500),
      partsUsed: partsInput,
      partsUsedDetail: partsDetail,
      laborHours: parseNumberField(payload.laborHours, null),
      cost: parseNumberField(payload.cost || payload.costTotal, null),
      attachments: Array.isArray(payload.attachments) ? payload.attachments.map((a) => sanitizeString(a, 300)) : [],
      labels,
      occurredAt: serviceDate,
      odometerMiles: parseNumberField(payload.odometerMiles, null),
      engineHours: parseNumberField(payload.engineHours, null),
      type: normalizeMaintenanceType(payload.type || mapCategoryToType(normalizeMaintenanceCategory(payload.category || ""))),
      description: sanitizeString(payload.description || title, 2000),
      vendor: sanitizeString(payload.vendor || "", 200),
      costTotal: parseNumberField(payload.costTotal || payload.cost, null),
      source: sanitizeString(payload.source || "manual", 40),
      deletedAt: null
    };
    data.maintenanceLogs = Array.isArray(data.maintenanceLogs) ? data.maintenanceLogs : [];
    data.maintenanceLogs.unshift(log);
    updatePatternSignature(data, vehicleId, log.type, 14, log.occurredAt);
    addAudit(data, "MAINTENANCE_LOG_CREATED", `Maintenance log created for ${vehicleId}`);
    ml.markPreEventWindow(data, vehicleId, labels, serviceDate);
    await writeData(data);
    res.json({ ok: true, data: log });
  } catch (err) {
    next(err);
  }
});

app.put("/api/maintenance/:id", requireEmployeeOrCustomerApi, async (req, res, next) => {
  try {
    const data = await readData();
    const log = (data.maintenanceLogs || []).find((l) => l.id === req.params.id);
    if (!log) return res.status(404).json({ error: "Maintenance log not found" });
    if (req.customer && req.customer.orgId && log.orgId && req.customer.orgId !== log.orgId) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const payload = req.body || {};
    if (payload.serviceDate) log.serviceDate = parseIsoDate(payload.serviceDate);
    if (payload.occurredAt) log.occurredAt = parseIsoDate(payload.occurredAt);
    if (log.serviceDate && !log.occurredAt) log.occurredAt = log.serviceDate;
    if (payload.title !== undefined) log.title = sanitizeString(payload.title || "", 200);
    if (payload.category !== undefined) log.category = normalizeMaintenanceEnum(payload.category || "");
    if (payload.notes !== undefined) log.notes = sanitizeString(payload.notes || "", 2000);
    if (payload.partsUsed) {
      log.partsUsed = Array.isArray(payload.partsUsed)
        ? payload.partsUsed.map((p) => sanitizeString(p, 200)).filter(Boolean)
        : [];
    }
    if (payload.parts !== undefined) {
      const partText = sanitizeString(payload.parts || "", 200);
      log.parts = partText;
      log.partsUsed = partText ? [partText] : log.partsUsed || [];
      log.partsUsedDetail = partText ? sanitizePartsList([{ partName: partText }]) : [];
    }
    if (payload.laborHours !== undefined) log.laborHours = parseNumberField(payload.laborHours, null);
    if (payload.cost !== undefined) log.cost = parseNumberField(payload.cost, null);
    if (payload.attachments) {
      log.attachments = Array.isArray(payload.attachments) ? payload.attachments.map((a) => sanitizeString(a, 300)) : [];
    }
    if (payload.odometerAtService !== undefined) log.odometerAtService = parseNumberField(payload.odometerAtService, null);
    if (payload.engineHoursAtService !== undefined) log.engineHoursAtService = parseNumberField(payload.engineHoursAtService, null);
    if (payload.odometerMiles !== undefined) log.odometerMiles = parseNumberField(payload.odometerMiles, null);
    if (payload.engineHours !== undefined) log.engineHours = parseNumberField(payload.engineHours, null);
    if (payload.type) log.type = normalizeMaintenanceType(payload.type);
    if (payload.description !== undefined) log.description = sanitizeString(payload.description || "", 2000);
    if (payload.vendor !== undefined) log.vendor = sanitizeString(payload.vendor || "", 200);
    if (payload.costTotal !== undefined) log.costTotal = parseNumberField(payload.costTotal, null);
    log.labels = ml.generateMaintenanceLabels({
      category: log.category,
      item: log.title || log.description,
      notes: log.notes,
      parts: log.parts,
      partsUsed: log.partsUsed
    });
    log.updatedAt = nowIso();
    addAudit(data, "MAINTENANCE_LOG_UPDATED", `Maintenance log updated for ${log.vehicleId || "vehicle"}`);
    await writeData(data);
    res.json({ ok: true, data: log });
  } catch (err) {
    next(err);
  }
});

app.delete("/api/maintenance/:id", requireEmployeeOrCustomerApi, async (req, res, next) => {
  try {
    const data = await readData();
    const log = (data.maintenanceLogs || []).find((l) => l.id === req.params.id);
    if (!log) {
      return res.status(404).json({ error: "Maintenance log not found" });
    }
    if (req.customer && req.customer.orgId && log.orgId && req.customer.orgId !== log.orgId) {
      return res.status(403).json({ error: "Forbidden" });
    }
    log.deletedAt = nowIso();
    log.deletedBy = req.employee?.userId || req.customer?.email || null;
    addAudit(data, "MAINTENANCE_LOG_DELETED", `Maintenance log deleted for ${log.vehicleId || "vehicle"}`);
    await writeData(data);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.get("/api/workorders", async (req, res, next) => {
  try {
    const data = await readData();
    const vehicleId = sanitizeString(req.query.vehicleId || "", 80);
    const status = sanitizeString(req.query.status || "", 20);
    let orders = Array.isArray(data.workOrders) ? data.workOrders : [];
    if (vehicleId) orders = orders.filter((w) => w.vehicleId === vehicleId);
    if (status) orders = orders.filter((w) => w.status === status);
    res.json({ ok: true, data: orders });
  } catch (err) {
    next(err);
  }
});

app.post("/api/workorders", async (req, res, next) => {
  try {
    const payload = req.body || {};
    const vehicleId = sanitizeString(payload.vehicleId || "", 80);
    if (!vehicleId) return res.status(400).json({ error: "vehicleId required" });
    const data = await readData();
    const orgId = resolveOrgIdForVehicle(data, vehicleId);
    const order = {
      id: makeId("WO"),
      orgId,
      vehicleId,
      openedAt: nowIso(),
      closedAt: null,
      status: "open",
      complaint: sanitizeString(payload.complaint || "", 2000),
      diagnosis: sanitizeString(payload.diagnosis || "", 2000),
      repairActions: sanitizeString(payload.repairActions || "", 2000),
      dtcCodes: Array.isArray(payload.dtcCodes) ? payload.dtcCodes.map((c) => sanitizeString(c, 20)).filter(Boolean) : [],
      odometerMilesAtService: parseNumberField(payload.odometerMilesAtService, null),
      engineHoursAtService: parseNumberField(payload.engineHoursAtService, null),
      totalCost: parseNumberField(payload.totalCost, null),
      createdByUserId: sanitizeString(payload.createdByUserId || "", 80) || null
    };
    data.workOrders = Array.isArray(data.workOrders) ? data.workOrders : [];
    data.workOrders.unshift(order);
    await writeData(data);
    res.json({ ok: true, data: order });
  } catch (err) {
    next(err);
  }
});

app.get("/api/workorders/:id", async (req, res, next) => {
  try {
    const data = await readData();
    const order = (data.workOrders || []).find((w) => w.id === req.params.id);
    if (!order) return res.status(404).json({ error: "Work order not found" });
    res.json({ ok: true, data: order });
  } catch (err) {
    next(err);
  }
});

app.put("/api/workorders/:id", async (req, res, next) => {
  try {
    const data = await readData();
    const order = (data.workOrders || []).find((w) => w.id === req.params.id);
    if (!order) return res.status(404).json({ error: "Work order not found" });
    const payload = req.body || {};
    if (payload.status) order.status = sanitizeString(payload.status, 20);
    if (payload.complaint !== undefined) order.complaint = sanitizeString(payload.complaint || "", 2000);
    if (payload.diagnosis !== undefined) order.diagnosis = sanitizeString(payload.diagnosis || "", 2000);
    if (payload.repairActions !== undefined) order.repairActions = sanitizeString(payload.repairActions || "", 2000);
    if (payload.dtcCodes) order.dtcCodes = Array.isArray(payload.dtcCodes) ? payload.dtcCodes.map((c) => sanitizeString(c, 20)).filter(Boolean) : [];
    if (payload.odometerMilesAtService !== undefined) order.odometerMilesAtService = parseNumberField(payload.odometerMilesAtService, null);
    if (payload.engineHoursAtService !== undefined) order.engineHoursAtService = parseNumberField(payload.engineHoursAtService, null);
    if (payload.totalCost !== undefined) order.totalCost = parseNumberField(payload.totalCost, null);
    await writeData(data);
    res.json({ ok: true, data: order });
  } catch (err) {
    next(err);
  }
});

app.post("/api/workorders/:id/close", async (req, res, next) => {
  try {
    const data = await readData();
    const order = (data.workOrders || []).find((w) => w.id === req.params.id);
    if (!order) return res.status(404).json({ error: "Work order not found" });
    order.status = "closed";
    order.closedAt = nowIso();
    updatePatternSignature(data, order.vehicleId, "repair", 14, order.closedAt);
    await writeData(data);
    res.json({ ok: true, data: order });
  } catch (err) {
    next(err);
  }
});

app.get("/api/predictive/recommendations", async (req, res, next) => {
  try {
    const data = await readData();
    const orgId = sanitizeString(req.query.orgId || "", 80);
    const vehicleId = sanitizeString(req.query.vehicleId || "", 80);
    let list = Array.isArray(data.recommendations) ? data.recommendations : [];
    if (orgId) list = list.filter((r) => r.orgId === orgId);
    if (vehicleId) list = list.filter((r) => r.vehicleId === vehicleId);
    res.json({ ok: true, data: list });
  } catch (err) {
    next(err);
  }
});

app.get("/api/predictive/signals", async (req, res, next) => {
  try {
    const data = await readData();
    const orgId = sanitizeString(req.query.orgId || "", 80);
    const vehicleId = sanitizeString(req.query.vehicleId || "", 80);
    let list = Array.isArray(data.trendSignals) ? data.trendSignals : [];
    if (orgId) list = list.filter((s) => s.orgId === orgId);
    if (vehicleId) list = list.filter((s) => s.vehicleId === vehicleId);
    res.json({ ok: true, data: list });
  } catch (err) {
    next(err);
  }
});

app.get("/api/predictive/baselines", async (req, res, next) => {
  try {
    const data = await readData();
    const vehicleId = sanitizeString(req.query.vehicleId || "", 80);
    if (!vehicleId) {
      return res.json({ ok: true, data: [] });
    }
    const list = (data.baselines || []).filter((b) => b.vehicleId === vehicleId);
    res.json({ ok: true, data: list });
  } catch (err) {
    next(err);
  }
});

app.post("/api/predictive/recompute", requireApiToken, async (req, res, next) => {
  try {
    const vehicleId = sanitizeString(req.body?.vehicleId || "", 80);
    await runBaselineJob(true);
    await runPatternDetection(true);
    res.json({ ok: true, vehicleId: vehicleId || null });
  } catch (err) {
    next(err);
  }
});

if (!IS_PROD) {
  app.post("/api/dev/telemetry/simulate", async (req, res, next) => {
    try {
      const payload = req.body || {};
      const data = await readData();
      const fallbackVehicle = (data.vehicles || [])[0]?.vehicleId || "";
      const vehicleId = sanitizeString(payload.vehicleId || fallbackVehicle || "", 80);
      if (!vehicleId) {
        return res.status(400).json({ error: "vehicleId required (create a vehicle first)" });
      }
      const count = Math.min(Number(payload.count || 30), 120);
      const trend = sanitizeString(payload.trend || "normal", 40).toLowerCase();
      const orgId = resolveOrgIdForVehicle(data, vehicleId);
      const records = [];
      for (let i = 0; i < count; i += 1) {
        const ts = new Date(Date.now() - (count - i) * 60000).toISOString();
        const coolantBase = trend === "coolant_hot" ? 195 + i * 0.8 : 190 + Math.random() * 6;
        const batteryBase = trend === "battery_low" ? 12.2 - i * 0.02 : 13.6 + Math.random() * 0.3;
        const fuelEffBase = trend === "fuel_drop" ? 6.5 - i * 0.04 : 6.8 + Math.random() * 0.2;
        const payloads = [
          { key: "coolant_temp", value: coolantBase, unit: "F" },
          { key: "battery_voltage", value: batteryBase, unit: "V" },
          { key: "fuel_efficiency", value: fuelEffBase, unit: "mpg" },
          { key: "speed", value: 55 + Math.random() * 12, unit: "mph" },
          { key: "rpm", value: 1400 + Math.random() * 400, unit: "rpm" },
          { key: "fuel_level", value: 40 + Math.random() * 15, unit: "%" }
        ];
        payloads.forEach((field) => {
          records.push(
            normalizeTelemetryRecord({
              org_id: orgId,
              vehicle_id: vehicleId,
              timestamp: ts,
              protocol: "derived",
              identifier: field.key,
              name: field.key.replace(/_/g, " "),
              raw_value: field.value,
              normalized_value: field.value,
              unit: field.unit,
              source: "calculated",
              validity: "ok"
            })
          );
        });
      }
      storeTelemetryRecords(data, records);
      await writeData(data);
      triggerTelemetryPipeline();
      res.json({ ok: true, stored: records.length, vehicleId, trend });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/dev/reset-auth", async (req, res) => {
    if (IS_PROD || !DEV_SETUP) {
      return res.status(404).json({ ok: false, error: "not_found" });
    }
    try {
      const data = await readData();
      const { demoUsers, generatedPasswords } = buildDemoUsers();
      const result = await applyAuthStoreRepair(data, {
        demoUsers,
        resetPasswords: DEV_SETUP_RESET_PASSWORDS,
        defaultOrgId: "ORG_DEFAULT"
      });
      if (result.changed) {
        await writeData(result.data);
        logGeneratedPasswords("dev reset", result.report, generatedPasswords);
      }
      return res.json({ ok: true, users: demoUsers.map((u) => u.email), changed: result.changed });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message || "reset_failed" });
    }
  });
}

app.get("/api/insights/latest", (req, res) => {
  res.json({ insight: null });
});

app.post("/api/insights/generate", (req, res) => {
  res.json({ insight: null });
});

async function handleFleetAddonsGet(req, res, next) {
  try {
    const data = await readData();
    const fleetAddons = Object.assign({}, DEFAULT_DATA.fleetAddons, data.fleetAddons || {});
    res.json({
      ok: true,
      enabledAddons: fleetAddons.enabledAddons || {},
      trailerCount: fleetAddons.trailerCount || 0
    });
  } catch (err) {
    next(err);
  }
}

async function handleFleetAddonsPost(req, res, next) {
  try {
    const payload = req.body || {};
    const enabledAddons = payload.enabledAddons && typeof payload.enabledAddons === "object"
      ? payload.enabledAddons
      : {};
    const trailerCount = Number(payload.trailerCount || 0);
    const data = await readData();
    data.fleetAddons = {
      enabledAddons,
      trailerCount: Number.isFinite(trailerCount) && trailerCount >= 0 ? trailerCount : 0,
      updatedAt: nowIso()
    };
    addAudit(data, "FLEET_ADDONS_UPDATED", "addons");
    await writeData(data);
    res.json({ ok: true, data: data.fleetAddons });
  } catch (err) {
    next(err);
  }
}

async function handleFleetAddonsQuote(req, res, next) {
  try {
    const { addonId, notes, contact } = req.body || {};
    if (!addonId) {
      return res.status(400).json({ error: "addonId required." });
    }
    const data = await readData();
    const entry = {
      id: makeId("ADDON_QUOTE"),
      addonId,
      notes: typeof notes === "string" ? notes.slice(0, 1000) : "",
      contact: typeof contact === "string" ? contact.slice(0, 200) : "",
      createdAt: nowIso()
    };
    data.addonQuotes = Array.isArray(data.addonQuotes) ? data.addonQuotes : [];
    data.addonQuotes.unshift(entry);
    addAudit(data, "FLEET_ADDON_QUOTE", addonId);
    await writeData(data);
    res.json({ ok: true, data: entry });
  } catch (err) {
    next(err);
  }
}

app.get("/fleet/addons", handleFleetAddonsGet);
app.post("/fleet/addons", handleFleetAddonsPost);
app.post("/fleet/addons/request-quote", handleFleetAddonsQuote);
app.get("/api/fleet/addons", handleFleetAddonsGet);
app.post("/api/fleet/addons", handleFleetAddonsPost);
app.post("/api/fleet/addons/request-quote", handleFleetAddonsQuote);

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

function buildTelemetrySummary(context) {
  if (!context || !context.telemetryAvailable) {
    return "No live telemetry available yet.";
  }
  const snap = context.telemetrySnapshot || {};
  const parts = [];
  if (context.vehicleId) parts.push(`vehicle ${context.vehicleId}`);
  if (snap.speed !== undefined) parts.push(`speed ${snap.speed} mph`);
  if (snap.coolant_temp !== undefined) parts.push(`coolant ${snap.coolant_temp} F`);
  if (snap.fuel_level !== undefined) parts.push(`fuel ${snap.fuel_level}%`);
  if (snap.mileage !== undefined) parts.push(`mileage ${snap.mileage}`);
  return parts.length ? `Telemetry summary: ${parts.join(", ")}.` : "Live telemetry available, but no snapshot details were provided.";
}

function buildAdvisorFallback(message, context) {
  const summary = buildTelemetrySummary(context);
  const hasTelemetry = Boolean(context && context.telemetryAvailable);
  const reply = hasTelemetry
    ? `Based on the latest signal data, ${summary} Review recent alerts, confirm maintenance intervals, and prioritize units with rising coolant or fuel anomalies.`
    : "I do not have live telemetry yet. Start with a baseline inspection plan: check active alerts, confirm last service dates, and identify vehicles with recurring faults or upcoming PM windows.";
  const nextSteps = hasTelemetry
    ? [
        "Review active alerts and compare against the last 7 days.",
        "Flag any vehicles with coolant or fuel anomalies for inspection.",
        "Schedule follow-up diagnostics for repeated fault codes."
      ]
    : [
        "Connect a paired vehicle to begin live telemetry.",
        "Import recent maintenance history and alert logs.",
        "Identify your top 3 vehicles by downtime risk."
      ];
  return {
    ok: true,
    reply,
    basedOn: { telemetrySummary: summary },
    nextSteps,
    confidence: hasTelemetry ? "medium" : "low"
  };
}

function buildFleetAdvisorFallback(context) {
  const hasAnyData = Boolean(
    context &&
    (context.vehicles?.length || context.drivers?.length || context.alerts?.length || context.maintenance?.length)
  );
  if (!hasAnyData) {
    return {
      ok: true,
      reply: "I do not have fleet data yet. Create at least one vehicle and pair a device to begin telemetry ingestion. You can still log maintenance in the Maintenance tab.",
      nextSteps: [
        "Add vehicles and drivers.",
        "Generate a pairing code and connect a device.",
        "Start logging maintenance events going forward."
      ],
      confidence: "low"
    };
  }
  return {
    ok: true,
    reply: "I can help using current fleet records. If you need deeper answers, add telemetry data or select a specific vehicle so I can focus on its alerts and maintenance history.",
    nextSteps: [
      "Select a vehicle for more precise guidance.",
      "Review recent alerts and unresolved issues.",
      "Log maintenance events to build training-ready history."
    ],
    confidence: "medium"
  };
}

async function buildAdvisorContextForOrg(data, orgId, vehicleId) {
  const vehicles = (data.vehicles || []).filter((v) => !orgId || v.orgId === orgId);
  const drivers = (data.drivers || []).filter((d) => !orgId || d.orgId === orgId);
  const alerts = (data.events || []).filter((e) => !orgId || e.org_id === orgId).slice(0, 10);
  const maintenance = (data.maintenanceLogs || []).filter((m) => !orgId || m.orgId === orgId).slice(0, 10);
  const workOrders = (data.workOrders || []).filter((w) => !orgId || w.orgId === orgId).slice(0, 10);
  const targetVehicle = vehicleId
    ? vehicles.find((v) => v.vehicleId === vehicleId || v.id === vehicleId)
    : vehicles[0];
  const telemetryLatest = targetVehicle ? getLatestTelemetrySnapshot(data, targetVehicle.vehicleId) : null;
  const telemetrySummary = targetVehicle
    ? buildMetricsSnapshot(
        "coolant_temp",
        buildAggregateSnapshot(getTelemetryRecordsForVehicle(data, targetVehicle.vehicleId), TELEMETRY_ALIASES.coolant, Date.now(), COOLANT_OVERHEAT_THRESHOLD)
      )
    : null;
  return {
    vehicles,
    drivers,
    alerts,
    maintenance,
    workOrders,
    targetVehicle,
    telemetryLatest,
    telemetrySummary
  };
}

async function callAdvisorLLM(payload) {
  const response = await postJson("https://api.openai.com/v1/chat/completions", payload, {
    Authorization: `Bearer ${OPENAI_API_KEY}`
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error("AI upstream error");
  }
  const data = JSON.parse(response.body || "{}");
  const reply = data.choices?.[0]?.message?.content || "";
  if (!reply) {
    throw new Error("AI response missing");
  }
  return reply.trim();
}

app.get("/api/advisor/status", (req, res) => {
  res.json({ ok: true, enabled: aiEnabled(), model: OPENAI_MODEL || "none" });
});

app.post("/api/ai/chat", (req, res) => {
  const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const lastMessage = messages.length ? messages[messages.length - 1]?.content : "";
  const message = sanitizeString(req.body?.message || lastMessage || "", 2000);
  req.body = {
    message,
    context: req.body?.context || {}
  };
  req.url = "/api/advisor/message";
  app.handle(req, res);
});

app.post("/api/advisor/message", async (req, res) => {
  const message = sanitizeString(req.body?.message, 2000);
  const context = req.body?.context || {};
  if (!message) {
    return res.status(400).json({ error: "message required." });
  }
  if (!aiEnabled()) {
    return res.json(buildAdvisorFallback(message, context));
  }
  const summary = buildTelemetrySummary(context);
  const system = [
    "You are Fleet AI Advisor, a professional enterprise fleet operations assistant.",
    "Never invent telemetry or metrics. If data is missing, explain the limitation and provide a safe next step.",
    "Keep answers concise, actionable, and oriented to fleet operations.",
    `Context: ${summary}`
  ].join("\n");
  try {
    const payload = {
      model: OPENAI_MODEL,
      temperature: 0.2,
      messages: [
        { role: "system", content: system },
        { role: "user", content: message }
      ]
    };
    const response = await postJson("https://api.openai.com/v1/chat/completions", payload, {
      Authorization: `Bearer ${OPENAI_API_KEY}`
    });
    if (response.status < 200 || response.status >= 300) {
      return res.json(buildAdvisorFallback(message, context));
    }
    const data = JSON.parse(response.body || "{}");
    const reply = data.choices?.[0]?.message?.content || "";
    if (!reply) {
      return res.json(buildAdvisorFallback(message, context));
    }
    res.json({
      ok: true,
      reply: reply.trim(),
      basedOn: { telemetrySummary: summary },
      nextSteps: [
        "Review alert history for the last 7 days.",
        "Confirm maintenance windows for high-risk units.",
        "Follow up on any unresolved fault codes."
      ],
      confidence: "medium"
    });
  } catch (err) {
    res.json(buildAdvisorFallback(message, context));
  }
});

app.post("/api/ai/advisor", requireApiToken, async (req, res) => {
  const orgId = sanitizeString(req.body?.orgId || "", 80);
  const vehicleId = sanitizeString(req.body?.currentVehicleId || "", 80);
  const userQuestion = sanitizeString(req.body?.userQuestion || "", 2000);
  if (!userQuestion) {
    return res.status(400).json({ error: "userQuestion required." });
  }
  try {
    const data = await readData();
    const context = await buildAdvisorContextForOrg(data, orgId, vehicleId);
    if (!aiEnabled()) {
      return res.json(buildFleetAdvisorFallback(context));
    }
    const system = [
      "You are Fleet AI Advisor for fleet maintenance.",
      "Use the provided fleet data to answer.",
      "If data is missing, say what is missing and suggest next steps.",
      "Never claim certainty; use probabilistic language.",
      "If the user asks to log maintenance, respond with steps and suggest using the log feature."
    ].join(" ");
    const payload = {
      model: OPENAI_MODEL,
      temperature: 0.2,
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: JSON.stringify({
            question: userQuestion,
            vehicle: context.targetVehicle || null,
            telemetryLatest: context.telemetryLatest || null,
            telemetrySummary: context.telemetrySummary || null,
            recentAlerts: context.alerts,
            recentMaintenance: context.maintenance,
            openWorkOrders: context.workOrders
          })
        }
      ]
    };
    const reply = await callAdvisorLLM(payload);
    res.json({ ok: true, reply });
  } catch (err) {
    res.json(buildFleetAdvisorFallback({}));
  }
});

app.post("/api/ai/log-maintenance", requireApiToken, async (req, res) => {
  const orgId = sanitizeString(req.body?.orgId || "", 80);
  const vehicleId = sanitizeString(req.body?.vehicleId || "", 80);
  const naturalLanguage = sanitizeString(req.body?.naturalLanguage || "", 2000);
  if (!orgId || !vehicleId || !naturalLanguage) {
    return res.status(400).json({ error: "orgId, vehicleId, naturalLanguage required." });
  }
  try {
    const data = await readData();
    const vehicle = (data.vehicles || []).find((v) => v.vehicleId === vehicleId || v.id === vehicleId);
    if (!vehicle) return res.status(404).json({ error: "Vehicle not found." });
    let extracted = null;
    if (aiEnabled()) {
      const prompt = {
        model: OPENAI_MODEL,
        temperature: 0.1,
        messages: [
          {
            role: "system",
            content: [
              "Extract maintenance log fields from the text.",
              "Return JSON with keys: occurredAt, odometerMiles, engineHours, type, description, vendor, costTotal, partsUsed.",
              "type must be one of: oil_change, tire_rotation, brakes, coolant_service, transmission_service, inspection, repair, other.",
              "partsUsed must be an array of { partName, partNumber, qty, cost } when present."
            ].join(" ")
          },
          { role: "user", content: naturalLanguage }
        ]
      };
      const reply = await callAdvisorLLM(prompt);
      extracted = safeParseJson(reply);
    }
    const log = {
      id: makeId("MAINT"),
      orgId,
      vehicleId,
      occurredAt: parseIsoDate(extracted?.occurredAt || nowIso()),
      createdAt: nowIso(),
      odometerMiles: parseNumberField(extracted?.odometerMiles, null),
      engineHours: parseNumberField(extracted?.engineHours, null),
      type: normalizeMaintenanceType(extracted?.type || "other"),
      description: sanitizeString(extracted?.description || naturalLanguage, 2000),
      partsUsed: sanitizePartsList(extracted?.partsUsed || []),
      laborHours: null,
      vendor: sanitizeString(extracted?.vendor || "", 200),
      costTotal: parseNumberField(extracted?.costTotal, null),
      attachments: [],
      createdByUserId: null,
      source: "ai_advisor"
    };
    data.maintenanceLogs = Array.isArray(data.maintenanceLogs) ? data.maintenanceLogs : [];
    data.maintenanceLogs.unshift(log);
    await writeData(data);
    res.json({ ok: true, data: log });
  } catch (err) {
    res.status(500).json({ error: "Failed to log maintenance." });
  }
});

function sendEmployeeLoginResponse(res, status, body) {
  if (res.headersSent) return;
  res.status(status);
  res.setHeader("Content-Type", "application/json");
  return res.json(body);
}

async function handleEmployeeLogin(req, res) {
  const { email, password } = req.body || {};
  let step = "start";
  authLog(`[REQ] ${req.method} ${req.path}`);
  authLog(`[AUTH] login attempt ${email || "unknown"}`);
  try {
    const result = await authService.authenticate("employee", email, password);
    if (!result.ok) {
      if (
        !IS_PROD
        && DEV_SETUP
        && result.error.code === AUTH_ERRORS.INVALID_CREDENTIALS.code
        && password
        && password === DEV_SETUP_PASSWORD
      ) {
        const devLookup = await authService.getUserByEmail("employee", email);
        if (devLookup && devLookup.user) {
          const devSession = issueSession("employee", devLookup.user);
          setSessionCookie(res, devSession.id);
          return sendEmployeeLoginResponse(res, 200, {
            ok: true,
            success: true,
            token: devSession.id,
            user: {
              id: devLookup.user.id || null,
              email: devLookup.user.email,
              role: "employee",
              permissionRole: devLookup.user.role
            },
            redirect: "/employee-console.html"
          });
        }
      }
      if (result.error.code === AUTH_ERRORS.PASSWORD_SETUP_REQUIRED.code) {
        return sendEmployeeLoginResponse(res, result.error.status, {
          ok: false,
          success: false,
          code: result.error.code,
          setupToken: result.next.token,
          email: authService.normalizeEmail(email),
          message: result.error.message
        });
      }
      return sendEmployeeLoginResponse(res, result.error.status, {
        ok: false,
        success: false,
        code: result.error.code,
        message: result.error.message
      });
    }
    const session = result.session;
    setSessionCookie(res, session.id);
    return sendEmployeeLoginResponse(res, 200, {
      ok: true,
      success: true,
      token: session.id,
      user: {
        id: result.user.id || null,
        email: result.user.email,
        role: "employee",
        permissionRole: result.user.role
      },
      redirect: "/employee-console.html"
    });
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.log("[AUTH] login error", { step, message });
    return sendEmployeeLoginResponse(res, 500, formatAuthError(AUTH_ERRORS.SERVER_MISCONFIG, {
      message: "Server error"
    }));
  }
}

function handleEmployeeLoginRoute(req, res) {
  if (req.method !== "POST") {
    return sendEmployeeLoginResponse(res, 405, {
      ok: false,
      success: false,
      error: "Method not allowed"
    });
  }
  return handleEmployeeLogin(req, res);
}

app.all("/api/employee/login", handleEmployeeLoginRoute);
app.all("/api/login", handleEmployeeLoginRoute);
app.all("/api/employee-login", handleEmployeeLoginRoute);
app.all("/api/auth/employee/login", handleEmployeeLoginRoute);

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
  const result = getSessionFromRequest(req);
  if (!result) {
    return res.status(401).json({ ok: false, error: "Not authenticated." });
  }
  return res.json({
    ok: true,
    employee: {
      id: result.session.userId || null,
      email: result.session.email,
      role: result.session.role,
      loginRole: result.session.loginRole || "employee"
    }
  });
});

app.get("/api/employee/me", (req, res) => {
  req.url = "/api/employee/session";
  app.handle(req, res);
});
app.get("/api/employee/whoami", (req, res) => {
  const result = getSessionFromRequest(req);
  if (!result) {
    return res.status(401).json({ ok: false, error: "Not authenticated." });
  }
  return res.json({
    ok: true,
    employee: {
      id: result.session.userId || null,
      email: result.session.email,
      role: result.session.role,
      loginRole: result.session.loginRole || "employee"
    }
  });
});
app.get("/api/auth/session", (req, res) => {
  const session = getSession(req);
  if (!session) {
    return res.status(401).json({ error: "Not authenticated." });
  }
  return res.json({ authenticated: true, user: { id: session.userId || null, email: session.email, role: session.role } });
});

function collectRoutes() {
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
  return routes;
}

function routeExists(method, path) {
  return collectRoutes().some((route) => route.method === method.toUpperCase() && route.path === path);
}

let apiRoutesLogged = false;
function logApiRoutes() {
  if (apiRoutesLogged) return;
  apiRoutesLogged = true;
  const apiRoutes = collectRoutes()
    .filter((route) => route.path.startsWith("/api"))
    .map((route) => `${route.method} ${route.path}`)
    .sort();
  console.log(`[routes] registered /api endpoints (${apiRoutes.length})`);
  apiRoutes.forEach((route) => console.log(`[routes] ${route}`));
}

app.get("/api/diagnostics", (req, res) => {
  const baseUrl = process.env.FLEETAI_BASE_URL || `http://localhost:${PORT}`;
  const critical = [
    ["GET", "/api/health"],
    ["GET", "/api/diagnostics"],
    ["GET", "/api/diagnostics/routes"],
    ["POST", "/api/leads"],
    ["GET", "/api/orgs"],
    ["POST", "/api/orgs"],
    ["GET", "/api/leads"],
    ["POST", "/api/leads/apply-pilot"],
    ["POST", "/api/orgs/:orgId/create-customer-login"],
    ["POST", "/api/auth/login"],
    ["POST", "/api/auth/org/login"],
    ["POST", "/api/auth/reset-password"],
    ["POST", "/api/auth/org/reset-password"],
    ["POST", "/api/auth/password/update"],
    ["DELETE", "/api/orgs/:orgId"],
    ["GET", "/api/me"],
    ["GET", "/api/orgs/:orgId/public-profile"],
    ["POST", "/api/advisor/message"],
    ["POST", "/api/ai/chat"],
    ["POST", "/api/ai/advisor"],
    ["POST", "/api/ai/log-maintenance"],
    ["GET", "/api/alerts"],
    ["POST", "/api/telemetry/ingest"],
    ["GET", "/api/telemetry/latest"],
    ["GET", "/api/telemetry/window"],
    ["GET", "/api/telemetry/history"],
    ["GET", "/api/telemetry/summary"],
    ["GET", "/api/maintenance"],
    ["POST", "/api/maintenance"],
    ["GET", "/api/maintenance-logs"],
    ["POST", "/api/maintenance-logs"],
    ["GET", "/api/ml/state"],
    ["GET", "/api/ml/alerts"],
    ["POST", "/api/ml/recompute"],
    ["GET", "/api/workorders"],
    ["GET", "/api/orgs/:orgId/events"],
    ["GET", "/api/vehicles/:vehicleId/events"],
    ["GET", "/api/orgs/:orgId/notifications"],
    ["POST", "/api/billing/settings"],
    ["POST", "/api/billing/payment-method"],
    ["POST", "/api/fuel/manual"],
    ["POST", "/api/pairings/generate"],
    ["POST", "/api/pairings/claim"],
    ["GET", "/api/pairings/active"]
  ];
  const routeChecks = critical.map(([method, path]) => ({
    method,
    path,
    available: routeExists(method, path)
  }));
  res.json({
    ok: true,
    service: "fleet-ai",
    time: new Date().toISOString(),
    version: APP_VERSION,
    baseUrl,
    env: {
      NODE_ENV: process.env.NODE_ENV || "development",
      AI_ENABLED,
      SETUP_ALLOWED,
      PORT,
      ALERTS_ENABLED,
      OPENAI_EXPLANATIONS_ENABLED,
      API_TOKEN_SET: Boolean(API_TOKEN)
    },
    modules: {
      advisor: true,
      billing: true,
      employeeConsole: true,
      pairing: true,
      driverApp: true
    },
    routes: routeChecks
  });
});

app.get("/api/diagnostics/routes", (req, res) => {
  const routes = collectRoutes().filter((route) => route.path.startsWith("/api"));
  res.json({ ok: true, routes });
});

app.get("/api/debug/routes", (req, res) => {
  res.json({
    cwd: process.cwd(),
    dirname: __dirname,
    port: PORT,
    routes: collectRoutes()
  });
});

app.use("/api", (req, res) => {
  res.status(404).json({
    ok: false,
    error: "API route not found",
    path: req.originalUrl,
    method: req.method
  });
});

app.use((err, req, res, next) => {
  if (req.path.startsWith("/api")) {
    if (res.headersSent) return;
    const detail = err && err.message ? err.message : "Server error";
    const payload = { ok: false, error: "Server error" };
    if (process.env.NODE_ENV !== "production") {
      payload.detail = detail;
    }
    return res.status(500).json(payload);
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

validateJsonFile();
startTelemetryScheduler();

async function startServer() {
  await seedDevAuthStoreIfNeeded();
  verifyAuthStoreOrExit();
  app.listen(PORT, HOST, () => {
  const keyLen = SETUP_KEY.length;
  const keyMasked = keyLen >= 6
    ? `${SETUP_KEY.slice(0, 3)}***${SETUP_KEY.slice(-3)}`
    : keyLen > 0
      ? `${SETUP_KEY.slice(0, 1)}***`
      : "";
  console.log(`[env] __dirname=${__dirname}`);
  console.log(`[env] server.js path=${__filename}`);
  console.log(`[env] Node=${process.version}`);
  console.log(`[env] HOST=${HOST}`);
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
  const logStartupUsers = () => {
    readData().then((data) => {
      reportDataIntegrity(data);
      const usersCount = Array.isArray(data.users) ? data.users.length : 0;
      const orgsCount = Array.isArray(data.orgs) ? data.orgs.length : 0;
      console.log(`[DATA] loaded users=${usersCount} orgs=${orgsCount} from ${DATA_PATH}`);
      console.log(`[AUTH] startup users loaded=${usersCount} from ${DATA_PATH}`);
      if (usersCount === 0 || orgsCount === 0) {
        try {
          const stat = fs.statSync(DATA_PATH);
          console.warn(`[DATA] warning: users=${usersCount} orgs=${orgsCount} path=${DATA_PATH} size=${stat.size} mtime=${stat.mtime.toISOString()}`);
        } catch (err) {
          console.warn(`[DATA] warning: users=${usersCount} orgs=${orgsCount} path=${DATA_PATH} stat=unavailable`);
        }
      }
    }).catch((err) => {
      console.error("[AUTH] failed to load users on startup", err);
    });
  };
  runDevAuthRepair()
    .then(logStartupUsers)
    .catch((err) => {
      console.warn("[AUTH] dev repair failed", err && err.message ? err.message : err);
      logStartupUsers();
    });
  const ipv4List = getLanIPv4s();
  console.log(`Fleet AI listening on http://${HOST}:${PORT}`);
  if (ipv4List.length) {
    console.log(`Detected IPv4 addresses: ${ipv4List.join(", ")}`);
  }
  printNetworkHints(PORT);
  if (ipv4List.length) {
    console.log("Health URL(s):");
    ipv4List.forEach((ip) => console.log(`  http://${ip}:${PORT}/health`));
    console.log("Driver URL(s):");
    ipv4List.forEach((ip) => console.log(`  http://${ip}:${PORT}/driver`));
  }
  console.log(`Dashboard: http://localhost:${PORT}/ui/fleetai-dashboard.html`);
  console.log(`Home: http://localhost:${PORT}/`);
  console.log(`Pricing: http://localhost:${PORT}/pricing.html`);
  console.log(`Admin setup: http://localhost:${PORT}/admin/setup`);
  console.log(`Admin setup: http://localhost:${PORT}/admin/setup.html`);
  console.log(`Employee login: http://localhost:${PORT}/employee-login.html`);
  console.log(`Run: npm start (PowerShell: node .\\server.js)`);
  logApiRoutes();
  try {
    const baseUrl = `http://localhost:${PORT}`;
    watchdogInstance = startWatchdog({
      baseUrl,
      contractPath: path.join(__dirname, "spec", "config", "watchdog_contract.json"),
      logPath: path.join(__dirname, "server", "logs", "watchdog.log")
    });
    console.log("[WATCHDOG] started");
  } catch (err) {
    console.warn("[WATCHDOG] failed to start", err && err.message ? err.message : err);
  }
  console.log("PAIRING CLAIM ROUTES ENABLED:");
  [
    "POST /api/pairings/claim",
    "POST /api/pairing/claim",
    "POST /api/pairings/claim-device",
    "POST /api/pairing/claim-device",
    "POST /pairings/claim",
    "POST /pairing/claim"
  ].forEach((route) => console.log(`  ${route}`));
  });
}

startServer().catch((err) => {
  console.error("[server] failed to start", err && err.message ? err.message : err);
  process.exit(1);
});
