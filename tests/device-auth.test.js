const assert = require("assert");
const db = require("../server/db");
const { requireDevice } = require("../server/middleware/deviceAuth");

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

async function invoke(token) {
  const req = { method: "POST", path: "/api/telemetry/ingest", query: {}, headers: token ? { authorization: `Bearer ${token}` } : {} };
  const res = response();
  let nextCalled = false;
  await requireDevice(req, res, () => { nextCalled = true; });
  return { res, nextCalled };
}

async function run() {
  const original = db.findPairingByDeviceToken;
  try {
    db.findPairingByDeviceToken = async () => { throw new Error("database unavailable"); };
    const unavailable = await invoke("dev_test");
    assert.strictEqual(unavailable.res.statusCode, 503);
    assert.strictEqual(unavailable.res.body.error, "DEVICE_AUTH_UNAVAILABLE");

    db.findPairingByDeviceToken = async () => null;
    const invalid = await invoke("dev_invalid");
    assert.strictEqual(invalid.res.statusCode, 401);
    assert.strictEqual(invalid.res.body.error, "DEVICE_AUTH_REQUIRED");

    db.findPairingByDeviceToken = async () => ({ id: "P1", vehicleId: "V1", driverId: "D1", orgId: "O1", deviceId: "T1" });
    const valid = await invoke("dev_valid");
    assert.strictEqual(valid.nextCalled, true);
  } finally {
    db.findPairingByDeviceToken = original;
  }
  console.log("Device auth tests: 3 passed, 0 failed");
}

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
