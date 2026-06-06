require("dotenv").config();

const http = require("http");
const https = require("https");

const BASE = (process.env.FLEETAI_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
const EMAIL = process.env.FLEETAI_SMOKE_EMAIL || process.env.CUSTOMER_EMAIL || "customer@fleetai.local";
const PASSWORD = process.env.FLEETAI_SMOKE_PASSWORD || process.env.CUSTOMER_PASSWORD || "";
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
          resolve({ status: res.statusCode, headers: res.headers, text: data, json });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function cookieFrom(headers) {
  const setCookie = headers["set-cookie"];
  if (!Array.isArray(setCookie)) return "";
  return setCookie.map((value) => value.split(";")[0]).join("; ");
}

function assertOk(label, response, statuses = [200, 201]) {
  if (!statuses.includes(response.status) || !response.json || response.json.ok !== true) {
    console.error(`[solution-smoke] ${label} failed`, response.status, response.json || response.text);
    process.exit(1);
  }
  console.log(`[solution-smoke] ${label} ${response.status}`);
}

async function ensureFixture(cookie, type, existing, createUrl, body) {
  const key = type === "vehicle" ? "vehicleId" : "driverId";
  const id = body[key];
  const found = (Array.isArray(existing) ? existing : []).find((item) => item[key] === id) || existing?.[0];
  if (found) return found[key];
  const created = await requestJson(`${BASE}${createUrl}`, { method: "POST", cookie, body });
  if (![200, 201, 409].includes(created.status)) {
    console.error(`[solution-smoke] ${type} fixture create failed`, created.status, created.json || created.text);
    process.exit(1);
  }
  return id;
}

async function main() {
  console.log(`[solution-smoke] base=${BASE}`);
  if (!PASSWORD) {
    console.error("[solution-smoke] missing customer password env");
    process.exit(1);
  }

  const health = await requestJson(`${BASE}/health`);
  console.log(`[solution-smoke] /health ${health.status}`);
  if (health.status >= 400) process.exit(1);

  const login = await requestJson(`${BASE}/api/auth/org/login`, {
    method: "POST",
    body: { email: EMAIL, password: PASSWORD }
  });
  assertOk("customer login", login);
  const cookie = cookieFrom(login.headers);
  if (!cookie) {
    console.error("[solution-smoke] login did not return a session cookie");
    process.exit(1);
  }

  const vehicles = await requestJson(`${BASE}/api/vehicles`, { cookie });
  const drivers = await requestJson(`${BASE}/api/drivers`, { cookie });
  if (vehicles.status >= 400 || drivers.status >= 400) {
    console.error("[solution-smoke] unable to load fleet fixtures", vehicles.status, drivers.status);
    process.exit(1);
  }

  const vehicleId = await ensureFixture(cookie, "vehicle", vehicles.json, "/api/vehicles", {
    vehicleId: SMOKE_VEHICLE_ID,
    unitName: "Solution Smoke Unit",
    vin: "1FTFW1ET0DFC00002",
    type: "truck"
  });
  const driverId = await ensureFixture(cookie, "driver", drivers.json, "/api/drivers", {
    driverId: SMOKE_DRIVER_ID,
    firstName: "Solution",
    lastName: "Driver",
    phone: "555-0101"
  });

  const dvir = await requestJson(`${BASE}/api/dvir`, {
    method: "POST",
    cookie,
    body: {
      vehicleId,
      driverId,
      type: "pre",
      odometer: 101,
      inspectedItems: ["lights", "brakes"],
      defects: "",
      signature: "Solution Driver"
    }
  });
  assertOk("dvir create", dvir, [201]);

  const dvirList = await requestJson(`${BASE}/api/dvir?vehicleId=${encodeURIComponent(vehicleId)}&limit=500`, { cookie });
  assertOk("dvir list", dvirList);
  if (!Array.isArray(dvirList.json.data) || !dvirList.json.data.some((record) => record.id === dvir.json.data.id)) {
    console.error("[solution-smoke] created DVIR was not returned by list");
    process.exit(1);
  }

  const job = await requestJson(`${BASE}/api/dispatch/jobs`, {
    method: "POST",
    cookie,
    body: {
      vehicleId,
      driverId,
      origin: "Smoke Origin",
      destination: "Smoke Destination",
      status: "assigned",
      cargoWeight: 1200
    }
  });
  assertOk("dispatch create", job, [201]);

  const jobs = await requestJson(`${BASE}/api/dispatch/jobs`, { cookie });
  assertOk("dispatch list", jobs);
  if (!Array.isArray(jobs.json.data) || !jobs.json.data.some((item) => item.id === job.json.data.id)) {
    console.error("[solution-smoke] created dispatch job was not returned by list");
    process.exit(1);
  }

  const partNumber = `SMOKE-${Date.now()}`;
  const part = await requestJson(`${BASE}/api/parts`, {
    method: "POST",
    cookie,
    body: {
      partNumber,
      name: "Smoke Brake Pad",
      quantityOnHand: 1,
      reorderAt: 2,
      vendor: "Smoke Vendor"
    }
  });
  assertOk("part create", part, [201]);

  const parts = await requestJson(`${BASE}/api/parts`, { cookie });
  assertOk("parts list", parts);
  const reorderHit = Array.isArray(parts.json.reorderAlerts)
    && parts.json.reorderAlerts.some((item) => item.partNumber === partNumber);
  if (!reorderHit) {
    console.error("[solution-smoke] expected reorder alert was not returned");
    process.exit(1);
  }

  const compliance = await requestJson(`${BASE}/api/dot-compliance`, { cookie });
  assertOk("dot compliance", compliance);
  if (!compliance.json.data?.dvir || compliance.json.data.dvir.total < 1) {
    console.error("[solution-smoke] DOT compliance did not include DVIR totals");
    process.exit(1);
  }

  console.log("[solution-smoke] solution APIs passed");
}

main().catch((err) => {
  console.error("[solution-smoke] error", err.message || err);
  process.exit(1);
});
