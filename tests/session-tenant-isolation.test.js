"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { bindCustomerTenant } = require("../server/middleware/tenantScope");
const { isEmployeeRole } = require("../server/authStore");
const { createAuthService } = require("../server/auth/authService");
const { protectSessionStream } = require("../server/middleware/sessionStream");
const { buildFleetAdvisorContext } = require("../server/services/advisorContextService");

const source = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
const authSource = fs.readFileSync(path.join(__dirname, "../server/routes/authRoutes.js"), "utf8");
function extract(text, name, indent = "") {
  const expression = new RegExp(`^${indent}(?:async )?function ${name}\\([^]*?^${indent}\\}`, "m");
  const found = text.match(expression);
  assert.ok(found, `Missing production function: ${name}`);
  return found[0];
}

function fixture() {
  const context = {
    process: { env: { DATABASE_URL: "mock-only" } },
    Date, crypto: require("node:crypto"), SESSION_TTL_MS: 60_000,
    CUSTOMER_SESSION_COOKIE: "customer", SESSION_COOKIE: "employee",
    sessionStore: new Map(), customerSessionStore: new Map(),
    persistSessionStoresSoon() {}, bindCustomerTenant, isEmployeeRole,
    nowIso: () => new Date().toISOString(), normalizeEmail: value => value.toLowerCase(),
    parseCookies: value => Object.fromEntries(value.split(";").filter(Boolean).map(item => item.trim().split("="))),
    clearSessionCookie() {}, clearCustomerSessionCookie() {},
    user: { id: "user-a", email: "a@example.test", role: "ORG_ADMIN", orgId: "org-a", org: { id: "org-a" } },
    rows: new Map()
  };
  context.pgSessionStore = {
    getActiveSession: async id => context.rows.get(id) || null,
    upsertSession: async session => context.rows.set(session.id, { ...session }),
    deleteSession: async id => context.rows.delete(id)
  };
  context.sqliteDb = { getPrisma: () => ({ user: { findUnique: async () => ({ ...context.user }) } }) };
  vm.createContext(context);
  for (const name of ["customerRole", "revokeSessionIdentity", "validateSessionIdentity", "issueSession",
    "getSession", "getCustomerSession", "bindStreamSession", "requireCustomerApi", "requireEmployeeOrCustomerApi"]) {
    vm.runInContext(extract(source, name), context);
  }
  return context;
}

