const assert = require("assert");
const fs = require("fs");
const path = require("path");
const db = require("../server/db");
const { registerFleetOpsRoutes } = require("../server/routes/fleetOpsRoutes");
const { registerLegacyPairingRoutes } = require("../server/routes/legacyPairing");
const { registerSolutionRoutes } = require("../server/routes/solutionRoutes");
const { registerMlRoutes } = require("../server/routes/mlRoutes");

function fakeApp() {
  const routes = new Map();
  const add = (method) => (route, ...handlers) => routes.set(`${method} ${route}`, handlers);
  return {
    routes,
    get: add("GET"),
    post: add("POST"),
    patch: add("PATCH"),
    delete: add("DELETE"),
    use() {},
    handle() {}
  };
}

function fakeResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; },
    set() { return this; },
    flushHeaders() {}
  };
}

async function invoke(app, method, route, req = {}) {
  const handlers = app.routes.get(`${method} ${route}`);
  assert(handlers, `route missing: ${method} ${route}`);
  const res = fakeResponse();
  const request = Object.assign({ body: {}, query: {}, params: {}, headers: {}, path: route }, req);
  await handlers[handlers.length - 1](request, res, (err) => { if (err) throw err; });
  return res;
}

function commonDeps() {
  return {
    sanitizeString: (value, max = 500) => String(value || "").trim().slice(0, max),
    parseNumberField: (value, fallback = null) => Number.isFinite(Number(value)) ? Number(value) : fallback,
    nowIso: () => "2026-08-14T00:00:00.000Z",
    generateDigits: () => "123456",
    generateDriverPin: () => "654321",
    isExpired: () => false,
    makeId: (prefix) => `${prefix}_TEST`,
    addAudit() {},
    requireEmployeeOrCustomerApi(req, _res, next) { next(); }
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

async function testPairingOptionsRequiresAuthAndScopes() {
  const app = fakeApp();
  const calls = [];
  await withDbMocks({
    listVehicles: async (options) => { calls.push(["vehicles", options]); return []; },
    listDrivers: async (options) => { calls.push(["drivers", options]); return []; }
  }, async () => {
    registerFleetOpsRoutes(app, Object.assign(commonDeps(), {
      readData: async () => ({ telemetrySnapshots: [] }),
      telemetryLatest: new Map(),
      telemetrySubscribers: new Set(),
      getTelemetryLastSeen: () => null,
      getTelemetryState: () => ({}),
      triggerTelemetryPipeline: async () => {},
      storeNormalizedSnapshot: async () => {},
      normalizeMetrics: (value) => value
    }));
    const handlers = app.routes.get("GET /api/pairing/options");
    assert.strictEqual(handlers.length, 2, "pairing options must include auth middleware");
    const res = await invoke(app, "GET", "/api/pairing/options", { customer: { orgId: "ORG_A" } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(calls, [["vehicles", { orgId: "ORG_A" }], ["drivers", { orgId: "ORG_A" }]]);
  });
}

async function testPairingGenerationRejectsCrossOrg() {
  const app = fakeApp();
  let created = false;
  await withDbMocks({
    getVehicleByVehicleId: async () => ({ vehicleId: "V_B", orgId: "ORG_B" }),
    getDriverByDriverId: async () => ({ driverId: "D_B", orgId: "ORG_B" }),
    createPairing: async () => { created = true; }
  }, async () => {
    registerLegacyPairingRoutes(app, Object.assign(commonDeps(), { lastDataWriteAtRef: () => null, log() {} }));
    const res = await invoke(app, "POST", "/api/pairings/generate", {
      customer: { orgId: "ORG_A" },
      body: { vehicleId: "V_B", driverId: "D_B" }
    });
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.body.error, "cross_org_access_denied");
    assert.strictEqual(created, false);
  });
}

async function testPairingListFiltersAndRemovesSecrets() {
  const app = fakeApp();
  await withDbMocks({
    listPendingUnexpiredPairings: async () => [
      { id: "P_A", orgId: "ORG_A", vehicleId: "V_A", driverId: "D_A", pairingCode: "111111", driverPin: "222222", status: "pending" },
      { id: "P_B", orgId: "ORG_B", vehicleId: "V_B", driverId: "D_B", pairingCode: "333333", driverPin: "444444", status: "pending" }
    ]
  }, async () => {
    registerLegacyPairingRoutes(app, Object.assign(commonDeps(), { lastDataWriteAtRef: () => null, log() {} }));
    const res = await invoke(app, "GET", "/api/pairings/active", { customer: { orgId: "ORG_A" } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.length, 1);
    assert.strictEqual(res.body[0].orgId, "ORG_A");
    assert.strictEqual(Object.hasOwn(res.body[0], "pairingCode"), false);
    assert.strictEqual(Object.hasOwn(res.body[0], "driverPin"), false);
  });
}

async function testSolutionMutationRejectsCrossOrg() {
  const app = fakeApp();
  let wrote = false;
  await withDbMocks({ listVehicles: async () => [], listDrivers: async () => [] }, async () => {
    registerSolutionRoutes(app, Object.assign(commonDeps(), {
      readData: async () => ({ webhooks: [{ id: "WH_B", orgId: "ORG_B", url: "https://example.com" }] }),
      writeData: async () => { wrote = true; }
    }));
    const res = await invoke(app, "DELETE", "/api/webhooks/:id", {
      customer: { orgId: "ORG_A" },
      params: { id: "WH_B" }
    });
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(wrote, false);
  });
}

async function testMlStateDoesNotIncludeOrglessRows() {
  const app = fakeApp();
  await withDbMocks({
    getAllModelStates: async () => [
      { vehicleId: "V_A", orgId: "ORG_A" },
      { vehicleId: "V_B", orgId: "ORG_B" },
      { vehicleId: "V_OLD", orgId: null }
    ]
  }, async () => {
    registerMlRoutes(app, { requireEmployeeOrCustomerApi(req, _res, next) { next(); } });
    const res = await invoke(app, "GET", "/api/ml/state", { customer: { orgId: "ORG_A" } });
    assert.deepStrictEqual(res.body.data.map((row) => row.vehicleId), ["V_A"]);
  });
}

function testFrontendAndAndroidContracts() {
  const root = path.join(__dirname, "..");
  const dashboard = fs.readFileSync(path.join(root, "ui", "fleetai-dashboard.html"), "utf8");
  const models = fs.readFileSync(path.join(root, "driver_app", "app", "src", "main", "java", "com", "fleetai", "driver", "network", "models.kt"), "utf8");
  const repository = fs.readFileSync(path.join(root, "driver_app", "app", "src", "main", "java", "com", "fleetai", "driver", "data", "repository", "DefaultDriverRepository.kt"), "utf8");
  assert(dashboard.includes('apiPost("/api/auth/customer/logout"'), "dashboard must call customer logout directly");
  assert(!dashboard.includes('["/api/auth/logout","/api/auth/customer/logout"]'), "employee logout must not shadow customer logout");
  assert(/data class PairingClaimRequest\([\s\S]*val driverPin: String/.test(models), "Android claim request must include driverPin");
  assert(/PairingClaimRequest\([\s\S]*driverPin = driverPin/.test(repository), "Android repository must send driverPin");
}

function testLegacyIngestAndDtcContracts() {
  const root = path.join(__dirname, "..");
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const diagnostics = fs.readFileSync(path.join(root, "server", "routes", "diagnosticsRoutes.js"), "utf8");
  assert(
    /app\.post\("\/api\/telemetry\/snapshot",\s*requireDevice/.test(server),
    "legacy telemetry ingest must require a paired device"
  );
  assert(
    /app\.post\("\/api\/alerts",\s*requireDevice/.test(server),
    "legacy driver alert ingest must require a paired device"
  );
  assert(
    diagnostics.includes('req.params?.vehicleId || req.query.vehicleId'),
    "DTC history must resolve vehicle IDs from route parameters"
  );
  assert(
    !diagnostics.includes("req.query.vehicleId = req.params.vehicleId"),
    "DTC history must not mutate Express query parameters"
  );
}

(async () => {
  await testPairingOptionsRequiresAuthAndScopes();
  await testPairingGenerationRejectsCrossOrg();
  await testPairingListFiltersAndRemovesSecrets();
  await testSolutionMutationRejectsCrossOrg();
  await testMlStateDoesNotIncludeOrglessRows();
  testFrontendAndAndroidContracts();
  testLegacyIngestAndDtcContracts();
  console.log("Security boundary tests: 7 passed, 0 failed");
})().catch((err) => {
  console.error("Security boundary tests failed:", err.stack || err.message);
  process.exitCode = 1;
});
