"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { test } = require("node:test");
const db = require("../server/db");
const { registerEldRoutes } = require("../server/routes/eldRoutes");
const { getCycleWindowStart } = require("../server/eld/hosCalculator");

function routes(eldService) {
  const handlers = new Map();
  const app = Object.fromEntries(["get", "post"].map((method) => [method,
    (path, ...callbacks) => handlers.set(`${method} ${path}`, callbacks)]));
  registerEldRoutes(app, { eldService, requireEmployeeOrCustomerApi: (_req, _res, next) => next(),
    requireSuperAdmin: (_req, _res, next) => next() });
  return handlers;
}
async function invoke(callback, overrides = {}) {
  const req = { device: { orgId: "org-a", driverId: "driver-a", deviceId: "cab-a" }, body: {}, ...overrides };
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; } };
  let error;
  await callback(req, res, (value) => { error = value; });
  return { req, res, error };
}

test("output route requires carrier timezone before querying records", async () => {
  let read = false;
  const handlers = routes({ getDeviceContext: async () => ({ config: null }),
    listRecords: async () => { read = true; return []; } });
  const { res } = await invoke(handlers.get("post /api/eld/output-file").at(-1));
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, "ELD_CARRIER_CONFIG_REQUIRED");
  assert.equal(read, false);
});

test("output route requests complete terminal-day history and propagates overflow", async () => {
  const overflow = Object.assign(new Error("overflow"), { code: "ELD_OUTPUT_RECORD_LIMIT_EXCEEDED", statusCode: 422 });
  let captured;
  const handlers = routes({ getDeviceContext: async () => ({ config: { homeTerminalTimeZone: "America/Chicago", dayStartMinutes: 240 } }),
    listRecords: async (...args) => { captured = args; throw overflow; } });
  const { error } = await invoke(handlers.get("post /api/eld/output-file").at(-1));
  assert.equal(error, overflow);
  assert.deepEqual(captured[2], { requireComplete: true });
  assert.equal(captured[1].from.toISOString(),
    getCycleWindowStart(captured[1].to, 8, "America/Chicago", 240).toISOString());
});

test("successful generation explicitly reports not sent and records only FILE_GENERATION", async () => {
  const oldKey = process.env.FMCSA_ELD_AUTH_PRIVATE_KEY;
  const original = db.getPrisma;
  const writes = [];
  try {
    process.env.FMCSA_ELD_AUTH_PRIVATE_KEY = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" });
    db.getPrisma = () => ({ eldTransferAttempt: { create: async (input) => {
      writes.push(input.data); return { id: "local-test-attempt" };
    } } });
    const handlers = routes({
      getDeviceContext: async () => ({
        config: { homeTerminalTimeZone: "UTC", eldIdentifier: "ABC123", eldRegistrationId: "AB12" },
        driver: { firstName: "Test", lastName: "Driver", eldUsername: "test", licenseNum: "123", licenseState: "MO" },
        vehicle: { vehicleId: "test-unit", unitName: "TEST", vin: "1M8GDM9AXKP042788" }
      }),
      listRecords: async () => []
    });
    const { res, error } = await invoke(handlers.get("post /api/eld/output-file").at(-1));
    assert.equal(error, undefined);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.status, "GENERATED_NOT_SENT");
    assert.equal(res.body.sentToFmcsa, false);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].orgId, "org-a");
    assert.equal(writes[0].method, "FILE_GENERATION");
    assert.equal(writes[0].status, "GENERATED");
  } finally {
    db.getPrisma = original;
    if (oldKey === undefined) delete process.env.FMCSA_ELD_AUTH_PRIVATE_KEY;
    else process.env.FMCSA_ELD_AUTH_PRIVATE_KEY = oldKey;
  }
});

test("operator enable rejects missing organization before accessing pairings", async () => {
  const handlers = routes({});
  const { res, error } = await invoke(handlers.get("post /api/eld/devices/:deviceId/enable").at(-1),
    { params: { deviceId: "cab-a" } });
  assert.equal(error, undefined);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "ORG_SCOPE_REQUIRED");
});
