const assert = require("assert");
const db = require("../server/db");
const { requireDevice, requireOperatorOrDevice } = require("../server/middleware/deviceAuth");

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

async function invoke(token, middleware = requireDevice) {
  const req = { method: "POST", path: "/api/telemetry/ingest", query: {}, headers: token ? { authorization: `Bearer ${token}` } : {} };
  const res = response();
  let nextCalled = false;
  await middleware(req, res, () => { nextCalled = true; });
  return { res, nextCalled };
}

async function run() {
  const original = db.findPairingByDeviceToken;
  try {
    db.findPairingByDeviceToken = async () => { throw new Error("database unavailable"); };
    const unavailable = await invoke("dev_test");
    assert.strictEqual(unavailable.res.statusCode, 503);
    assert.strictEqual(unavailable.res.body.error, "DEVICE_AUTH_UNAVAILABLE");
    let operatorCalls = 0;
    const mixed = requireOperatorOrDevice((_req, res) => { operatorCalls++; return res.status(401).json({ error: "Unauthorized" }); });
    const mixedUnavailable = await invoke("dev_test", mixed);
    assert.strictEqual(mixedUnavailable.res.statusCode, 503, "actual telemetry middleware preserves retryable database errors");
    assert.strictEqual(operatorCalls, 0);

    db.findPairingByDeviceToken = async () => null;
    const invalid = await invoke("dev_invalid");
    assert.strictEqual(invalid.res.statusCode, 401);
    assert.strictEqual(invalid.res.body.error, "DEVICE_AUTH_REQUIRED");
    assert.strictEqual((await invoke("dev_invalid", mixed)).res.statusCode, 401);

    db.findPairingByDeviceToken = async () => ({ id: "P1", vehicleId: "V1", driverId: "D1", orgId: "O1", deviceId: "T1" });
    const valid = await invoke("dev_valid");
    assert.strictEqual(valid.nextCalled, true);
    assert.strictEqual((await invoke("dev_valid", mixed)).nextCalled, true);
  } finally {
    db.findPairingByDeviceToken = original;
  }
  console.log("Device and mixed operator/device authentication tests passed");
}

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
