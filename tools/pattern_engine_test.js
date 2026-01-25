const http = require("http");

const BASE_URL = process.env.FLEETAI_BASE_URL || "http://localhost:3000";
const VEHICLE_ID = process.env.FLEETAI_TEST_VEHICLE || "DEMO_01";

function request(method, path, body) {
  const payload = body ? JSON.stringify(body) : null;
  const url = new URL(path, BASE_URL);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": payload ? Buffer.byteLength(payload) : 0
        }
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          const data = raw ? JSON.parse(raw) : null;
          resolve({ status: res.statusCode, data });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function run() {
  console.log("[test] creating vehicle if missing");
  await request("POST", "/api/vehicles", {
    vehicleId: VEHICLE_ID,
    unitName: "Demo Truck",
    vin: "VINDEMO123",
    type: "truck"
  }).catch(() => {});

  console.log("[test] ingesting telemetry snapshots");
  for (let i = 0; i < 220; i += 1) {
    const ts = new Date(Date.now() - (220 - i) * 60000).toISOString();
    await request("POST", "/api/telemetry/ingest", {
      vehicleId: VEHICLE_ID,
      timestamp: ts,
      rawPids: {
        coolant_temp: 190 + i * 0.05,
        battery_voltage: 13.8 - i * 0.002,
        engine_load: 45 + (i % 5),
        maf: 15 + (i % 4),
        rpm: 1500 + (i % 100),
        ltft1: 2 + (i % 3)
      },
      dtcCodes: i % 60 === 0 ? ["P0171"] : []
    });
  }

  console.log("[test] requesting recompute");
  await request("POST", "/api/predictive/recompute", { vehicleId: VEHICLE_ID });

  console.log("[test] baselines");
  const baselines = await request("GET", `/api/predictive/baselines?vehicleId=${VEHICLE_ID}`);
  console.log("baselines:", baselines.data?.data?.length || 0);

  console.log("[test] signals");
  const signals = await request("GET", `/api/predictive/signals?vehicleId=${VEHICLE_ID}`);
  console.log("signals:", signals.data?.data?.length || 0);

  console.log("[test] recommendations");
  const recs = await request("GET", `/api/predictive/recommendations?vehicleId=${VEHICLE_ID}`);
  console.log("recommendations:", recs.data?.data?.length || 0);

  console.log("[test] create maintenance log");
  await request("POST", "/api/maintenance", {
    vehicleId: VEHICLE_ID,
    occurredAt: new Date().toISOString(),
    type: "oil_change",
    description: "Oil change for test",
    odometerMiles: 123456
  });

  console.log("[test] done");
}

run().catch((err) => {
  console.error("[test] failed", err.message);
  process.exit(1);
});
