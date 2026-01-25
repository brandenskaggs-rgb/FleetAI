const http = require("http");
const https = require("https");

const BASE = (process.env.FLEETAI_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
const EMAIL = process.env.FLEETAI_SMOKE_EMAIL || "";
const PASSWORD = process.env.FLEETAI_SMOKE_PASSWORD || "";

function requestJson(url, options = {}) {
  const target = new URL(url);
  const lib = target.protocol === "https:" ? https : http;
  const headers = Object.assign({}, options.headers || {});
  const payload = options.body ? JSON.stringify(options.body) : null;
  if (payload) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = Buffer.byteLength(payload);
  }
  if (options.cookie) headers.Cookie = options.cookie;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        method: options.method || "GET",
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        headers
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          let json = null;
          try {
            json = data ? JSON.parse(data) : {};
          } catch (err) {
            return resolve({ status: res.statusCode, headers: res.headers, text: data, json: null, parseError: err.message });
          }
          return resolve({ status: res.statusCode, headers: res.headers, text: data, json });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function getCookieFromHeaders(headers) {
  const setCookie = headers["set-cookie"];
  if (!setCookie || !setCookie.length) return "";
  return setCookie.map((c) => c.split(";")[0]).join("; ");
}

async function main() {
  console.log(`[smoke] base=${BASE}`);
  const health = await requestJson(`${BASE}/health`);
  console.log(`[smoke] /health ${health.status}`);
  const pairingHealth = await requestJson(`${BASE}/api/pairing/health`);
  console.log(`[smoke] /api/pairing/health ${pairingHealth.status}`);
  const whoami = await requestJson(`${BASE}/api/auth/whoami`);
  console.log(`[smoke] /api/auth/whoami ${whoami.status}`);

  if (!EMAIL || !PASSWORD) {
    console.log("[smoke] skip login/pairing (set FLEETAI_SMOKE_EMAIL and FLEETAI_SMOKE_PASSWORD)");
    return;
  }

  const login = await requestJson(`${BASE}/api/auth/org/login`, {
    method: "POST",
    body: { email: EMAIL, password: PASSWORD }
  });
  console.log(`[smoke] login ${login.status}`);
  if (!login.json || !login.json.ok) {
    console.error("[smoke] login failed", login.json || login.text);
    process.exit(1);
  }

  const cookie = getCookieFromHeaders(login.headers);
  const vehicles = await requestJson(`${BASE}/api/vehicles`, { cookie });
  const drivers = await requestJson(`${BASE}/api/drivers`, { cookie });
  const vehicleId = vehicles.json?.[0]?.vehicleId;
  const driverId = drivers.json?.[0]?.driverId;
  if (!vehicleId || !driverId) {
    console.warn("[smoke] missing vehicle/driver data, skipping pairing generate");
    return;
  }

  const pairing = await requestJson(`${BASE}/api/pairing/generate`, {
    method: "POST",
    body: { vehicleId, driverId },
    cookie
  });
  console.log(`[smoke] pairing generate ${pairing.status}`);
  if (pairing.status >= 400 && pairing.status !== 409) {
    console.error("[smoke] pairing generate failed", pairing.json || pairing.text);
    process.exit(1);
  }
  if (pairing.status === 200 && pairing.json && pairing.json.ok !== true) {
    console.error("[smoke] pairing generate ok=false", pairing.json);
    process.exit(1);
  }
  console.log("[smoke] pairing response", pairing.json || pairing.text);

  const conflict = await requestJson(`${BASE}/api/pairing/generate`, {
    method: "POST",
    body: { vehicleId, driverId },
    cookie
  });
  console.log(`[smoke] pairing conflict ${conflict.status}`);
  if (conflict.status !== 409) {
    console.error("[smoke] expected conflict 409 but got", conflict.status, conflict.json || conflict.text);
    process.exit(1);
  }
  console.log("[smoke] pairing conflict response", conflict.json || conflict.text);
}

main().catch((err) => {
  console.error("[smoke] error", err.message || err);
  process.exit(1);
});
