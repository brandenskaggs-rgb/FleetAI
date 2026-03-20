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
const { registerSystemStatusRoutes } = require("./server/routes/systemStatus");
const { registerLegacyPairingRoutes } = require("./server/routes/legacyPairing");
const { registerAuthRoutes } = require("./server/routes/authRoutes");
const { registerFleetOpsRoutes } = require("./server/routes/fleetOpsRoutes");
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
app.disable("x-powered-by");
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
const COOKIE_SAMESITE = (process.env.COOKIE_SAMESITE || (IS_PROD ? "Lax" : "Lax")).trim();
const COOKIE_SECURE = process.env.COOKIE_SECURE === "true"
  || IS_PROD;
const CORS_ALLOWED_ORIGINS = parseOriginList(process.env.CORS_ALLOWED_ORIGINS || "");
const TRUST_PROXY = resolveTrustProxySetting(process.env.TRUST_PROXY, IS_PROD);
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

function parseOriginList(value) {
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function resolveTrustProxySetting(value, isProd) {
  const raw = String(value || "").trim();
  if (!raw) {
    return isProd ? "loopback, linklocal, uniquelocal" : false;
  }
  if (["true", "false"].includes(raw.toLowerCase())) {
    return raw.toLowerCase() === "true";
  }
  if (/^\d+$/.test(raw)) {
    return Number(raw);
  }
  return raw;
}

function isOriginAllowed(origin) {
  if (!origin) return true;
  if (!IS_PROD) return true;
  if (!CORS_ALLOWED_ORIGINS.length) return false;
  return CORS_ALLOWED_ORIGINS.includes(origin);
}

function isTrustedBrowserOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (!IS_PROD) return true;
  if (isOriginAllowed(origin)) return true;
  const host = req.headers.host;
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch (err) {
    return false;
  }
}

function requireTrustedBrowserOrigin(req, res, next) {
  const method = String(req.method || "GET").toUpperCase();
  if (["GET", "HEAD", "OPTIONS"].includes(method)) {
    return next();
  }
  if (isTrustedBrowserOrigin(req)) {
    return next();
  }
  return res.status(403).json({ ok: false, error: "Untrusted browser origin." });
}

function applySecurityHeaders(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()" );
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  if (IS_PROD) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
}

function validateRuntimeConfig() {
  const errors = [];
  const warnings = [];
  const insecureDevPasswords = [
    process.env.ADMIN_PASSWORD,
    process.env.EMPLOYEE_PASSWORD,
    process.env.CUSTOMER_PASSWORD,
    process.env.DEV_SETUP_PASSWORD
  ].filter(Boolean);

  if (IS_PROD) {
    if (!process.env.FLEETAI_SESSION_SECRET || String(process.env.FLEETAI_SESSION_SECRET).trim().length < 32) {
      errors.push("FLEETAI_SESSION_SECRET must be set to a strong value (32+ chars) in production.");
    }
    if (DEV_SETUP || DEV_SETUP_MODE || DEV_SETUP_RESET_PASSWORDS) {
      errors.push("DEV_SETUP, DEV_SETUP_MODE, and DEV_SETUP_RESET_PASSWORDS must all be false in production.");
    }
    if (SETUP_ALLOWED) {
      warnings.push("FLEETAI_ALLOW_SETUP is enabled in production. Disable it after initial bootstrap.");
    }
    if (!CORS_ALLOWED_ORIGINS.length) {
      warnings.push("CORS_ALLOWED_ORIGINS is empty in production; cross-origin browser access will be denied until explicitly configured.");
    }
    if (COOKIE_SAMESITE.toLowerCase() === "none" && !COOKIE_SECURE) {
      errors.push("COOKIE_SECURE must be true when COOKIE_SAMESITE=None.");
    }
    if (insecureDevPasswords.length) {
      warnings.push("Development/bootstrap password environment variables are present. Remove them from production after provisioning.");
    }
  }

  return { errors, warnings };
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

app.set("trust proxy", TRUST_PROXY);
app.use(applySecurityHeaders);
const corsOptions = {
  origin(origin, callback) {
    if (isOriginAllowed(origin)) {
      return callback(null, true);
    }
    return callback(new Error("CORS origin denied"));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-FleetAI-Token"]
};
app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));
app.use(requireTrustedBrowserOrigin);
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
  setNoStore(res);
  const session = getCustomerSession(req);
  console.log("[CUST-DASH] request", {
    hasCookieHeader: Boolean(req.headers.cookie),
    cookieNames: Object.keys(parseCookies(req.headers.cookie || "")),
    hasCustomerCookie: Boolean(parseCookies(req.headers.cookie || "")[CUSTOMER_SESSION_COOKIE]),
    sessionFound: Boolean(session),
    sessionUserId: session?.userId || null,
    sessionEmail: session?.email || null,
    ua: req.headers["user-agent"] || "",
    referer: req.headers.referer || ""
  });
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

