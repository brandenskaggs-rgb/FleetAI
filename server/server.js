if (require.main === module) {
  console.error("This server entry is deprecated. Use: npm start (node server.js) from repo root on port 3000.");
  process.exit(1);
}

const express = require("express");
const fs = require("fs");
const path = require("path");
const https = require("https");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const sqlite3 = require("sqlite3").verbose();

const app = express();
const PORT = process.env.PORT || 3001;
const DATA_PATH = path.join(__dirname, "data.json");
const PAIRING_EXPIRY_MINUTES = 10;
const DRIVER_PIN_EXPIRY_MINUTES = 10;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 20;
const rateState = new Map();
const EMPLOYEE_RATE_WINDOW_MS = 10 * 60 * 1000;
const EMPLOYEE_RATE_MAX = 5;
const EMPLOYEE_LOCK_MS = 15 * 60 * 1000;
const employeeRateState = new Map();

const SETUP_KEY = process.env.FLEETAI_SETUP_KEY || "";
const SESSION_SECRET = process.env.FLEETAI_SESSION_SECRET || "";
const EMPLOYEE_DB_PATH = path.join(__dirname, "..", "db", "employee.db");

const employeeDb = new sqlite3.Database(EMPLOYEE_DB_PATH);
initEmployeeDb();

function initEmployeeDb() {
  employeeDb.serialize(() => {
    employeeDb.run(
      `CREATE TABLE IF NOT EXISTS employees (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`
    );
  });
}

function employeeGetByEmail(email) {
  return new Promise((resolve, reject) => {
    employeeDb.get("SELECT * FROM employees WHERE email = ?", [email], (err, row) => {
      if (err) return reject(err);
      resolve(row || null);
    });
  });
}

function employeeCountSuperAdmin() {
  return new Promise((resolve, reject) => {
    employeeDb.get(
      "SELECT COUNT(1) as count FROM employees WHERE role = 'SUPER_ADMIN'",
      (err, row) => {
        if (err) return reject(err);
        resolve(row?.count || 0);
      }
    );
  });
}

function employeeCreate(email, passwordHash, role) {
  return new Promise((resolve, reject) => {
    const createdAt = new Date().toISOString();
    employeeDb.run(
      "INSERT INTO employees (email, password_hash, role, created_at) VALUES (?,?,?,?)",
      [email, passwordHash, role, createdAt],
      function onInsert(err) {
        if (err) return reject(err);
        resolve({ id: this.lastID, email, role, createdAt });
      }
    );
  });
}

function rateLimitEmployee(key) {
  const now = Date.now();
  const entry = employeeRateState.get(key) || {
    count: 0,
    resetAt: now + EMPLOYEE_RATE_WINDOW_MS,
    lockedUntil: 0
  };
  if (entry.lockedUntil && now < entry.lockedUntil) {
    return { allowed: false, locked: true };
  }
  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + EMPLOYEE_RATE_WINDOW_MS;
  }
  entry.count += 1;
  if (entry.count > EMPLOYEE_RATE_MAX) {
    entry.lockedUntil = now + EMPLOYEE_LOCK_MS;
    employeeRateState.set(key, entry);
    return { allowed: false, locked: true };
  }
  employeeRateState.set(key, entry);
  return { allowed: true, locked: false };
}

app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

app.use(
  session({
    name: "fleetai_employee_session",
    secret: SESSION_SECRET || cryptoRandomSecret(),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      // In production, serve over HTTPS and set secure cookies.
      secure: process.env.NODE_ENV === "production"
    }
  })
);

function cryptoRandomSecret() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function rateLimit(req, res, next) {
  const key = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "local";
  const now = Date.now();
  const entry = rateState.get(key) || { count: 0, resetAt: now + RATE_WINDOW_MS };
  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + RATE_WINDOW_MS;
  }
  entry.count += 1;
  rateState.set(key, entry);
  if (entry.count > RATE_MAX) {
    return res.status(429).json({ error: "Rate limit exceeded. Try again shortly." });
  }
  next();
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

function ensureDataFile() {
  if (!fs.existsSync(DATA_PATH)) {
    const initial = {
      tenantSettings: {
        companyName: "Fleet AI",
        logoUrl: "",
        themeMode: "blue",
        accentColor: ""
      },
      vehicles: [],
      drivers: [],
      pairings: []
    };
    fs.writeFileSync(DATA_PATH, JSON.stringify(initial, null, 2), "utf-8");
  }
}

function readData() {
  ensureDataFile();
  const raw = fs.readFileSync(DATA_PATH, "utf-8");
  return JSON.parse(raw);
}

function writeData(data) {
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), "utf-8");
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

app.get("/health", (req, res) => {
  res.json({ ok: true, ts: nowIso() });
});

app.get("/admin/setup", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "admin", "setup.html"));
});

function requireEmployee(req, res, next) {
  if (!req.session?.employee) {
    return res.redirect("/employee-login.html");
  }
  next();
}

