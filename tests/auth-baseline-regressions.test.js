"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const bcrypt = require("bcryptjs");

// These tests exercise production handlers with in-memory stores, never live services.
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;
delete process.env.REDIS_PRIVATE_URL;
const db = require("../server/db");
let prisma;
db.getPrisma = () => { assert.ok(prisma, "unexpected database access"); return prisma; };
db.getOrg = async id => ({ id, status: "PILOT" });
const sessions = require("../server/pgSessionStore");
const { createAuthService } = require("../server/auth/authService");
const { registerAdminRoutes } = require("../server/routes/adminRoutes");
const { registerAuthRoutes } = require("../server/routes/authRoutes");
const { registerOrgManagementRoutes } = require("../server/routes/orgManagementRoutes");
const { registerMotiveOAuthRoutes } = require("../server/routes/motiveOAuthRoutes");
const motiveOAuth = require("../server/services/motiveOAuth");
const motiveClient = require("../server/services/motiveClient");

function fakeApp() {
  const routes = new Map();
  const mounts = new Map();
  const app = { routes, mounts, use: (path, router) => mounts.set(path, router) };
  for (const method of ["get", "post", "put", "patch", "delete", "all"]) {
    app[method] = (path, ...handlers) => routes.set(`${method.toUpperCase()} ${path}`, handlers);
  }
  return app;
}

function response() {
  let finish;
  const done = new Promise(resolve => { finish = resolve; });
  return {
    statusCode: 200, done,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; finish(); return this; },
    redirect(url) { this.location = url; finish(); return this; }
  };
}

async function invoke(handler, req) {
  const res = response();
  await handler(req, res, error => { throw error; });
  await res.done;
  return res;
}

test("deleted or missing customer organizations cannot log in or finish password setup", async () => {
  const password = "Synthetic-password-123";
  const user = { id: "customer", email: "customer@example.test", role: "ORG_ADMIN", orgId: "org", isActive: true, passwordHash: await bcrypt.hash(password, 4) };
  const data = { users: [user], orgs: [{ id: "org", status: "PILOT" }] };
  let issued = 0;
  const service = createAuthService({ loadData: async () => data, saveData: async () => {}, issueSession: async () => ({ id: `session-${++issued}` }) });
  for (const status of ["ACTIVE", "PILOT", "LEAD"]) {
    data.orgs[0].status = status;
    assert.equal((await service.authenticate("customer", user.email, password)).ok, true);
  }
  const token = service.issueSetupToken(user).token;
  for (const orgs of [[{ id: "org", status: "DELETED" }], []]) {
    data.orgs = orgs;
    assert.equal((await service.getUserByEmail("customer", user.email)).user, null, "development login fallback cannot bypass deleted organization checks");
    assert.equal((await service.authenticate("customer", user.email, password)).ok, false);
    assert.equal((await service.setPasswordWithToken(token, "Replacement-password-123")).ok, false);
  }
  assert.equal(issued, 3);
  assert.equal(await bcrypt.compare(password, user.passwordHash), true);
});

