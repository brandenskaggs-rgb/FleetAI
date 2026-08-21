const assert = require("assert");
const fs = require("fs");
const path = require("path");
const db = require("../server/db");
const { registerFleetOpsRoutes } = require("../server/routes/fleetOpsRoutes");
const { registerLegacyPairingRoutes } = require("../server/routes/legacyPairing");
const { registerSolutionRoutes } = require("../server/routes/solutionRoutes");
const { registerMlRoutes } = require("../server/routes/mlRoutes");
const { registerFeedbackRoutes } = require("../server/routes/feedbackRoutes");
const { registerOrgManagementRoutes } = require("../server/routes/orgManagementRoutes");
const { registerMotiveOAuthRoutes } = require("../server/routes/motiveOAuthRoutes");
const { registerDriverAppRoutes } = require("../server/routes/driverAppRoutes");
const { bindCustomerTenant } = require("../server/middleware/tenantScope");
const { extractBearer } = require("../server/middleware/deviceAuth");
const { publicUserView } = require("../server/lib/utils");

function fakeApp() {
  const routes = new Map();
  const add = (method) => (route, ...handlers) => routes.set(`${method} ${route}`, handlers);
  return {
    routes,
    get: add("GET"),
    post: add("POST"),
    patch: add("PATCH"),
    put: add("PUT"),
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
    setHeader() { return this; },
    redirect(location) { this.redirectedTo = location; return this; },
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

function testCentralTenantGuardFailsClosed() {
  const missingRes = fakeResponse();
  assert.strictEqual(bindCustomerTenant({ method: "GET", params: {}, query: {}, body: {} }, missingRes, { role: "ORG_ADMIN" }), false);
  assert.strictEqual(missingRes.statusCode, 403);
  assert.strictEqual(missingRes.body.error, "org_scope_required");

  const mismatchRes = fakeResponse();
  assert.strictEqual(bindCustomerTenant({ method: "GET", params: {}, query: { orgId: "ORG_B" }, body: {} }, mismatchRes, { orgId: "ORG_A", role: "ORG_ADMIN" }), false);
  assert.strictEqual(mismatchRes.body.error, "cross_org_access_denied");

  const viewerRes = fakeResponse();
  assert.strictEqual(bindCustomerTenant({ method: "POST", params: {}, query: {}, body: {} }, viewerRes, { orgId: "ORG_A", role: "CUSTOMER_VIEWER" }, { enforceReadOnly: true }), false);
  assert.strictEqual(viewerRes.body.error, "read_only_role");

  const allowedReq = { method: "GET", params: {}, query: {}, body: {} };
  assert.strictEqual(bindCustomerTenant(allowedReq, fakeResponse(), { orgId: "ORG_A", userId: "USER_A", role: "ORG_ADMIN" }), true);
  assert.strictEqual(allowedReq.tenantOrgId, "ORG_A");
}

async function testVehicleListsIgnoreForeignOrgInput() {
  const app = fakeApp();
  const calls = [];
  await withDbMocks({
    listVehicles: async (options) => { calls.push(options); return [{ vehicleId: "V_A", orgId: "ORG_A" }]; }
  }, async () => {
    registerFleetOpsRoutes(app, Object.assign(commonDeps(), {
      readData: async () => ({ telemetrySnapshots: [] }),
      writeData: async () => {},
      telemetryLatest: new Map(),
      telemetrySubscribers: new Set(),
      getTelemetryLastSeen: () => null,
      getTelemetryState: () => ({}),
      triggerTelemetryPipeline: async () => {},
      storeNormalizedSnapshot: async () => {},
      normalizeMetrics: (value) => value
    }));
    const res = await invoke(app, "GET", "/api/orgs/:orgId/vehicles", {
      customer: { orgId: "ORG_A" },
      params: { orgId: "ORG_B" }
    });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(calls, [{ orgId: "ORG_A" }]);
    assert.deepStrictEqual(res.body.data.map((vehicle) => vehicle.orgId), ["ORG_A"]);
  });
}

async function testFeedbackRejectsForeignVehicle() {
  const app = fakeApp();
  let created = false;
  await withDbMocks({
    getPrisma: () => ({
      vehicle: { findUnique: async () => ({ vehicleId: "V_B", orgId: "ORG_B" }) },
      mlPredictionRun: { findFirst: async () => null },
      feedbackLog: { create: async () => { created = true; return {}; } }
    })
  }, async () => {
    registerFeedbackRoutes(app, { requireAuth(req, _res, next) { next(); } });
    const res = await invoke(app, "POST", "/api/telemetry/feedback", {
      customer: { orgId: "ORG_A", email: "a@example.test" },
      body: { vehicleId: "V_B", outcome: "false_positive" }
    });
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.body.error, "cross_org_vehicle_denied");
    assert.strictEqual(created, false);
  });
}

async function testBillingIsStoredPerOrganization() {
  const app = fakeApp();
  const billing = new Map([
    ["ORG_A", { orgId: "ORG_A", plan: "PILOT_A", priceMonthly: 59, status: "PILOT", vehicleCount: 1, contractTermMonths: 0, notes: "A" }],
    ["ORG_B", { orgId: "ORG_B", plan: "PILOT_B", priceMonthly: 99, status: "ACTIVE", vehicleCount: 2, contractTermMonths: 12, notes: "B" }]
  ]);
  const payments = new Map([
    ["ORG_A", { orgId: "ORG_A", type: "CARD_STUB", billingName: "Alpha", billingEmail: "alpha@example.test", last4: "1111", expMonth: 1, expYear: 2030, brand: "Visa", postalCode: "", accountType: "", routingLast4: "", accountLast4: "" }],
    ["ORG_B", { orgId: "ORG_B", type: "CARD_STUB", billingName: "Beta", billingEmail: "beta@example.test", last4: "2222", expMonth: 2, expYear: 2031, brand: "Visa", postalCode: "", accountType: "", routingLast4: "", accountLast4: "" }]
  ]);
  const prisma = {
    orgBillingSettings: {
      findUnique: async ({ where }) => billing.get(where.orgId) || null,
      upsert: async ({ where, create, update }) => {
        const row = Object.assign({}, billing.get(where.orgId) || create, update, { orgId: where.orgId });
        billing.set(where.orgId, row);
        return row;
      }
    },
    paymentMethod: {
      findUnique: async ({ where }) => payments.get(where.orgId) || null,
      upsert: async ({ where, create, update }) => {
        const row = Object.assign({}, payments.get(where.orgId) || create, update, { orgId: where.orgId, updatedAt: new Date("2026-08-19T00:00:00Z") });
        payments.set(where.orgId, row);
        return row;
      }
    }
  };
  await withDbMocks({ getPrisma: () => prisma }, async () => {
    registerOrgManagementRoutes(app, {
      readData: async () => ({ settings: { defaultPilotPrice: 59 }, audit: [], users: [], orgs: [] }),
      writeData: async () => {},
      requireEmployeeApi(req, _res, next) { next(); },
      requireCustomerApi(req, _res, next) { next(); },
      requireRole: () => (req, _res, next) => next(),
      getRateState: () => ({ allowed: true }),
      prismaAuthAdapter: null,
      revokeUserSessions: async () => {}
    });

    const a = await invoke(app, "GET", "/api/org/billing", { customer: { orgId: "ORG_A", role: "ORG_ADMIN" } });
    const b = await invoke(app, "GET", "/api/org/billing", { customer: { orgId: "ORG_B", role: "ORG_ADMIN" } });
    assert.strictEqual(a.body.data.plan, "PILOT_A");
    assert.strictEqual(b.body.data.plan, "PILOT_B");

    await invoke(app, "POST", "/api/org/billing", {
      customer: { orgId: "ORG_A", role: "ORG_ADMIN" },
      body: { status: "ACTIVE", notes: "Alpha only" }
    });
    assert.strictEqual(billing.get("ORG_A").notes, "Alpha only");
    assert.strictEqual(billing.get("ORG_B").notes, "B");

    const payA = await invoke(app, "GET", "/api/org/payment-method", { customer: { orgId: "ORG_A", role: "ORG_ADMIN" } });
    const payB = await invoke(app, "GET", "/api/org/payment-method", { customer: { orgId: "ORG_B", role: "ORG_ADMIN" } });
    assert.strictEqual(payA.body.data.last4, "1111");
    assert.strictEqual(payB.body.data.last4, "2222");
  });
}

function testDeviceTokensAreNotAcceptedOnOrdinaryUrls() {
  assert.strictEqual(extractBearer({ method: "GET", path: "/api/telemetry", headers: {}, query: { deviceToken: "secret" } }), "");
  assert.strictEqual(extractBearer({ method: "GET", path: "/api/telemetry/stream", headers: {}, query: { deviceToken: "secret" } }), "secret");
}

async function testSolutionCollectionsAreIsolatedByOrganization() {
  const app = fakeApp();
  const dbScopes = [];
  const data = {
    users: [],
    dvirRecords: [{ id: "DVIR_A", orgId: "ORG_A" }, { id: "DVIR_B", orgId: "ORG_B" }],
    dispatchJobs: [{ id: "JOB_A", orgId: "ORG_A" }, { id: "JOB_B", orgId: "ORG_B" }],
    parts: [{ id: "PART_A", orgId: "ORG_A", name: "Alpha", quantityOnHand: 2, reorderAt: 1 }, { id: "PART_B", orgId: "ORG_B", name: "Beta", quantityOnHand: 2, reorderAt: 1 }],
    webhooks: [{ id: "HOOK_A", orgId: "ORG_A" }, { id: "HOOK_B", orgId: "ORG_B" }],
    alertSubscriptions: [{ id: "SUB_A", orgId: "ORG_A" }, { id: "SUB_B", orgId: "ORG_B" }],
    driverMessages: [{ id: "MSG_A", orgId: "ORG_A", sentAt: "2026-08-19T00:00:00Z" }, { id: "MSG_B", orgId: "ORG_B", sentAt: "2026-08-19T00:00:00Z" }]
  };
  await withDbMocks({
    listVehicles: async (scope) => { dbScopes.push(["vehicles", scope]); return [{ vehicleId: "V_A", orgId: "ORG_A" }]; },
    listDrivers: async (scope) => { dbScopes.push(["drivers", scope]); return [{ driverId: "D_A", orgId: "ORG_A" }]; }
  }, async () => {
    registerSolutionRoutes(app, Object.assign(commonDeps(), {
      readData: async () => JSON.parse(JSON.stringify(data)),
      writeData: async () => {}
    }));
    const request = { customer: { orgId: "ORG_A", role: "ORG_ADMIN" } };
    const routes = [
      "/api/dvir",
      "/api/dispatch/jobs",
      "/api/parts",
      "/api/webhooks",
      "/api/alert-subscriptions",
      "/api/messages"
    ];
    for (const route of routes) {
      const res = await invoke(app, "GET", route, request);
      assert.strictEqual(res.statusCode, 200, route);
      assert(!JSON.stringify(res.body).includes("ORG_B"), `${route} leaked another organization`);
      assert(!JSON.stringify(res.body).includes("_B"), `${route} leaked another organization's record`);
    }
    assert(dbScopes.length >= routes.length * 2);
    assert(dbScopes.every(([, scope]) => scope.orgId === "ORG_A"), "customer collection loads must be database-scoped");
  });
}

async function testDriverProfileRejectsForeignDriverRecord() {
  const app = fakeApp();
  await withDbMocks({
    getDriverByDriverId: async () => ({ driverId: "D_SHARED", orgId: "ORG_B", firstName: "Beta", lastName: "Driver" })
  }, async () => {
    registerDriverAppRoutes(app, Object.assign(commonDeps(), { log() {} }));
    const res = await invoke(app, "GET", "/api/drivers/me", {
      device: { orgId: "ORG_A", driverId: "D_SHARED", vehicleId: "V_A", deviceId: "DEVICE_A" }
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.tenantId, "ORG_A");
    assert.strictEqual(res.body.driverName, "D_SHARED");
    assert(!JSON.stringify(res.body).includes("Beta Driver"));
  });
}

async function testMotiveOAuthStateFailsClosed() {
  const app = fakeApp();
  registerMotiveOAuthRoutes(app, {
    requireSuperAdmin(_req, _res, next) { next(); },
    sessionStore: new Map(),
    getSession: () => ({ id: "SESSION_A" })
  });
  const res = await invoke(app, "GET", "/api/auth/motive/callback", {
    query: { code: "untrusted-code", state: "untrusted-state" }
  });
  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(res.body.error, "state_mismatch");
}

function testPublicUserViewRemovesCredentialMaterial() {
  const result = publicUserView({
    id: "USER_A",
    email: "a@example.test",
    role: "ORG_ADMIN",
    orgId: "ORG_A",
    passwordHash: "bcrypt-secret",
    setupTokenHash: "setup-secret",
    setupTokenExpiresAt: 999,
    driverPin: "123456"
  });
  assert.strictEqual(result.id, "USER_A");
  assert.strictEqual(result.orgId, "ORG_A");
  assert.strictEqual(Object.hasOwn(result, "passwordHash"), false);
  assert.strictEqual(Object.hasOwn(result, "setupTokenHash"), false);
  assert.strictEqual(Object.hasOwn(result, "setupTokenExpiresAt"), false);
  assert.strictEqual(Object.hasOwn(result, "driverPin"), false);
}

function testDeviceTokensAreRevokedAcrossTenantTransfers() {
  const source = fs.readFileSync(path.join(__dirname, "..", "server", "db.js"), "utf8");
  const tokenResolver = source.match(/async function findPairingByDeviceToken[\s\S]*?\n}/)?.[0] || "";
  assert(
    /transferVehicleToOrg[\s\S]*deviceTokenHash:\s*null[\s\S]*deviceTokenIssuedAt:\s*null/.test(source),
    "vehicle tenant transfers must revoke paired-device sessions"
  );
  assert(
    /row\.vehicle\?\.orgId !== row\.orgId \|\| row\.driver\?\.orgId !== row\.orgId/.test(source),
    "device token authentication must verify vehicle and driver tenant ownership"
  );
  assert(
    !tokenResolver.includes("row.expiresAt"),
    "an active device session must not expire with its one-time pairing-code window"
  );
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

function testSessionAndDevAuthContracts() {
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const authStore = fs.readFileSync(path.join(__dirname, "..", "server", "authStore.js"), "utf8");
  assert(
    server.includes('const DEV_SETUP_PASSWORD = process.env.DEV_SETUP_PASSWORD || "";'),
    "development auth bypass must not have a source-code default password"
  );
  assert(
    server.includes('await validateSessionIdentity(result.session, "employee")'),
    "employee sessions must be revalidated against the primary user record"
  );
  assert(
    server.includes('await validateSessionIdentity(session, "customer")'),
    "customer sessions must be revalidated against the primary user record"
  );
  assert(
    server.includes("bindCustomerTenant(req, res, validated, { enforceReadOnly: true })"),
    "read-only customer roles must be blocked from mutations on customer-only routes"
  );
  assert(
    /async function ensureBootstrapCustomer\(data\)[\s\S]*DATABASE_URL[\s\S]*source: "primary_database"/.test(server),
    "database-backed auth must not auto-create a demo customer during login"
  );
  assert(
    authStore.includes('kind === "customer" ? "ORG_DEFAULT" : null'),
    "employee auth records must not be assigned to the default customer organization"
  );
}

(async () => {
  await testPairingOptionsRequiresAuthAndScopes();
  await testPairingGenerationRejectsCrossOrg();
  await testPairingListFiltersAndRemovesSecrets();
  await testSolutionMutationRejectsCrossOrg();
  await testMlStateDoesNotIncludeOrglessRows();
  testCentralTenantGuardFailsClosed();
  await testVehicleListsIgnoreForeignOrgInput();
  await testFeedbackRejectsForeignVehicle();
  await testBillingIsStoredPerOrganization();
  testDeviceTokensAreNotAcceptedOnOrdinaryUrls();
  await testSolutionCollectionsAreIsolatedByOrganization();
  await testDriverProfileRejectsForeignDriverRecord();
  await testMotiveOAuthStateFailsClosed();
  testPublicUserViewRemovesCredentialMaterial();
  testDeviceTokensAreRevokedAcrossTenantTransfers();
  testFrontendAndAndroidContracts();
  testLegacyIngestAndDtcContracts();
  testSessionAndDevAuthContracts();
  console.log("Security boundary tests: 18 passed, 0 failed");
})().catch((err) => {
  console.error("Security boundary tests failed:", err.stack || err.message);
  process.exitCode = 1;
});
