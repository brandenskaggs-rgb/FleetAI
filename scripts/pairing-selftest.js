const http = require("http");
const https = require("https");

function request(url, method = "GET", body = null, cookie = "") {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === "https:" ? https : http;
    const payload = body ? JSON.stringify(body) : "";
    const headers = { Accept: "application/json" };
    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(payload);
    }
    if (cookie) headers.Cookie = cookie;
    const req = client.request({
      method,
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      headers
    }, (res) => {
      let raw = "";
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => {
        let json = null;
        try { json = raw ? JSON.parse(raw) : {}; } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, json, raw });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function cookieFrom(response) {
  const values = response.headers["set-cookie"] || [];
  return values.map((value) => value.split(";")[0]).join("; ");
}

function requireStatus(response, expected, label) {
  if (response.status !== expected) {
    throw new Error(`${label} returned ${response.status}: ${response.json?.error || "unexpected_response"}`);
  }
}

(async () => {
  const base = (process.env.FLEETAI_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
  const email = process.env.FLEETAI_SMOKE_EMAIL || process.env.CUSTOMER_EMAIL || "";
  const password = process.env.FLEETAI_SMOKE_PASSWORD || process.env.CUSTOMER_PASSWORD || "";
  if (!email || !password) throw new Error("Set FLEETAI_SMOKE_EMAIL and FLEETAI_SMOKE_PASSWORD");

  const login = await request(`${base}/api/auth/customer/login`, "POST", { email, password });
  requireStatus(login, 200, "customer login");
  const cookie = cookieFrom(login);
  if (!cookie) throw new Error("customer login did not issue a session cookie");

  const [vehiclesResponse, driversResponse] = await Promise.all([
    request(`${base}/api/vehicles`, "GET", null, cookie),
    request(`${base}/api/drivers`, "GET", null, cookie)
  ]);
  requireStatus(vehiclesResponse, 200, "vehicle list");
  requireStatus(driversResponse, 200, "driver list");
  const vehicleId = vehiclesResponse.json?.[0]?.vehicleId;
  const driverId = driversResponse.json?.[0]?.driverId;
  if (!vehicleId || !driverId) throw new Error("The customer organization needs at least one vehicle and driver");

  const generated = await request(`${base}/api/pairings/generate`, "POST", { vehicleId, driverId }, cookie);
  requireStatus(generated, 200, "pairing generation");
  const pairingCode = generated.json?.pairingCode;
  const driverPin = generated.json?.driverPin;
  if (!pairingCode || !driverPin) throw new Error("pairing generation omitted the code or driver PIN");

  const missingPin = await request(`${base}/api/pairings/claim`, "POST", {
    pairingCode,
    deviceId: "SELFTEST_DEVICE_MISSING_PIN",
    deviceLabel: "Self-test"
  });
  requireStatus(missingPin, 401, "claim without PIN");
  if (missingPin.json?.error !== "PIN_REQUIRED") throw new Error("claim without PIN did not return PIN_REQUIRED");

  const claim = await request(`${base}/api/pairings/claim`, "POST", {
    pairingCode,
    driverPin,
    deviceId: "SELFTEST_DEVICE",
    deviceLabel: "Self-test"
  });
  requireStatus(claim, 200, "pairing claim");
  if (!claim.json?.deviceToken) throw new Error("pairing claim did not issue a device token");

  const sameDevice = await request(`${base}/api/pairings/claim`, "POST", {
    pairingCode,
    driverPin,
    deviceId: "SELFTEST_DEVICE",
    deviceLabel: "Self-test repeat"
  });
  requireStatus(sameDevice, 200, "same-device claim");

  const otherDevice = await request(`${base}/api/pairings/claim`, "POST", {
    pairingCode,
    driverPin,
    deviceId: "SELFTEST_OTHER_DEVICE",
    deviceLabel: "Self-test conflict"
  });
  requireStatus(otherDevice, 409, "different-device claim");

  console.log("[pairing-selftest] PASS: authenticated generation, PIN enforcement, claim, idempotency, conflict");
})().catch((err) => {
  console.error("[pairing-selftest] FAIL:", err.message);
  process.exitCode = 1;
});