test("optional-password provisioning returns a usable one-time temporary credential", async () => {
  const app = fakeApp();
  const data = { users: [], orgs: [] };
  const primaryUsers = [];
  registerAdminRoutes(app, {
    readData: async () => data, writeData: async () => {}, requireSuperAdmin: (_req, _res, next) => next(),
    prismaAuthAdapter: {
      loadData: async () => ({ users: primaryUsers, orgs: [] }),
      saveData: async next => primaryUsers.push(...structuredClone(next.users))
    }
  });
  const router = app.mounts.get("/api/admin");
  const create = router.stack.find(layer => layer.route?.path === "/users" && layer.route.methods.post).route.stack.at(-1).handle;
  const created = await invoke(create, { body: { email: "employee@example.test", role: "EMPLOYEE" } });
  assert.equal(created.body.ok, true);
  assert.ok(created.body.data.tempPassword.length >= 10);
  assert.equal(created.body.data.passwordHash, undefined);
  const user = primaryUsers[0];
  assert.ok(await bcrypt.compare(created.body.data.tempPassword, user.passwordHash));
  const service = createAuthService({ loadData: async () => ({ users: primaryUsers, orgs: [] }), saveData: async () => {}, issueSession: async () => ({ id: "issued" }) });
  const setup = await service.authenticate("employee", user.email, created.body.data.tempPassword);
  assert.equal(setup.error.code, "PASSWORD_SETUP_REQUIRED");
  assert.equal((await service.setPasswordWithToken(setup.next.token, "New-synthetic-password-123")).ok, true);
  assert.equal((await service.authenticate("employee", user.email, "New-synthetic-password-123")).ok, true);
  assert.equal((await service.authenticate("employee", user.email, created.body.data.tempPassword)).ok, false);
  const explicit = await invoke(create, { body: { email: "second@example.test", role: "EMPLOYEE", password: "Explicit-password-123" } });
  assert.equal(explicit.body.data.tempPassword, undefined);
  assert.equal(explicit.body.data.mustSetPassword, false);
});

test("only the self-password endpoint uses the viewer-compatible guard and still verifies the old password", async () => {
  const app = fakeApp();
  const standard = () => {};
  const passwordGuard = () => {};
  let writes = 0;
  let revocations = 0;
  const user = { id: "viewer", passwordHash: await bcrypt.hash("Old-password-123", 4) };
  prisma = { user: { findUnique: async () => user, update: async ({ data }) => { writes++; Object.assign(user, data); return user; } } };
  registerAuthRoutes(app, {
    requireCustomerApi: standard, requireCustomerPasswordApi: passwordGuard, bcrypt,
    revokeUserSessions: async id => { assert.equal(id, user.id); revocations++; },
    issueSession: async () => ({ id: "new-session" }), setCustomerSessionCookie() {}
  });
  const handlers = app.routes.get("POST /api/auth/password/update");
  assert.equal(handlers[0], passwordGuard);
  assert.equal(app.routes.get("POST /api/auth/reset-password")[0], standard);
  const req = { customer: { userId: user.id }, body: { currentPassword: "wrong", newPassword: "New-password-123" } };
  assert.equal((await invoke(handlers.at(-1), req)).statusCode, 401);
  assert.equal(writes, 0);
  req.body.currentPassword = "Old-password-123";
  assert.equal((await invoke(handlers.at(-1), req)).body.ok, true);
  assert.equal(revocations, 1);
  assert.equal(await bcrypt.compare("New-password-123", user.passwordHash), true);
});

test("invites cannot create access to a soft-deleted organization", async () => {
  const app = fakeApp();
  const token = "synthetic-invite";
  const data = { orgs: [{ id: "org", status: "DELETED" }], invites: [{ orgId: "org", tokenHash: crypto.createHash("sha256").update(token).digest("hex"), expiresAt: new Date(Date.now() + 60000).toISOString() }] };
  registerOrgManagementRoutes(app, {
    readData: async () => data, requireRole: () => () => {},
    writeData: async () => assert.fail("must not write deleted org invitations")
  });
  assert.equal((await invoke(app.routes.get("POST /api/invites").at(-1), { body: { orgId: "org", type: "CUSTOMER" } })).statusCode, 404);
  assert.equal((await invoke(app.routes.get("POST /api/invites/:token/accept").at(-1), { params: { token }, body: { email: "new@example.test", password: "Synthetic-password-123" } })).statusCode, 410);
});

function sessionDatabase() {
  const rows = new Map();
  const matches = (row, where) => row && Object.entries(where).every(([key, value]) => value?.gt ? row[key] > value.gt : row[key] === value);
  prisma = { session: {
    updateMany: async ({ where, data }) => {
      const row = rows.get(where.id);
      if (!matches(row, where)) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    },
    findFirst: async ({ where }) => matches(rows.get(where.id), where) ? structuredClone(rows.get(where.id)) : null
  } };
  return rows;
}