app.get("/employee-portal.html", requireEmployee, (req, res) => {
  res.sendFile(path.join(__dirname, "..", "employee-portal.html"));
});

app.get("/api/employee/setup/status", async (req, res) => {
  try {
    const count = await employeeCountSuperAdmin();
    res.json({ enabled: count === 0 });
  } catch (err) {
    res.status(500).json({ error: "Setup status unavailable." });
  }
});

app.post("/api/employee/setup", async (req, res) => {
  const key = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "local";
  const rate = rateLimitEmployee(key);
  if (!rate.allowed) {
    return res.status(429).json({ error: "Too many attempts. Try again later." });
  }
  const { setupKey, email, password, confirmPassword } = req.body || {};
  if (!SETUP_KEY) {
    return res.status(503).json({ error: "Setup unavailable." });
  }
  try {
    const count = await employeeCountSuperAdmin();
    if (count > 0) {
      return res.status(403).json({ error: "Setup disabled. An administrator already exists." });
    }
    if (!setupKey || setupKey !== SETUP_KEY) {
      return res.status(401).json({ error: "Invalid credentials." });
    }
    if (!email || !email.includes("@")) {
      return res.status(400).json({ error: "Invalid credentials." });
    }
    if (!password || password.length < 10 || !/[0-9]/.test(password) || !/[A-Za-z]/.test(password)) {
      return res.status(400).json({ error: "Invalid credentials." });
    }
    if (password !== confirmPassword) {
      return res.status(400).json({ error: "Invalid credentials." });
    }
    const hash = await bcrypt.hash(password, 12);
    await employeeCreate(email.toLowerCase(), hash, "SUPER_ADMIN");
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Setup failed." });
  }
});

app.post("/api/employee/login", async (req, res) => {
  const key = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "local";
  const rate = rateLimitEmployee(key);
  if (!rate.allowed) {
    return res.status(429).json({ error: "Too many attempts. Try again later." });
  }
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: "Invalid credentials." });
  }
  try {
    const employee = await employeeGetByEmail(email.toLowerCase());
    if (!employee) {
      return res.status(401).json({ error: "Invalid credentials." });
    }
    const ok = await bcrypt.compare(password, employee.password_hash);
    if (!ok) {
      return res.status(401).json({ error: "Invalid credentials." });
    }
    req.session.employee = {
      id: employee.id,
      email: employee.email,
      role: employee.role
    };
    res.json({ ok: true, role: employee.role });
  } catch (err) {
    res.status(500).json({ error: "Login failed." });
  }
});
// Aliases for frontend variants
app.post("/api/auth/login", (req, res, next) => app._router.handle(req, res, next));
app.post("/api/login", (req, res, next) => app._router.handle(req, res, next));
app.post("/api/employee-login", (req, res, next) => app._router.handle(req, res, next));

