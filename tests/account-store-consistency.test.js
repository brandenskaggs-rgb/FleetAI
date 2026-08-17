const assert = require("assert");
const { registerOrgManagementRoutes } = require("../server/routes/orgManagementRoutes");
const { normalizeAuthData } = require("../server/authStore");
const { applyAuthStoreRepair } = require("../server/auth/repairAuthStore");

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
  const req = {
    body,
    params,
    query,
    employee: { userId: "EMP_ADMIN", email: "admin@example.test" }
  };
  const res = response();
  await handlers[handlers.length - 1](req, res, (error) => { if (error) throw error; });
  return res;
}

(async () => {
  const normalized = normalizeAuthData({
    users: [
      { email: "employee@example.test", role: "SUPER_ADMIN", kind: "employee" },
      { email: "customer@example.test", role: "CUSTOMER", kind: "customer" }
    ],
    orgs: []
  });
  assert.strictEqual(normalized.users[0].orgId, null);
  assert.strictEqual(normalized.users[1].orgId, "ORG_DEFAULT");
  const repairedStore = await applyAuthStoreRepair({ users: [], orgs: [] }, {
    demoUsers: [{ email: "demo.employee@example.test", role: "SUPER_ADMIN", kind: "employee" }],
    defaultOrgId: "ORG_DEFAULT"
  });
  assert.strictEqual(repairedStore.data.users[0].orgId, null);

  const app = fakeApp();
  const events = [];
  const data = {
    users: [{
      id: "USR_ORPHAN",
      email: "orphan.employee@example.test",
      role: "SUPPORT",
      kind: "employee",
      passwordHash: "existing-hash",
      isActive: true
    }],
    orgs: [{
      id: "ORG_TEST",
      orgId: "ORG_TEST",
      name: "Test Fleet",
      status: "PILOT",
      primaryContactEmail: "owner@example.test"
    }],
    invites: [{
      id: "INV_TEST",
      token: "invite-token",
      type: "CUSTOMER",
      orgId: "ORG_TEST",
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    }],
    audit: []
  };
  let authUsers = [{
    id: "USR_PRIMARY",
    email: "primary.employee@example.test",
    role: "SUPER_ADMIN",
    kind: "employee",
    passwordHash: "primary-hash",
    isActive: true
  }];
  const prismaAuthAdapter = {
    async loadData() { return { users: structuredClone(authUsers), orgs: [] }; },
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

  const listed = await invoke(app, "GET", "/api/employees");
  assert.strictEqual(listed.statusCode, 200);
  assert.strictEqual(authUsers.length, 1, "employee listing must not recreate a stale JSON-only login");
  assert.deepStrictEqual(listed.body.data.map((user) => user.email), ["primary.employee@example.test"]);
  assert.ok(!data.users.some((user) => user.email === "orphan.employee@example.test"));

  events.length = 0;
  const created = await invoke(app, "POST", "/api/employees", {
    body: { email: "new.employee@example.test", role: "SALES" }
  });
  assert.strictEqual(created.statusCode, 201);
  assert.ok(created.body.data.tempPassword.length >= 10);
  assert.deepStrictEqual(events.slice(-2), ["auth", "json"], "employee login authority must be written first");
  const createdAuthUser = authUsers.find((user) => user.email === "new.employee@example.test");
  assert.strictEqual(createdAuthUser.kind, "employee");
  assert.strictEqual(createdAuthUser.mustResetPassword, true);

  events.length = 0;
  const accepted = await invoke(app, "POST", "/api/invites/:token/accept", {
    params: { token: "invite-token" },
    body: { email: "invited.owner@example.test", password: "LongEnoughPass123!" }
  });
  assert.strictEqual(accepted.statusCode, 200);
  assert.deepStrictEqual(events, ["auth", "json"], "accepted invite must create login before consuming invite");
  const invitedUser = authUsers.find((user) => user.email === "invited.owner@example.test");
  assert.strictEqual(invitedUser.role, "ORG_ADMIN");
  assert.strictEqual(invitedUser.kind, "customer");
  assert.strictEqual(invitedUser.orgId, "ORG_TEST");
  assert.strictEqual(data.invites.length, 0);

  console.log("Account store consistency tests passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
