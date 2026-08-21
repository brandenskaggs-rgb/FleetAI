const assert = require("assert");
const db = require("../server/db");
const { registerFleetOpsRoutes } = require("../server/routes/fleetOpsRoutes");

function fakeApp() {
  const routes = new Map();
  const add = (method) => (route, ...handlers) => routes.set(`${method} ${route}`, handlers);
  return {
    routes,
    get: add("GET"),
    post: add("POST"),
    patch: add("PATCH"),
    delete: add("DELETE")
  };
}

function fakeResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

function dependencies(readData) {
  return {
    readData,
    writeData: async () => {},
    sanitizeString: (value, max = 500) => String(value || "").trim().slice(0, max),
    parseNumberField: (value, fallback = null) => value === "" || value == null || !Number.isFinite(Number(value)) ? fallback : Number(value),
    nowIso: () => "2026-08-17T00:00:00.000Z",
    generateDigits: () => "123456",
    requireEmployeeOrCustomerApi(req, _res, next) { next(); },
    telemetryLatest: new Map(),
    telemetrySubscribers: new Set(),
    getTelemetryLastSeen: () => null,
    getTelemetryState: () => ({}),
    triggerTelemetryPipeline: async () => {},
    storeNormalizedSnapshot: async () => {},
    normalizeMetrics: (value) => value
  };
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

async function postVehicle(app, body, orgId = "ORG_ACTIVE", employee = null) {
  const handlers = app.routes.get("POST /api/vehicles");
  assert(handlers, "vehicle create route is missing");
  const req = { body, query: {}, params: {}, path: "/api/vehicles" };
  if (employee) {
    req.employee = employee;
    req.body.orgId = orgId;
  } else {
    req.customer = { orgId };
  }
  const res = fakeResponse();
  await handlers[handlers.length - 1](req, res, (err) => { if (err) throw err; });
  return res;
}

function vehicleInput(overrides = {}) {
  return Object.assign({
    vehicleId: "CAMARO-01",
    unitName: "Chevy Camaro",
    vin: "1G1FA1RX0A0123456",
    type: "passenger-car",
    year: 2010,
    make: "Chevrolet",
    model: "Camaro"
  }, overrides);
}

async function testCustomerCannotRecoverHiddenVehicleFromDuplicateOrg() {
  const app = fakeApp();
  let transfer = null;
  const orgs = [
    { id: "ORG_OLD", primaryContactEmail: "owner@example.com" },
    { id: "ORG_ACTIVE", primaryContactEmail: "OWNER@example.com" }
  ];
  await withDbMocks({
    getVehicleByVehicleId: async () => null,
    getVehicleByVin: async () => ({ vehicleId: "Car-01", vin: "1G1FA1RX0A0123456", orgId: "ORG_OLD" }),
    getOrg: async (id) => orgs.find((org) => org.id === id),
    transferVehicleToOrg: async (vehicleId, orgId, patch) => {
      transfer = { vehicleId, orgId, patch };
      return { vehicleId, orgId, ...patch };
    },
    logAudit: async () => {}
  }, async () => {
    registerFleetOpsRoutes(app, dependencies(async () => ({ orgs })));
    const res = await postVehicle(app, vehicleInput());
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.code, "VEHICLE_IN_OTHER_ORG");
    assert.strictEqual(transfer, null);
  });
}

async function testSuperAdminCanExplicitlyRecoverDuplicateOrgVehicle() {
  const app = fakeApp();
  let transfer = null;
  const orgs = [
    { id: "ORG_OLD", primaryContactEmail: "owner@example.com" },
    { id: "ORG_ACTIVE", primaryContactEmail: "OWNER@example.com" }
  ];
  await withDbMocks({
    getVehicleByVehicleId: async () => null,
    getVehicleByVin: async () => ({ vehicleId: "Car-01", vin: "1G1FA1RX0A0123456", orgId: "ORG_OLD" }),
    getOrg: async (id) => orgs.find((org) => org.id === id),
    transferVehicleToOrg: async (vehicleId, orgId, patch) => {
      transfer = { vehicleId, orgId, patch };
      return { vehicleId, orgId, ...patch };
    },
    logAudit: async () => {}
  }, async () => {
    registerFleetOpsRoutes(app, dependencies(async () => ({ orgs })));
    const res = await postVehicle(
      app,
      vehicleInput({ recoverExistingVehicle: true }),
      "ORG_ACTIVE",
      { role: "SUPER_ADMIN" }
    );
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.recovered, true);
    assert.deepStrictEqual({ vehicleId: transfer.vehicleId, orgId: transfer.orgId }, { vehicleId: "Car-01", orgId: "ORG_ACTIVE" });
  });
}

async function testRefusesCrossCustomerRecovery() {
  const app = fakeApp();
  let transferred = false;
  const orgs = [
    { id: "ORG_OTHER", primaryContactEmail: "other@example.com" },
    { id: "ORG_ACTIVE", primaryContactEmail: "owner@example.com" }
  ];
  await withDbMocks({
    getVehicleByVehicleId: async () => null,
    getVehicleByVin: async () => ({ vehicleId: "OTHER-01", vin: "1G1FA1RX0A0123456", orgId: "ORG_OTHER" }),
    getOrg: async (id) => orgs.find((org) => org.id === id),
    transferVehicleToOrg: async () => { transferred = true; },
    logAudit: async () => {}
  }, async () => {
    registerFleetOpsRoutes(app, dependencies(async () => ({ orgs })));
    const res = await postVehicle(app, vehicleInput());
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.code, "VEHICLE_IN_OTHER_ORG");
    assert.strictEqual(transferred, false);
  });
}

async function testResurfacesSameOrgVehicle() {
  const app = fakeApp();
  await withDbMocks({
    getVehicleByVehicleId: async () => ({ vehicleId: "CAMARO-01", vin: "1G1FA1RX0A0123456", orgId: "ORG_ACTIVE" }),
    getVehicleByVin: async () => ({ vehicleId: "CAMARO-01", vin: "1G1FA1RX0A0123456", orgId: "ORG_ACTIVE" }),
    transferVehicleToOrg: async (vehicleId, orgId, patch) => ({ vehicleId, orgId, ...patch }),
    logAudit: async () => {}
  }, async () => {
    registerFleetOpsRoutes(app, dependencies(async () => ({ orgs: [] })));
    const res = await postVehicle(app, vehicleInput());
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.alreadyExists, true);
    assert.strictEqual(res.body.recovered, false);
  });
}

async function testRejectsUnitIdAssignedToDifferentVin() {
  const app = fakeApp();
  await withDbMocks({
    getVehicleByVehicleId: async () => ({ vehicleId: "CAMARO-01", vin: "1G1FA1RX0A0999999", orgId: "ORG_ACTIVE" }),
    getVehicleByVin: async () => null
  }, async () => {
    registerFleetOpsRoutes(app, dependencies(async () => ({ orgs: [] })));
    const res = await postVehicle(app, vehicleInput());
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.code, "VEHICLE_ID_CONFLICT");
  });
}

(async () => {
  await testCustomerCannotRecoverHiddenVehicleFromDuplicateOrg();
  await testSuperAdminCanExplicitlyRecoverDuplicateOrgVehicle();
  await testRefusesCrossCustomerRecovery();
  await testResurfacesSameOrgVehicle();
  await testRejectsUnitIdAssignedToDifferentVin();
  console.log("Vehicle recovery tests: 5 passed, 0 failed");
})().catch((err) => {
  console.error("Vehicle recovery tests failed:", err.stack || err.message);
  process.exitCode = 1;
});
