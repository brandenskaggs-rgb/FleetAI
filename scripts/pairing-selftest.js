const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

function request(url, method, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === "https:" ? https : http;
    const payload = body ? JSON.stringify(body) : "";
    const req = client.request(
      {
        method,
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload)
        }
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function loadIds() {
  const dataPath = path.resolve(__dirname, "..", "server", "data.json");
  const raw = fs.readFileSync(dataPath, "utf8");
  const data = JSON.parse(raw);
  const vehicleId = data.vehicles?.[0]?.vehicleId;
  const driverId = data.drivers?.[0]?.driverId;
  if (!vehicleId || !driverId) {
    throw new Error("Missing vehicles/drivers in server/data.json");
  }
  return { vehicleId, driverId };
}

(async () => {
  const base = process.env.FLEETAI_BASE_URL || "http://localhost:3000";
  const { vehicleId, driverId } = loadIds();

  console.log("[SELFTEST] base", base);
  console.log("[SELFTEST] using", { vehicleId, driverId });

  const gen = await request(`${base}/api/pairings/generate`, "POST", { vehicleId, driverId, replaceActive: true });
  console.log("[SELFTEST] generate", gen.status, gen.body.slice(0, 300));
  if (gen.status !== 200) process.exit(1);
  let code;
  try {
    const json = JSON.parse(gen.body);
    code = json.pairingCode || json.pairCode || json.code;
  } catch (err) {
    console.error("[SELFTEST] failed to parse generate response");
    process.exit(1);
  }
  if (!code) {
    console.error("[SELFTEST] no pairing code returned");
    process.exit(1);
  }

  const claimVariants = [
    { url: `${base}/api/pairings/claim`, body: { code, device_id: "SELFTEST_DEVICE", device_name: "SelfTest" } },
    { url: `${base}/api/pairing/claim`, body: { pairingCode: code, deviceId: "SELFTEST_DEVICE", deviceLabel: "SelfTest" } },
    { url: `${base}/pairings/claim`, body: { pair_code: code, uuid: "SELFTEST_DEVICE" } }
  ];

  for (const variant of claimVariants) {
    const res = await request(variant.url, "POST", variant.body);
    console.log("[SELFTEST] claim", variant.url, res.status, res.body.slice(0, 300));
  }

  // Idempotent claim same device should succeed
  const re = await request(`${base}/api/pairings/claim`, "POST", { code, device_id: "SELFTEST_DEVICE", device_label: "SelfTestAgain" });
  console.log("[SELFTEST] claim same device", re.status, re.body.slice(0, 200));

  // Conflict with different device
  const conflict = await request(`${base}/api/pairings/claim`, "POST", { code, device_id: "OTHER_DEVICE", device_label: "Other" });
  console.log("[SELFTEST] claim other device", conflict.status, conflict.body.slice(0, 200));

  console.log("[SELFTEST] done");
})().catch((err) => {
  console.error("[SELFTEST] error", err.message);
  process.exit(1);
});