test("Motive callbacks survive persisted-session reload and reject replay, wrong-session, expired and revoked state", async (t) => {
  process.env.DATABASE_URL = "mock-only";
  process.env.MOTIVE_CLIENT_ID = "synthetic-client";
  process.env.FLEETAI_BASE_URL = "https://fleet.example.test";
  t.after(() => { delete process.env.DATABASE_URL; delete process.env.MOTIVE_CLIENT_ID; delete process.env.FLEETAI_BASE_URL; });
  const rows = sessionDatabase();
  rows.set("staff", { id: "staff", userId: "admin", loginRole: "employee", createdAt: new Date(), expiresAt: new Date(Date.now() + 3600000) });
  rows.set("other", { ...structuredClone(rows.get("staff")), id: "other" });
  let session = await sessions.getActiveSession("staff");
  const app = fakeApp();
  let exchanges = 0;
  t.mock.method(motiveOAuth, "exchangeCode", async () => { exchanges++; return { access_token: "synthetic-token" }; });
  t.mock.method(motiveOAuth, "saveTokens", async () => {});
  t.mock.method(motiveClient, "setAccessToken", () => {});
  registerMotiveOAuthRoutes(app, { requireSuperAdmin: (_req, _res, next) => next(), sessionStore: new Map(), getSession: () => session });
  const connect = app.routes.get("GET /api/auth/motive/connect").at(-1);
  const callback = app.routes.get("GET /api/auth/motive/callback").at(-1);
  const redirect = await invoke(connect, { headers: {} });
  const state = new URL(redirect.location).searchParams.get("state");
  assert.notEqual(rows.get("staff").motiveOAuthStateHash, state, "state is stored hashed");
  session = await sessions.getActiveSession("staff");
  const request = { headers: {}, query: { code: "synthetic-code", state } };
  session = await sessions.getActiveSession("other");
  assert.equal((await invoke(callback, request)).statusCode, 403);
  session = await sessions.getActiveSession("staff");
  assert.match((await invoke(callback, request)).location, /motive_connected=1/);
  assert.equal(exchanges, 1);
  assert.equal((await invoke(callback, request)).statusCode, 403);
  await sessions.setMotiveOAuthState(session, state);
  const raced = await Promise.all([sessions.consumeMotiveOAuthState(session, state), sessions.consumeMotiveOAuthState(session, state)]);
  assert.deepEqual(raced.sort(), [false, true]);
  await sessions.setMotiveOAuthState(session, state);
  const replacementState = crypto.randomBytes(16).toString("hex");
  await sessions.setMotiveOAuthState(session, replacementState);
  assert.equal(await sessions.consumeMotiveOAuthState(session, state), false, "starting again retires the prior state");
  assert.equal(await sessions.consumeMotiveOAuthState(session, replacementState), true);
  await sessions.setMotiveOAuthState(session, state);
  rows.get("staff").motiveOAuthStateExpiresAt = new Date(0);
  assert.equal(await sessions.consumeMotiveOAuthState(session, state), false);
  await sessions.setMotiveOAuthState(session, state);
  rows.delete("staff");
  assert.equal(await sessions.consumeMotiveOAuthState(session, state), false);
  await assert.rejects(sessions.setMotiveOAuthState(session, state), /unavailable/);
  assert.equal(exchanges, 1);
  assert.ok(rows.has("other"), "unrelated session remains intact");
});

test("memory-only OAuth state is expiring and one-time too", async () => {
  const session = { id: "memory", expiresAt: Date.now() + 60000 };
  const state = crypto.randomBytes(16).toString("hex");
  await sessions.setMotiveOAuthState(session, state);
  assert.equal(await sessions.consumeMotiveOAuthState(session, state), true);
  assert.equal(await sessions.consumeMotiveOAuthState(session, state), false);
  await sessions.setMotiveOAuthState(session, state);
  session.motiveOAuthStateExpiresAt = new Date(0);
  assert.equal(await sessions.consumeMotiveOAuthState(session, state), false);
});
