const assert = require("assert");
const { registerOrgManagementRoutes } = require("../server/routes/orgManagementRoutes");

function fakeApp() {
  const routes = new Map();
  const add = (method) => (route, ...handlers) => routes.set(`${method} ${route}`, handlers);
  return { routes, get: add("GET"), post: add("POST"), patch: add("PATCH"), delete: add("DELETE") };
}

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

async function invoke(app, method, route, { body = {}, params = {}, query = {} } = {}) {
  const handlers = app.routes.get(`${method} ${route}`);
  const res = response();
  const req = {
    body,
    params,
    query,
    employee: { userId: "EMP_ADMIN", email: "admin@example.test" }
  };
  await handlers[handlers.length - 1](req, res, (error) => { if (error) throw error; });
  return res;
}

(async () => {
  const app = fakeApp();
  let writes = 0;
  const data = {
    users: [],
    orgs: [{
      id: "ORG_DUPLICATE",
      orgId: "ORG_DUPLICATE",
      name: "Northline Logistics",
      status: "PILOT",
      primaryContactEmail: "owner@example.test"
    }],
    leads: [{
      id: "LEAD_TEST",
      leadId: "LEAD_TEST",
      companyName: "Northline Logistics",
      contactName: "Fleet Owner",
      contactEmail: "owner@example.test",
      status: "CONVERTED",
      orgId: "ORG_DUPLICATE"
    }],
    audit: []
  };
  const authData = {
    users: [{
      id: "USER_OWNER",
      email: "owner@example.test",
      role: "ORG_ADMIN",
      kind: "customer",
      orgId: "ORG_CANONICAL"
    }],
    orgs: [{
      id: "ORG_CANONICAL",
      name: "Northline Logistics",
      status: "PILOT",
      email: "owner@example.test",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z"
    }]
  };

  registerOrgManagementRoutes(app, {
    readData: async () => data,
    writeData: async () => { writes += 1; },
    requireEmployeeApi: (_req, _res, next) => next(),
    requireCustomerApi: (_req, _res, next) => next(),
    requireRole: () => (_req, _res, next) => next(),
    getRateState: () => ({ allowed: true }),
    prismaAuthAdapter: {
      async loadData() { return structuredClone(authData); },
      async saveData() {}
    }
  });

  const converted = await invoke(app, "POST", "/api/leads/:leadId/convert", {
    params: { leadId: "LEAD_TEST" },
    body: { status: "PILOT" }
  });
  assert.strictEqual(converted.statusCode, 200);
  assert.strictEqual(converted.body.data.reused, true);
  assert.strictEqual(converted.body.data.recovered, true);
  assert.strictEqual(converted.body.data.org.orgId, "ORG_CANONICAL");
  assert.strictEqual(data.leads[0].orgId, "ORG_CANONICAL");
  assert.strictEqual(data.orgs.length, 2, "conversion must recover, not create, the canonical org");

  const repeated = await invoke(app, "POST", "/api/leads/:leadId/convert", {
    params: { leadId: "LEAD_TEST" },
    body: { status: "PILOT" }
  });
  assert.strictEqual(repeated.body.data.org.orgId, "ORG_CANONICAL");
  assert.strictEqual(data.orgs.length, 2, "repeated conversion must be idempotent");

  const listed = await invoke(app, "GET", "/api/orgs", { query: {} });
  assert.deepStrictEqual(listed.body.data.map((org) => org.orgId), ["ORG_CANONICAL"]);

  const withDuplicates = await invoke(app, "GET", "/api/orgs", { query: { includeDeleted: "1" } });
  const duplicate = withDuplicates.body.data.find((org) => org.orgId === "ORG_DUPLICATE");
  assert.strictEqual(duplicate.duplicateOf, "ORG_CANONICAL");

  const access = await invoke(app, "POST", "/api/orgs/:orgId/customer/create", {
    params: { orgId: "ORG_DUPLICATE" },
    body: { email: "owner@example.test" }
  });
  assert.strictEqual(access.statusCode, 200);
  assert.strictEqual(access.body.data.redirectOrgId, "ORG_CANONICAL");
  assert.strictEqual(access.body.data.alreadyExists, true);
  assert.ok(writes > 0, "recovered org index and lead link must be persisted");

  console.log("Organization conversion recovery tests passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