const SYSTEM_STATUS_ROUTE_MANIFEST = [
  "/health",
  "/api/health",
  "/api/auth/health",
  "/version",
  "/whoami",
  "/api/admin/config-status",
  "/api/system/watchdog",
  "/api/system/telemetry/status",
  "/api/system/pairing/status"
];

registerSystemStatusRoutes(app, {
  healthPayload,
  readData,
  DATA_PATH,
  SETUP_ALLOWED,
  SETUP_KEY,
  requireSuperAdmin: (req, res, next) => requireSuperAdmin(req, res, next),
  getDataLoadStatus: () => ({ dataLoadStatus, lastDataLoadAt }),
  getDataLoadError: () => dataLoadError,
  getDataLoadNote: () => dataLoadNote,
  getLastDataWriteAt: () => lastDataWriteAt,
  DATA_SCHEMA_VERSION,
  APP_VERSION,
  getWatchdogInstance: () => watchdogInstance,
  getTelemetryLastSeen: () => telemetryLastSeen,
  getTelemetryState: () => telemetryState,
  getTelemetryLatestSize: () => telemetryLatest.size,
  getTelemetryLatestEntries: () => Array.from(telemetryLatest.entries()),
  nowIso,
  isExpired
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
const PAIRING_ROUTE_MANIFEST = [
  "/api/pairings/health",
  "/api/pairing/health",
  "/api/pairings/debug",
  "/pairings/generate",
  "/api/pairings/generate",
  "/api/pairing/generate",
  "/api/pair-code",
  "/api/pair-code/generate",
  "/api/pair-code/replace",
  "/api/pair-code/:pairId/expire",
  "/api/pair-code/expire-and-generate",
  "/pairings/claim",
  "/api/pairings/claim",
  "/api/pairing/claim",
  "/pairing/claim",
  "/api/pairings/claim-device",
  "/api/pairing/claim-device",
  "/pairing/claim-device",
  "/pairings/active",
  "/api/pairings/active",
  "/auth/driverLogin",
  "/api/auth/driverLogin",
  "/api/pairing/create",
  "/api/pairing/activate",
  "/api/pairing/status"
];

registerLegacyPairingRoutes(app, {
  readData,
  writeData,
  requireEmployeeOrCustomerApi: (req, res, next) => requireEmployeeOrCustomerApi(req, res, next),
  sanitizeString,
  nowIso,
  makeId,
  generateDigits,
  generateDriverPin,
  isExpired,
  normalizeMetrics,
  storeNormalizedSnapshot,
  triggerTelemetryPipeline,
  resolveOrgIdForVehicle,
  telemetryLatest,
  lastDataWriteAtRef: () => lastDataWriteAt,
  createPairingRouter,
  pairingRouterDeps: {
    storage: { loadData: readData, saveData: writeData },
    requireAuth: requireEmployeeOrCustomerApi,
    log: (...args) => console.log(...args)
  },
  log: (...args) => console.log(...args)
});


const FLEET_OPS_ROUTE_MANIFEST = [
  "/api/vehicles",
  "/api/orgs/:orgId/vehicles",
  "/api/orgs/:orgId/vehicles/:vehicleId",
  "/api/drivers",
  "/api/orgs/:orgId/drivers",
  "/api/orgs/:orgId/drivers/:driverId",
  "/api/pairing/options",
  "/api/telemetry",
  "/api/telemetry/latest",
  "/api/telemetry/stream",
  "/api/telemetry/active",
  "/api/telemetry/health"
];

registerFleetOpsRoutes(app, {
  readData,
  writeData,
  sanitizeString,
  parseNumberField,
  nowIso,
  makeId,
  generateDigits,
  addAudit,
  requireEmployeeOrCustomerApi: (req, res, next) => requireEmployeeOrCustomerApi(req, res, next),
  resolveOrgIdForVehicle,
  telemetryLatest,
  telemetrySubscribers,
  getTelemetryLastSeen: () => telemetryLastSeen,
  getTelemetryState: () => telemetryState,
  triggerTelemetryPipeline,
  storeNormalizedSnapshot,
  normalizeMetrics
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
  if (!cookieSession) return null;
  return { session: cookieSession, source: "cookie" };
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

function setNoStore(res) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");
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
  return session;
}

function requireEmployeeSession(req, res, next) {
  const result = getSessionFromRequest(req);
  if (!result) {
    return res.redirect("/employee-login.html");
  }
  req.employee = result.session;
  next();
}

function formatAuthResponse({ ok, code, message, session = null, next = null }) {
  return { ok, code, message, next, session };
}

function sendEmployeeLoginResponse(res, status, body) {
  if (res.headersSent) return;
  res.status(status);
  res.setHeader("Content-Type", "application/json");
  return res.json(body);
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

app.get("/api/org/billing", requireCustomerApi, async (req, res, next) => {
  try {
    const data = await readData();
    const billing = Object.assign({}, defaultBillingSettings(data), data.orgBillingSettings || {});
    res.json({ ok: true, data: billing });
  } catch (err) {
    next(err);
  }
});

app.post("/api/org/billing", requireCustomerApi, async (req, res, next) => {
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

app.get("/api/org/billing-settings", requireCustomerApi, async (req, res, next) => {
  try {
    const data = await readData();
    const billing = Object.assign({}, defaultBillingSettings(data), data.orgBillingSettings || {});
    res.json({ ok: true, data: billing });
  } catch (err) {
    next(err);
  }
});

app.post("/api/org/billing-settings", requireCustomerApi, async (req, res, next) => {
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

app.get("/api/org/payment-method", requireCustomerApi, async (req, res, next) => {
  try {
    const data = await readData();
    const payment = Object.assign({}, defaultPaymentMethod(), data.paymentMethod || {});
    res.json({ ok: true, data: payment });
  } catch (err) {
    next(err);
  }
});

app.post("/api/org/payment-method", requireCustomerApi, async (req, res, next) => {
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

const AUTH_ROUTE_MANIFEST = [
  "/api/auth/org/login",
  "/api/auth/customer/login",
  "/api/auth/login",
  "/api/auth/login-customer",
  "/api/customer/login",
  "/api/auth/customer/session",
  "/api/auth/whoami",
  "/api/me",
  "/api/auth/reset-password",
  "/api/auth/org/reset-password",
  "/api/auth/password/update",
  "/api/auth/customer/logout",
  "/api/employee/login",
  "/api/login",
  "/api/employee-login",
  "/api/auth/employee/login",
  "/api/employee/logout",
  "/api/auth/logout",
  "/api/employee/session",
  "/api/employee/me",
  "/api/employee/whoami",
  "/api/auth/session"
];

registerAuthRoutes(app, {
  authLog,
  readData,
  restoreUsersIfEmpty,
  ensureBootstrapCustomer,
  authService,
  IS_PROD,
  DEV_SETUP,
  DEV_SETUP_PASSWORD,
  AUTH_ERRORS,
  issueSession,
  setCustomerSessionCookie,
  setSessionCookie,
  sendEmployeeLoginResponse,
  formatAuthError,
  setNoStore,
  requireCustomerApi: (req, res, next) => requireCustomerApi(req, res, next),
  getCustomerSession,
  clearCustomerSessionCookie,
  customerSessionStore,
  getSessionFromRequest,
  getSession,
  clearSessionCookie,
  sessionStore,
  bcrypt,
  nowIso,
  sanitizeString
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
  const runtimeConfig = validateRuntimeConfig();
  runtimeConfig.warnings.forEach((warning) => console.warn(`[config] ${warning}`));
  if (runtimeConfig.errors.length) {
    runtimeConfig.errors.forEach((error) => console.error(`[config] ${error}`));
    throw new Error("Refusing to start with unsafe production configuration.");
  }
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
  console.log(`[env] TRUST_PROXY=${JSON.stringify(TRUST_PROXY)}`);
  console.log(`[env] CORS_ALLOWED_ORIGINS=${CORS_ALLOWED_ORIGINS.length ? CORS_ALLOWED_ORIGINS.join(",") : "<same-origin-only>"}`);
  console.log(`[env] COOKIE_SAMESITE=${COOKIE_SAMESITE}`);
  console.log(`[env] COOKIE_SECURE=${COOKIE_SECURE}`);
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
