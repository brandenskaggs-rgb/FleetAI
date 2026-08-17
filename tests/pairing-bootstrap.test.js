const assert = require("assert");
const fs = require("fs");
const path = require("path");
const db = require("../server/db");
const { registerLegacyPairingRoutes } = require("../server/routes/legacyPairing");

function fakeApp() {
  const routes = new Map();
  const add = (method) => (route, ...handlers) => routes.set(`${method} ${route}`, handlers);
  return { routes, get: add("GET"), post: add("POST"), use() {} };
}

function fakeResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

function deps(overrides = {}) {
  return Object.assign({
    requireEmployeeOrCustomerApi(req, _res, next) { next(); },
    sanitizeString: (value, max = 500) => String(value || "").trim().slice(0, max),
    nowIso: () => "2026-08-17T18:00:00.000Z",
    generateDigits: () => "123456",
    generateDriverPin: () => "654321",
    isExpired: () => false,
    lastDataWriteAtRef: () => null,
    log() {}
  }, overrides);
}

async function withDbMocks(mocks, fn) {
  const originals = {};
  for (const [name, value] of Object.entries(mocks)) {
    originals[name] = db[name];
    db[name] = value;
  }
  try {
    await fn();
  } finally {
    for (const [name, value] of Object.entries(originals)) db[name] = value;
  }
}

async function claim(app, body) {
  const handlers = app.routes.get("POST /api/pairings/claim");
  assert(handlers, "pairing claim route missing");
  const req = { body, query: {}, params: {}, headers: {}, path: "/api/pairings/claim" };
  const res = fakeResponse();
  await handlers[handlers.length - 1](req, res, (err) => { if (err) throw err; });
  return res;
}

function pairing(overrides = {}) {
  return Object.assign({
    id: "PAIR_1",
    pairingCode: "123456",
    driverPin: "654321",
    vehicleId: "VEH_1",
    driverId: "DRV_1",
    orgId: "ORG_1",
    status: "pending",
    expiresAt: "2026-08-18T18:00:00.000Z",
    driverPinExpiresAt: "2026-08-18T18:00:00.000Z"
  }, overrides);
}

function claimBody(overrides = {}) {
  return Object.assign({
    pairingCode: "123456",
    driverPin: "654321",
    deviceId: "TABLET_1",
    deviceLabel: "Cab tablet"
  }, overrides);
}

async function testPendingClaimBootstrapsCompleteSession() {
  const app = fakeApp();
  await withDbMocks({
    findPairingByCode: async () => pairing(),
    updatePairing: async (_id, patch) => pairing({ ...patch }),
    issueDeviceToken: async () => "dev_test_token",
    getVehicleByVehicleId: async () => ({ vehicleId: "VEH_1", unitName: "Unit 1" }),
    getDriverByDriverId: async () => ({ driverId: "DRV_1", firstName: "Sam", lastName: "Driver" })
  }, async () => {
    registerLegacyPairingRoutes(app, deps());
    const res = await claim(app, claimBody());
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.deviceToken, "dev_test_token");
    assert.strictEqual(res.body.tenantId, "ORG_1");
    assert.strictEqual(res.body.vehicleId, "VEH_1");
    assert.strictEqual(res.body.driverId, "DRV_1");
    assert.strictEqual(res.body.driverName, "Sam Driver");
  });
}

async function testSameDeviceCanRecoverTokenWithPin() {
  const app = fakeApp();
  let issued = 0;
  await withDbMocks({
    findPairingByCode: async () => pairing({ status: "active", deviceId: "TABLET_1" }),
    issueDeviceToken: async () => { issued += 1; return "dev_recovered"; },
    getVehicleByVehicleId: async () => ({ vehicleId: "VEH_1", unitName: "Unit 1" }),
    getDriverByDriverId: async () => ({ driverId: "DRV_1", firstName: "Sam", lastName: "Driver" })
  }, async () => {
    registerLegacyPairingRoutes(app, deps());
    const res = await claim(app, claimBody());
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.deviceToken, "dev_recovered");
    assert.strictEqual(issued, 1);
  });
}

async function testSameDeviceCannotRecoverWithWrongPin() {
  const app = fakeApp();
  let issued = false;
  await withDbMocks({
    findPairingByCode: async () => pairing({ status: "active", deviceId: "TABLET_1" }),
    issueDeviceToken: async () => { issued = true; }
  }, async () => {
    registerLegacyPairingRoutes(app, deps());
    const res = await claim(app, claimBody({ driverPin: "000000" }));
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(res.body.error, "PIN_INVALID");
    assert.strictEqual(issued, false);
  });
}

async function testOtherDeviceRemainsBlocked() {
  const app = fakeApp();
  let issued = false;
  await withDbMocks({
    findPairingByCode: async () => pairing({ status: "active", deviceId: "TABLET_OTHER" }),
    issueDeviceToken: async () => { issued = true; }
  }, async () => {
    registerLegacyPairingRoutes(app, deps());
    const res = await claim(app, claimBody());
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.error, "ALREADY_CLAIMED");
    assert.strictEqual(issued, false);
  });
}

async function testExpiredCodeCannotRecover() {
  const app = fakeApp();
  let issued = false;
  let expired = false;
  await withDbMocks({
    findPairingByCode: async () => pairing({ status: "active", deviceId: "TABLET_1" }),
    updatePairing: async (_id, patch) => { expired = patch.status === "expired"; return pairing({ ...patch }); },
    issueDeviceToken: async () => { issued = true; }
  }, async () => {
    registerLegacyPairingRoutes(app, deps({ isExpired: () => true }));
    const res = await claim(app, claimBody());
    assert.strictEqual(res.statusCode, 410);
    assert.strictEqual(res.body.error, "PAIRING_CODE_INVALID_OR_EXPIRED");
    assert.strictEqual(expired, true);
    assert.strictEqual(issued, false);
  });
}

function testAndroidPairingFirstContract() {
  const root = path.join(__dirname, "..");
  const app = fs.readFileSync(path.join(root, "driver_app", "app", "src", "main", "java", "com", "fleetai", "driver", "FleetAIDriverApp.kt"), "utf8");
  const repository = fs.readFileSync(path.join(root, "driver_app", "app", "src", "main", "java", "com", "fleetai", "driver", "data", "repository", "DefaultDriverRepository.kt"), "utf8");
  const preferences = fs.readFileSync(path.join(root, "driver_app", "app", "src", "main", "java", "com", "fleetai", "driver", "data", "local", "AppPreferences.kt"), "utf8");
  assert(app.includes("!sessionState.isLoggedIn || sessionState.vehicleId.isBlank()"), "fresh tablets must enter pairing before authenticated app routes");
  assert(repository.includes("preferences.saveClaimedSession("), "pairing must persist one complete scoped session");
  assert(preferences.includes("suspend fun saveClaimedSession("), "atomic claimed-session storage is required");
}

(async () => {
  await testPendingClaimBootstrapsCompleteSession();
  await testSameDeviceCanRecoverTokenWithPin();
  await testSameDeviceCannotRecoverWithWrongPin();
  await testOtherDeviceRemainsBlocked();
  await testExpiredCodeCannotRecover();
  testAndroidPairingFirstContract();
  console.log("Pairing bootstrap tests: 6 passed, 0 failed");
})().catch((err) => {
  console.error("Pairing bootstrap tests failed:", err.stack || err.message);
  process.exitCode = 1;
});
