const assert = require("node:assert/strict");
const { test } = require("node:test");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const db = require("../server/db");
const { requireApiKey, issueStreamTicket, hashApiKey } = require("../server/middleware/apiKeyAuth");
const { createPartnerStreamSession } = require("../server/services/partnerStreamSession");

test("partner ticket authentication fails closed and binds current tenant/tier", async (t) => {
  const identity = { id: "hardening-key", orgId: "ORG_A", partner: "Partner", tier: "partner_ml" };
  let record = { ...identity, partnerName: identity.partner, enabled: true };
  let unavailable = false;
  const original = db.getPrisma;
  db.getPrisma = () => ({ apiKey: { findUnique: async () => { if (unavailable) throw new Error("private-database-address"); return record; } } });
  t.after(() => { db.getPrisma = original; });
  async function redeem(ticket, vehicleId) {
    const req = { method: "GET", path: "/api/partner/stream", headers: {}, query: { streamTicket: ticket, vehicleId } };
    const res = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
    let passed = false;
    await requireApiKey(req, res, () => { passed = true; });
    return { passed, ...res };
  }
  await t.test("changed tenant invalidates an outstanding ticket", async () => {
    const issued = issueStreamTicket(identity);
    record.orgId = "ORG_B";
    assert.equal((await redeem(issued.ticket)).code, 403);
    record.orgId = identity.orgId;
  });
  await t.test("downgraded tier invalidates an outstanding ticket", async () => {
    const issued = issueStreamTicket(identity);
    record.tier = "standard";
    assert.equal((await redeem(issued.ticket)).code, 403);
    record.tier = identity.tier;
  });
  await t.test("database failure never uses cached authorization", async () => {
    const issued = issueStreamTicket(identity);
    unavailable = true;
    const result = await redeem(issued.ticket);
    assert.equal(result.code, 503);
    assert(!JSON.stringify(result.body).includes("private-database"));
    unavailable = false;
  });
  await t.test("vehicle-scoped ticket works once and cannot open fleet stream", async () => {
    const allowed = issueStreamTicket(identity, "VEHICLE_A");
    assert.equal((await redeem(allowed.ticket, "VEHICLE_A")).passed, true);
    assert.equal((await redeem(allowed.ticket, "VEHICLE_A")).code, 403);
    const denied = issueStreamTicket(identity, "VEHICLE_A");
    assert.equal((await redeem(denied.ticket)).code, 403);
  });
  await t.test("expired tickets are rejected", async () => {
    const issued = issueStreamTicket(identity);
    const now = Date.now;
    Date.now = () => now() + 61_000;
    try { assert.equal((await redeem(issued.ticket)).code, 403); }
    finally { Date.now = now; }
  });
  await t.test("outstanding tickets have a per-key bound", () => {
    for (let i = 0; i < 20; i++) assert(issueStreamTicket(identity));
    assert.equal(issueStreamTicket(identity), null);
  });
});

test("live streams stop after revocation, database failure, timeout or disconnect", async (t) => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  for (const scenario of ["revoked", "database_error", "database_stalled", "expired", "disconnect", "backpressure"]) {
    await t.test(scenario, async () => {
      const req = new EventEmitter();
      const res = new EventEmitter();
      const writes = [];
      let closes = 0;
      res.write = (data) => { writes.push(data); return scenario !== "backpressure"; };
      res.end = () => { res.writableEnded = true; res.emit("close"); };
      const session = createPartnerStreamSession({ req, res, identity: { id: "test" },
        authorize: async () => {
          if (scenario === "database_error") throw new Error("offline");
          if (scenario === "database_stalled") return new Promise(() => {});
          return scenario === "revoked" ? null : { id: "test" };
        }, onClose: () => { closes++; }, recheckMs: 5, leaseMs: 25, maxAgeMs: 45 });
      session.write("initial");
      if (scenario === "disconnect") res.emit("close");
      await sleep(90);
      assert.equal(closes, 1);
      const count = writes.length;
      session.write("must-not-deliver");
      assert.equal(writes.length, count);
      session.close();
      assert.equal(closes, 1);
    });
  }
});

test("partner widget treats all API display strings as text", () => {
  const source = fs.readFileSync(path.join(__dirname, "../embed/fleet-widget.js"), "utf8");
  // Expose the actual private renderer inside an isolated VM; no production exports.
  const context = { document: { currentScript: null, addEventListener() {} } };
  vm.runInNewContext(source.replace("  document.addEventListener(\"DOMContentLoaded\"", "  globalThis.testRender = render;\n  document.addEventListener(\"DOMContentLoaded\""), context);
  const injection = '<img src=x onerror="globalThis.compromised=true">';
  const target = {};
  context.testRender(target, {
    vehicleId: injection, advisoryText: injection, prediction: injection, riskProbability: 0.4,
    sensorRisks: { rpm: injection, coolantTemp: 50 },
    diagnosis: { components: [{ component: injection, evidence: [injection], mechanic_action: injection, estimated_cost: injection }] }
  }, { available: true, urgency: "high", estimatedDaysToService: injection, recommendation: injection, subsystem: injection });
  assert(!target.innerHTML.includes("<img"));
  assert(target.innerHTML.includes("&lt;img"));
  assert(!target.innerHTML.includes("undefined"));
});