app.post("/api/employee/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});
app.post("/api/auth/logout", (req, res, next) => app._router.handle(req, res, next));

app.get("/api/employee/session", (req, res) => {
  if (!req.session?.employee) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  res.json({ ok: true, employee: req.session.employee });
});
app.get("/api/auth/session", (req, res) => {
  if (!req.session?.employee) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  res.json({ authenticated: true, user: req.session.employee });
});

app.use(express.static(path.join(__dirname, "..")));

app.get("/tenants/settings", (req, res) => {
  const data = readData();
  res.json(data.tenantSettings || {});
});

app.post("/tenants/settings", (req, res) => {
  const { companyName, logoUrl, themeMode, accentColor } = req.body || {};
  if (!companyName || typeof companyName !== "string") {
    return res.status(400).json({ error: "companyName required" });
  }
  const data = readData();
  data.tenantSettings = {
    companyName,
    logoUrl: typeof logoUrl === "string" ? logoUrl : "",
    themeMode: typeof themeMode === "string" ? themeMode : "blue",
    accentColor: typeof accentColor === "string" ? accentColor : ""
  };
  writeData(data);
  res.json(data.tenantSettings);
});

app.get("/vehicles", (req, res) => {
  const data = readData();
  res.json(data.vehicles || []);
});

app.post("/vehicles/create", (req, res) => {
  const { vehicleId, unitName, vin, type } = req.body || {};
  if (!vehicleId || !unitName || !vin || !type) {
    return res.status(400).json({ error: "vehicleId, unitName, vin, type required" });
  }
  const data = readData();
  if (data.vehicles.find((v) => v.vehicleId === vehicleId)) {
    return res.status(409).json({ error: "Vehicle already exists" });
  }
  const vehicle = {
    vehicleId,
    unitName,
    vin,
    type,
    createdAt: nowIso()
  };
  data.vehicles.push(vehicle);
  writeData(data);
  res.json(vehicle);
});

app.get("/drivers", (req, res) => {
  const data = readData();
  res.json(data.drivers || []);
});

app.post("/drivers/create", (req, res) => {
  const { firstName, lastName, phone } = req.body || {};
  if (!firstName || !lastName || !phone) {
    return res.status(400).json({ error: "firstName, lastName, phone required" });
  }
  const data = readData();
  const driverId = `DRIVER_${generateDigits(5)}`;
  const driver = {
    driverId,
    firstName,
    lastName,
    phone,
    createdAt: nowIso()
  };
  data.drivers.push(driver);
  writeData(data);
  res.json({ driverId });
});

app.post("/auth/driverLogin", (req, res) => {
  const { companyCode, driverPin } = req.body || {};
  if (!companyCode || !driverPin) {
    return res.status(400).json({ error: "companyCode and driverPin required" });
  }
  const data = readData();
  const pairing = (data.pairings || []).find((p) => p.driverPin === driverPin);
  if (!pairing) {
    return res.status(401).json({ error: "Invalid PIN" });
  }
  if (isExpired(pairing.driverPinExpiresAt) || isExpired(pairing.expiresAt)) {
    pairing.status = "expired";
    writeData(data);
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
});

app.post("/pairings/generate", (req, res) => {
  const { vehicleId, driverId } = req.body || {};
  if (!vehicleId || !driverId) {
    return res.status(400).json({ error: "vehicleId and driverId required" });
  }
  const data = readData();
  const vehicle = data.vehicles.find((v) => v.vehicleId === vehicleId);
  const driver = data.drivers.find((d) => d.driverId === driverId);
  if (!vehicle || !driver) {
    return res.status(404).json({ error: "Vehicle or driver not found" });
  }
  const pairingCode = generatePairingCode();
  const driverPin = generateDriverPin();
  const expiresAt = new Date(Date.now() + PAIRING_EXPIRY_MINUTES * 60000).toISOString();
  const driverPinExpiresAt = new Date(Date.now() + DRIVER_PIN_EXPIRY_MINUTES * 60000).toISOString();
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
  writeData(data);
  res.json({ pairingCode, expiresAt, driverPin, driverPinExpiresAt });
});

app.post("/pairings/claim", (req, res) => {
  const { pairingCode, deviceId, deviceLabel } = req.body || {};
  if (!pairingCode || !deviceId || !deviceLabel) {
    return res.status(400).json({ error: "pairingCode, deviceId, deviceLabel required" });
  }
  const data = readData();
  const pairing = data.pairings.find((p) => p.pairingCode === pairingCode);
  if (!pairing) {
    return res.status(404).json({ error: "Invalid code" });
  }
  if (pairing.status !== "pending") {
    return res.status(409).json({ error: "Code already used" });
  }
  if (isExpired(pairing.expiresAt) || isExpired(pairing.driverPinExpiresAt)) {
    pairing.status = "expired";
    writeData(data);
    return res.status(410).json({ error: "Expired code" });
  }
  pairing.status = "active";
  pairing.deviceId = deviceId;
  pairing.deviceLabel = deviceLabel;
  pairing.claimedAt = nowIso();
  pairing.lastSeen = nowIso();
  writeData(data);
  res.json({
    vehicleId: pairing.vehicleId,
    driverId: pairing.driverId,
    status: pairing.status
  });
});

app.get("/pairings/active", (req, res) => {
  const data = readData();
  const now = Date.now();
  (data.pairings || []).forEach((p) => {
    if (p.status === "pending" && p.expiresAt) {
      const expired = new Date(p.expiresAt).getTime() <= now;
      if (expired) {
        p.status = "expired";
      }
    }
    if (p.driverPinExpiresAt) {
      const pinExpired = new Date(p.driverPinExpiresAt).getTime() <= now;
      if (pinExpired && p.status !== "expired") {
        p.status = "expired";
      }
    }
  });
  writeData(data);
  res.json(data.pairings || []);
});

app.post("/api/ai/chat", rateLimit, async (req, res) => {
  if (!OPENAI_API_KEY) {
    return res.status(500).json({ error: "OPENAI_API_KEY is not configured." });
  }

  const incoming = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const safeMessages = incoming
    .filter((m) => m && typeof m.content === "string")
    .map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content.slice(0, 4000)
    }))
    .slice(-16);

  const context = req.body?.context || {};
  const contextLines = [];
  if (context.vehicleId) contextLines.push(`Selected vehicle: ${context.vehicleId}.`);
  if (context.vehiclesCount) contextLines.push(`Known vehicles in fleet: ${context.vehiclesCount}.`);
  const contextBlock = contextLines.length
    ? `Context:\n${contextLines.join("\n")}`
    : "Context: No fleet data provided.";

  const system = [
    "You are Fleet AI Advisor, a professional enterprise fleet operations assistant.",
    "You provide risk-based guidance, planning suggestions, and operational checklists.",
    "Never invent fleet telemetry or metrics. If data is missing, say 'insufficient data' and ask a clarifying question.",
    "Do not claim certainty or guarantees. Use calm, professional language.",
    "Keep answers concise and actionable (bullets preferred).",
    contextBlock
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

app.listen(PORT, () => {
  console.log(`Fleet AI server listening on http://localhost:${PORT}`);
});