function response() {
  return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

test("active customer sessions retain their exact tenant", async () => {
  const ctx = fixture();
  const session = await ctx.issueSession("customer", ctx.user);
  assert.equal((await ctx.validateSessionIdentity(session, "customer")).orgId, "org-a");
});

test("database revocation defeats an otherwise-valid replica cache", async () => {
  const ctx = fixture();
  const session = await ctx.issueSession("customer", ctx.user);
  ctx.rows.delete(session.id);
  assert.equal(await ctx.validateSessionIdentity(session, "customer"), null);
  assert.equal(ctx.customerSessionStore.has(session.id), false);
});

test("organization reassignment invalidates the old session instead of moving it", async () => {
  const ctx = fixture();
  const session = await ctx.issueSession("customer", ctx.user);
  ctx.user.orgId = "org-b";
  ctx.user.org = { id: "org-b" };
  assert.equal(await ctx.validateSessionIdentity(session, "customer"), null);
  assert.equal(session.orgId, "org-a");
});

test("disabled accounts, deleted organizations, and password changes invalidate sessions", async () => {
  for (const change of [{ isActive: false }, { org: null }, { passwordLastSetAt: new Date(Date.now() + 5000).toISOString() }]) {
    const ctx = fixture();
    const session = await ctx.issueSession("customer", ctx.user);
    Object.assign(ctx.user, change);
    assert.equal(await ctx.validateSessionIdentity(session, "customer"), null);
  }
});

test("unknown and customer roles are never staff roles", async () => {
  for (const role of ["", "DRIVER", "VIEWER", "CUSTOMER_USER", "CUSTOMER_VIEWER", "ORG_ADMIN", "UNRECOGNIZED"]) {
    assert.equal(isEmployeeRole({ role }), false);
    const ctx = fixture();
    ctx.user.role = role;
    const session = await ctx.issueSession("employee", ctx.user);
    assert.equal(await ctx.validateSessionIdentity(session, "employee"), null);
  }
  for (const role of ["SUPER_ADMIN", "EMPLOYEE", "ADMIN", "SUPPORT", "SALES"]) assert.equal(isEmployeeRole({ role }), true);
});

test("legacy kind metadata cannot override the authoritative login role", async () => {
  let user = { id: "a", email: "a@example.test", role: "CUSTOMER_USER", kind: "employee" };
  const auth = createAuthService({ loadData: async () => ({ users: [user] }), saveData: async () => {}, issueSession: async () => ({}) });
  assert.equal((await auth.getUserByEmail("employee", user.email)).user, null);
  user = { ...user, role: "SUPER_ADMIN", kind: "customer" };
  assert.equal((await auth.getUserByEmail("customer", user.email)).user, null);
  assert.equal((await auth.getUserByEmail("unknown", user.email)).user, null);
});

test("session issuance waits for persistence and fails closed on storage failure", async () => {
  const ctx = fixture();
  let finish;
  ctx.pgSessionStore.upsertSession = () => new Promise(resolve => { finish = resolve; });
  const pending = ctx.issueSession("customer", ctx.user);
  assert.equal(ctx.customerSessionStore.size, 0);
  finish();
  await pending;
  assert.equal(ctx.customerSessionStore.size, 1);
  ctx.pgSessionStore.upsertSession = async () => { throw new Error("storage unavailable"); };
  await assert.rejects(ctx.issueSession("customer", ctx.user), /storage unavailable/);
  assert.equal(ctx.customerSessionStore.size, 1);
});

test("shared dashboard endpoints prefer the customer identity over staff cookies", async () => {
  const ctx = fixture();
  const customer = await ctx.issueSession("customer", ctx.user);
  ctx.sessionStore.set("staff", { id: "staff", role: "SUPER_ADMIN" });
  const req = { headers: { cookie: `employee=staff; customer=${customer.id}` }, method: "GET", query: {}, body: {}, params: {} };
  let calls = 0;
  await ctx.requireEmployeeOrCustomerApi(req, response(), error => { if (error) throw error; calls++; });
  assert.equal(calls, 1);
  assert.equal(req.authScope.orgId, "org-a");
  assert.equal(req.employee, undefined);
  const denied = response();
  req.headers.cookie = "employee=staff; customer=invalid";
  await ctx.requireEmployeeOrCustomerApi(req, denied, () => assert.fail("must not inherit staff access"));
  assert.equal(denied.statusCode, 401);
});

test("tenant input tampering and viewer mutations are rejected", () => {
  for (const location of ["params", "query", "body"]) {
    const req = { method: "GET", [location]: { orgId: "org-b" } };
    const res = response();
    assert.equal(bindCustomerTenant(req, res, { orgId: "org-a", role: "ORG_ADMIN" }), false);
    assert.equal(res.statusCode, 403);
  }
  assert.equal(bindCustomerTenant({ method: "POST" }, response(), { orgId: "org-a", role: "CUSTOMER_VIEWER" }, { enforceReadOnly: true }), false);
});

test("stream identities cannot follow a role change", async () => {
  const ctx = fixture();
  const session = await ctx.issueSession("customer", ctx.user);
  const req = { headers: { cookie: `customer=${session.id}` } };
  ctx.bindStreamSession(req, session, "customer");
  assert.equal(await req.revalidateSession(), true);
  ctx.user.role = "CUSTOMER_VIEWER";
  assert.equal(await req.revalidateSession(), false);
});

test("an old dashboard tab cannot silently switch organization or user", () => {
  for (const req of [
    { headers: { "x-fleet-org": "org-a" } },
    { headers: { "x-fleet-user": "old-user" } },
    { query: { workspaceUserId: "old-user" } }
  ]) {
    const res = response();
    assert.equal(bindCustomerTenant(req, res, { orgId: "org-b", userId: "new-user" }), false);
    assert.equal(res.body.error, "workspace_changed");
  }
});

test("successful account switching retires both previous sessions before setting cookies", async () => {
  const events = [];
  const ctx = {
    getCustomerSession: () => ({ id: "old-customer" }), getSession: () => ({ id: "old-staff" }),
    customerSessionStore: new Map([["old-customer", {}]]), sessionStore: new Map([["old-staff", {}]]),
    pgSessionStore: { deleteSession: async id => events.push(`delete:${id}`) }, persistSessionStoresSoon() {},
    setCustomerSessionCookie: () => events.push("set:customer"), clearSessionCookie: () => events.push("clear:staff"),
    setSessionCookie: () => events.push("set:staff"), clearCustomerSessionCookie: () => events.push("clear:customer")
  };
  vm.createContext(ctx);
  vm.runInContext(extract(authSource, "establishBrowserSession", "  "), ctx);
  await ctx.establishBrowserSession({}, {}, { id: "new-customer" }, "customer");
  assert.deepEqual(events, ["delete:old-customer", "delete:old-staff", "set:customer", "clear:staff"]);
  assert.equal(ctx.customerSessionStore.size + ctx.sessionStore.size, 0);
  events.length = 0;
  ctx.pgSessionStore.deleteSession = async () => { throw new Error("unavailable"); };
  await assert.rejects(ctx.establishBrowserSession({}, {}, { id: "new" }, "employee"), /unavailable/);
  assert.equal(events.length, 0, "never send a successful login cookie before retirement completes");
});

const tick = () => new Promise(resolve => setImmediate(resolve));
function streamFixture(validate) {
  const req = new EventEmitter();
  req.revalidateSession = validate;
  const res = new EventEmitter();
  res.frames = [];
  res.write = frame => { res.frames.push(frame); return true; };
  res.end = () => { res.ended = true; res.emit("close"); };
  protectSessionStream(req, res);
  return { req, res };
}

test("SSE preserves ordered authorized frames and blocks frames after logout", async () => {
  let valid = true;
  const { res } = streamFixture(async () => valid);
  res.write("one"); res.write("two");
  await tick();
  assert.deepEqual(res.frames, ["one", "two"]);
  valid = false;
  res.write("private-after-logout");
  await tick();
  assert.equal(res.ended, true);
  assert.deepEqual(res.frames, ["one", "two"]);
});

test("SSE stops on authorization errors and bounds queued data", async () => {
  const failed = streamFixture(async () => { throw new Error("unavailable"); });
  failed.res.write("private");
  await tick();
  assert.deepEqual(failed.res.frames, []);
  assert.equal(failed.res.ended, true);
  const busy = streamFixture(async () => false);
  for (let i = 0; i < 33; i++) busy.res.write("queued");
  await tick();
  assert.equal(busy.res.ended, true);
  assert.deepEqual(busy.res.frames, []);
});

test("device stream authorization expires on revocation or reassignment", async () => {
  const db = require("../server/db");
  const { attachDevice } = require("../server/middleware/deviceAuth");
  const original = db.findPairingByDeviceToken;
  let pairing = { id: "p", vehicleId: "v", driverId: "d", orgId: "org-a", deviceId: "tablet" };
  db.findPairingByDeviceToken = async () => pairing;
  try {
    const req = { path: "/api/telemetry/stream", headers: { authorization: "Bearer synthetic-test-token" } };
    await attachDevice(req, {}, () => {});
    assert.equal(await req.revalidateSession(), true);
    pairing = { ...pairing, orgId: "org-b" };
    assert.equal(await req.revalidateSession(), false);
    pairing = null;
    assert.equal(await req.revalidateSession(), false);
  } finally { db.findPairingByDeviceToken = original; }
});

test("Advisor refuses missing tenant scope before querying any data", async () => {
  for (const orgId of [undefined, null, "", "   "]) {
    await assert.rejects(buildFleetAdvisorContext({ orgId, db: { getPrisma: () => assert.fail("unscoped query") } }), /requires an organization/);
  }
});

test("Advisor telemetry requires both sample ownership and current vehicle ownership", async () => {
  let sampleWhere;
  const prisma = new Proxy({}, {
    get: (_target, model) => ({
      findUnique: async () => ({ id: "org-a", name: "Synthetic Fleet A" }),
      findMany: async ({ where }) => {
        if (model === "telemetrySample") sampleWhere = where;
        else assert.equal(where.orgId, "org-a");
        return [];
      }
    })
  });
  await buildFleetAdvisorContext({ db: { getPrisma: () => prisma }, orgId: "org-a", query: "fleet health" });
  assert.equal(sampleWhere.orgId, "org-a");
  assert.equal(sampleWhere.vehicle.orgId, "org-a");
});
