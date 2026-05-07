const http = require("http");
const https = require("https");

const BASE = (process.env.FLEETAI_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
const EMAIL = process.env.FLEETAI_SMOKE_EMAIL || "";
const PASSWORD = process.env.FLEETAI_SMOKE_PASSWORD || "";
const CREATE_FIXTURES = process.env.FLEETAI_SMOKE_CREATE_FIXTURES === "1";
const SMOKE_VEHICLE_ID = process.env.FLEETAI_SMOKE_VEHICLE_ID || "VEH_SMOKE_001";
const SMOKE_DRIVER_ID = process.env.FLEETAI_SMOKE_DRIVER_ID || "DRV_SMOKE_001";

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
  let vehicles = await requestJson(`${BASE}/api/vehicles`, { cookie });
  let drivers = await requestJson(`${BASE}/api/drivers`, { cookie });
  let vehicleId = vehicles.json?.[0]?.vehicleId;
  let driverId = drivers.json?.[0]?.driverId;
  if (!vehicleId || !driverId) {
    if (!CREATE_FIXTURES) {
      console.warn("[smoke] missing vehicle/driver data, skipping pairing generate");
      console.warn("[smoke] set FLEETAI_SMOKE_CREATE_FIXTURES=1 to create deterministic smoke fixtures");
      return;
    }
    if (!vehicleId) {
      const createdVehicle = await requestJson(`${BASE}/api/vehicles`, {
        method: "POST",
        body: {
          vehicleId: SMOKE_VEHICLE_ID,
          unitName: "Smoke Test Unit",
          vin: "1FTFW1ET0DFC00001",
          type: "truck"
        },
        cookie
      });
      if (createdVehicle.status >= 400 && createdVehicle.status !== 409) {
        console.error("[smoke] vehicle fixture create failed", createdVehicle.json || createdVehicle.text);
        process.exit(1);
      }
    }
    if (!driverId) {
      const createdDriver = await requestJson(`${BASE}/api/drivers`, {
        method: "POST",
        body: {
          driverId: SMOKE_DRIVER_ID,
          firstName: "Smoke",
          lastName: "Driver",
          phone: "555-0100"
        },
        cookie
      });
      if (createdDriver.status >= 400 && createdDriver.status !== 409) {
        console.error("[smoke] driver fixture create failed", createdDriver.json || createdDriver.text);
        process.exit(1);
      }
    }
    vehicles = await requestJson(`${BASE}/api/vehicles`, { cookie });
    drivers = await requestJson(`${BASE}/api/drivers`, { cookie });
    vehicleId = vehicles.json?.[0]?.vehicleId;
    driverId = drivers.json?.[0]?.driverId;
    if (!vehicleId || !driverId) {
      console.error("[smoke] vehicle/driver fixtures unavailable after create", { vehicles: vehicles.json, drivers: drivers.json });
      process.exit(1);
    }
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
  if (conflict.status === 409) {
    console.log("[smoke] pairing conflict response", conflict.json || conflict.text);
    return;
  }
  if (conflict.status === 200 && conflict.json?.ok === true && conflict.json?.replacedAssignmentId) {
    console.log("[smoke] pairing replacement response", conflict.json || conflict.text);
    return;
  }
  console.error("[smoke] expected conflict 409 or replacement 200 but got", conflict.status, conflict.json || conflict.text);
  process.exit(1);
}

main().catch((err) => {
  console.error("[smoke] error", err.message || err);
  process.exit(1);
});