test("revoked partner keys cannot schedule webhook deliveries", async (t) => {
  const { fireWebhooks } = require("../server/services/webhookService");
  const original = db.getPrisma;
  let enabled = false;
  let lookupCount = 0;
  let unavailable = false;
  db.getPrisma = () => ({
    apiKey: { findUnique: async () => { if (unavailable) throw new Error("offline"); return { enabled, tier: "partner_ml" }; } },
    partnerWebhook: { findMany: async ({ where }) => { assert.equal(where.apiKeyId, "KEY_A"); lookupCount++; return []; } }
  });
  t.after(() => { db.getPrisma = original; });
  await fireWebhooks("A", "KEY_A", "risk_threshold_crossed", {}, 0.9);
  assert.equal(lookupCount, 0);
  enabled = true;
  await fireWebhooks("A", "KEY_A", "risk_threshold_crossed", {}, 0.9);
  assert.equal(lookupCount, 1);
  unavailable = true;
  await fireWebhooks("A", "KEY_A", "risk_threshold_crossed", {}, 0.9);
  assert.equal(lookupCount, 1);
});

test("real partner HTTP routes reject anonymous access and isolate identical vehicle names", async (t) => {
  const express = require("express");
  const rows = [];
  const queries = [];
  const calls = [];
  let queryFailure = false;
  const keys = ["A", "B"].map((suffix) => ({ id: `key_${suffix}`, keyHash: hashApiKey(`test_${suffix}`), orgId: `ORG_${suffix}`, partnerName: "same-display-name", tier: "partner_ml", enabled: true }));
  const original = db.getPrisma;
  db.getPrisma = () => ({
    apiKey: { findUnique: async ({ where }) => keys.find((k) => where.keyHash ? k.keyHash === where.keyHash : k.id === where.id), update: async () => ({}) },
    mlPredictionRun: { findMany: async (query) => { if (queryFailure) throw new Error("private-db-host-and-query"); queries.push(query); return rows.filter((r) => r.orgId === query.where.orgId && (!query.where.vehicleId || r.vehicleId === query.where.vehicleId)); } },
    partnerWebhook: { findMany: async () => [], findFirst: async () => null }
  });
  const { registerPartnerRoutes } = require("../server/routes/partnerRoutes");
  const app = express();
  app.use(express.json({ limit: "256kb" }));
  registerPartnerRoutes(app, {
    ml: { computeFullPrediction: () => ({ sensorRisks: {}, insufficientData: true }) },
    pythonMlClient: { predict: async (payload) => { calls.push(payload); return { riskProbability: 0.1, confidence: 0.4, prediction: "NORMAL" }; }, status: async () => ({ isolationForest: { trained: true }, welford: { ready: true, history: { privateState: true } }, telemetry: { dbSampleCount: 12 }, database: { available: true } }) },
    sqliteDb: { insertMlPredictionRun: async (row) => { rows.push({ ...row, predictionJson: row.prediction, createdAt: new Date() }); } },
    nowIso: () => new Date().toISOString(), sanitizeString: (value, size) => String(value || "").trim().slice(0, size),
    requireSuperAdmin: (_req, res) => res.sendStatus(401)
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); db.getPrisma = original; });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (route, key, body) => fetch(base + route, { method: body === undefined ? "GET" : "POST", headers: { ...(key ? { "X-API-Key": key } : {}), "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.equal((await request("/api/partner/fleet")).status, 401);
  assert.equal((await request("/api/partner/fleet", "unknown")).status, 403);
  const payload = { vehicleId: "SHARED_NAME", orgId: "ORG_B", samples: [{ rpm: 800, coolantTemp: 90 }] };
  assert.equal((await request("/api/partner/predict", "test_A", payload)).status, 200);
  assert.equal((await request("/api/partner/vehicles/SHARED_NAME/live", "test_B")).status, 404);
  assert.equal((await request("/api/partner/predict", "test_B", payload)).status, 200);
  assert.notEqual(calls[0].orgId, calls[1].orgId);
  assert.notEqual(calls[0].vehicleId, calls[1].vehicleId);
  assert.notEqual(calls[0].orgId, payload.orgId, "caller cannot choose its tenant");
  for (const key of ["test_A", "test_B"]) {
    const fleet = await (await request("/api/partner/fleet", key)).json();
    assert.equal(fleet.vehicles.length, 1);
    await request("/api/partner/vehicles/SHARED_NAME/history", key);
  }
  assert.notEqual(queries[0].where.orgId, queries[2].where.orgId);
  assert.notEqual(queries[1].where.vehicleId, queries[3].where.vehicleId);
  const malformed = await request("/api/partner/predict", "test_A", { vehicleId: "X", samples: [null, 1, [], { rpm: null, coolantTemp: "", engineLoad: false }] });
  assert.equal(malformed.status, 400, "invalid and missing sensor inputs are not fabricated as zero");
  const readiness = await (await request("/api/partner/status?vehicleId=SHARED_NAME", "test_A")).json();
  assert.deepEqual(readiness.status, { mlServiceAvailable: true, modelLoaded: null, sampleCount: 12, baselineEstablished: true });
  const weakSecret = await request("/api/partner/webhooks", "test_A", { url: "https://example.com/hook", secret: "a" });
  assert.equal(weakSecret.status, 400);
  queryFailure = true;
  const failed = await request("/api/partner/fleet", "test_A");
  assert.equal(failed.status, 500);
  assert(!(await failed.text()).includes("private-db-host"));
  keys[0].enabled = false;
  assert.equal((await request("/api/partner/vehicles/SHARED_NAME/live", "test_A")).status, 403);
});
