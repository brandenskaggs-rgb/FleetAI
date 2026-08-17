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

async function invoke(app, route, body) {
  const handlers = app.routes.get(`POST ${route}`);
  const res = response();
  const req = {
    body,
    params: { orgId: "ORG_TEST" },
    employee: { userId: "EMP_ADMIN", email: "admin@example.test" }
  };
  await handlers[handlers.length - 1](req, res, (error) => { if (error) throw error; });
  return res;
}

(async () => {
  const app = fakeApp();
  const events = [];
  const data = {
    users: [],
    orgs: [{
      id: "ORG_TEST",
      orgId: "ORG_TEST",
      name: "Test Fleet",
      status: "PILOT",
      primaryContactEmail: "owner@example.test",
      primaryContactName: "Fleet Owner"
    }]
  };
  let authUsers = [];
  const prismaAuthAdapter = {
    async loadData() { return { users: authUsers, orgs: [] }; },
    async saveData(next) {
      events.push("auth");
      for (const user of next.users || []) {
        authUsers = authUsers.filter((item) => item.email !== user.email).concat(structuredClone(user));
      }
    }
  };
  registerOrgManagementRoutes(app, {
    readData: async () => data,
    writeData: async () => { events.push("json"); },
    requireEmployeeApi: (_req, _res, next) => next(),
    requireCustomerApi: (_req, _res, next) => next(),
    requireRole: () => (_req, _res, next) => next(),
    getRateState: () => ({ allowed: true }),
    prismaAuthAdapter
  });

  const created = await invoke(app, "/api/orgs/:orgId/customer/create", {
    email: "Owner@Example.Test",
    contactName: "Fleet Owner"
  });
  assert.strictEqual(created.statusCode, 201);
  assert.ok(created.body.data.tempPassword.length >= 10);
  assert.strictEqual(data.users.length, 1);
  assert.strictEqual(authUsers.length, 1);
  assert.strictEqual(authUsers[0].kind, "customer");
  assert.deepStrictEqual(events.slice(0, 2), ["auth", "json"], "login database must be written before the JSON index");

  // Reproduce the production failure: JSON says the user exists, while the
  // Prisma auth store used by customer login lost or never received the row.
  authUsers = [];
  events.length = 0;
  const repaired = await invoke(app, "/api/orgs/:orgId/create-customer-login", {
    email: "owner@example.test"
  });
  assert.strictEqual(repaired.statusCode, 200);
  assert.strictEqual(repaired.body.data.repaired, true);
  assert.strictEqual(data.users.length, 1, "repair must not duplicate the JSON user");
  assert.strictEqual(authUsers.length, 1, "repair must restore the login database row");

  console.log("Customer provisioning tests passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
