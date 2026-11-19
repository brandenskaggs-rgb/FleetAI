const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const db = require("../server/db");
const { runLiveDiagnostic, isLiveDiagnosticRequest } = require("../server/services/liveDiagnosticService");
const { registerSolutionRoutes } = require("../server/routes/solutionRoutes");
const now = new Date("2026-11-18T17:00:00Z");

function fixture({ rows = [], snapshot = null } = {}) {
  const artifacts = [];
  const assertScope = where => {
    assert.equal(where.orgId, "A"); assert.equal(where.vehicleId, "carA"); assert.equal(where.vehicle.orgId, "A");
  };
  const prisma = {
    vehicle: { findFirst: async ({ where }) => where.orgId === "A" && where.vehicleId === "carA" ? { vehicleId: "carA", unitName: "Camaro" } : null },
    telemetrySample: { findMany: async ({ where, take }) => { assertScope(where); assert.ok(take <= 120); return rows; } },
    mlPredictionRun: { findFirst: async ({ where }) => { assertScope(where); return null; } },
    advisorArtifact: {
      create: async ({ data }) => { artifacts.push(data); return { ...data, id: "reportA", createdAt: now }; },
      findFirst: async ({ where }) => {
        assert.equal(where.orgId, "A"); assert.equal(where.content.equals, "carA");
        return artifacts.length ? { id: "reportA", type: "live_diagnostic", title: "Saved analysis", createdAt: now } : null;
      }
    }
  };
  return { prisma, artifacts, telemetryLatest: new Map(snapshot ? [["carA", snapshot]] : []), orgId: "A", vehicleId: "carA", now };
}
const sample = (metrics, age = 0, raw = {}) => ({ id: "sampleA", orgId: "A", vehicleId: "carA", ts: new Date(now - age), metrics, raw });
const live = (overrides = {}) => ({ vehicleId: "carA", busDataActive: true, ts: now, lastObdPacketAt: now,
  metrics: { orgId: "A", engine: { rpm: 800 }, transmission: { transmissionTempC: 85 } },
  deviceDiagnostics: { metricAgesMs: { rpm: 500, transmissionTempC: 31_000 } }, ...overrides });

test("diagnostic intent is explicit and negative commands do not run it", () => {
  for (const text of ["Run a live diagnostic scan", "Can you do a diagnostic scan of Camaro?", "scan my car"]) assert.equal(isLiveDiagnosticRequest(text), true);
  for (const text of ["don't run a diagnostic scan", "stop diagnostic scan", "what is a diagnostic scan", "watch the transmission"]) assert.equal(isLiveDiagnosticRequest(text), false);
});

test("no data is unknown, not a clean scan or permission to drive", async () => {
  const report = await runLiveDiagnostic(fixture());
  assert.equal(report.counts.fresh, 0);
  assert.equal(report.faultCodes.status, "not_read");
  assert.equal(report.transmission.recorded.length, 0);
  assert.match(report.summary, /cannot confirm transmission slip/);
  assert.match(report.summary, /does not establish.*safe to drive/);
});

test("freshness is per signal; cached ages continue increasing and heartbeat is not ECU data", async () => {
  let report = await runLiveDiagnostic(fixture({ snapshot: live(), rows: [sample({ transmissionTempC: 82, rpm: 700 }, 60_000)] }));
  assert.equal(report.readings.find(r => r.signal === "rpm").state, "fresh");
  const temperature = report.readings.find(r => r.signal === "transmissionTempC");
  assert.equal(temperature.state, "stale"); assert.equal(temperature.value, 82);
  for (const snapshot of [live({ busDataActive: false }), live({ lastObdPacketAt: new Date(now - 60_000) }), live({ ts: new Date(now.getTime() + 60_000) }), live({ deviceDiagnostics: {} })]) {
    report = await runLiveDiagnostic(fixture({ snapshot }));
    assert.equal(report.counts.fresh, 0);
  }
  report = await runLiveDiagnostic(fixture({ snapshot: live({ ts: new Date(now - 12_000), deviceDiagnostics: { metricAgesMs: { rpm: 20_000 } } }) }));
  assert.equal(report.counts.fresh, 0);
});

test("tenant ownership is checked before reads and mismatched cached/customer samples are excluded", async () => {
  const f = fixture({ snapshot: live({ metrics: { orgId: "B", engine: { rpm: 9999 } } }), rows: [{ ...sample({ rpm: 7777 }), orgId: "B" }] });
  assert.equal((await runLiveDiagnostic(f)).readings.find(r => r.signal === "rpm").value, null);
  assert.equal(await runLiveDiagnostic({ ...f, orgId: "B" }), null);
  await assert.rejects(() => runLiveDiagnostic({ ...f, orgId: "" }), /scope_required/);
});

test("recent buffered uploads are not a live connection; real zero stays zero", async () => {
  const report = await runLiveDiagnostic(fixture({ rows: [sample({ vehicleSpeed: 0, rpm: 0, transmissionTempC: null, customSensor: 12 })] }));
  assert.equal(report.connection, "live_connection_not_verified");
  assert.equal(report.readings.find(r => r.signal === "speedKph").value, 0);
  assert.equal(report.readings.find(r => r.signal === "rpm").state, "recent_record");
  assert.equal(report.readings.find(r => r.signal === "customSensor").unit, "not specified");
});

test("fault evidence uses acquisition time, preserves stale warnings and never invents a new ECU read", async () => {
  let report = await runLiveDiagnostic(fixture({ rows: [sample({}, 0, { activeDTCs: ["P0300", "P0700"], dtcCapturedAt: new Date(now - 1000).toISOString(), dtcScanStatus: "read" })] }));
  assert.equal(report.faultCodes.status, "recent_report");
  assert.equal(report.faultCodes.codes.length, 2);
  assert.match(report.summary, /P0300/);
  report = await runLiveDiagnostic(fixture({ rows: [sample({}, 0, { activeDTCs: [], dtcCapturedAt: new Date(now - 120_000).toISOString(), dtcScanStatus: "read" })] }));
  assert.equal(report.faultCodes.status, "historical");
  report = await runLiveDiagnostic(fixture({ rows: [sample({}, 0, { activeDTCs: [], dtcCapturedAt: new Date(now.getTime() + 120_000).toISOString(), dtcScanStatus: "read" })] }));
  assert.equal(report.faultCodes.status, "not_read");
});

test("Advisor executes read-only scan without LLM credentials and saves tenant-scoped evidence", async t => {
  const f = fixture();
  t.mock.method(db, "getPrisma", () => f.prisma);
  t.mock.method(db, "listVehicles", async scope => { assert.equal(scope.orgId, "A"); return [{ orgId: "A", vehicleId: "carA", unitName: "Camaro" }]; });
  t.mock.method(db, "listDrivers", async () => []);
  const app = express(); app.use(express.json());
  registerSolutionRoutes(app, { readData: async () => ({}), sanitizeString: (s, max) => String(s || "").slice(0, max),
    requireEmployeeOrCustomerApi(req, res, next) {
      if (!req.headers["x-test-session"]) return res.sendStatus(401);
      req.customer = { orgId: "A", userId: "userA", role: "CUSTOMER_ADMIN" }; next();
    }
  });
  app.use((error, req, res, next) => res.status(500).json({ error: error.message }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  async function post(path, body, authorized = true) {
    return fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...(authorized ? { "x-test-session": "fixture" } : {}) }, body: JSON.stringify(body) });
  }
  const request = { message: "Run a live diagnostic scan", orgId: "B", vehicleId: "carA" };
  assert.equal((await post("/api/diagnostics/live-analysis", request, false)).status, 401);
  assert.equal((await post("/api/diagnostics/live-analysis", { ...request, vehicleId: "carB" })).status, 404);
  assert.equal((await post("/api/diagnostics/live-analysis", {})).status, 400);
  const response = await post("/api/advisor/message", request);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.scanStatus, "completed");
  assert.equal(body.source, "fleetai_received_telemetry");
  assert.equal(body.artifacts.length, 1);
  assert.equal(f.artifacts[0].orgId, "A");
  assert.equal(f.artifacts[0].content.scope.vehicleId, "carA");
  assert.equal(body.diagnostic.faultCodes.status, "not_read");
  const history = [{ role: "user", content: request.message }, { role: "assistant", content: "The scan is running" }];
  const followup = await (await post("/api/advisor/message", { vehicleId: "carA", message: "Is it done?", history })).json();
  assert.equal(followup.scanStatus, "not_running"); assert.equal(followup.artifacts[0].id, "reportA");
  assert.equal(f.artifacts.length, 1, "status reads must not rerun a scan");
  const retry = await (await post("/api/advisor/message", { vehicleId: "carA", message: "try again", history })).json();
  assert.equal(retry.scanStatus, "completed"); assert.equal(f.artifacts.length, 2);
  assert.equal((await post("/api/advisor/message", { message: "scan status", vehicleId: "carB" })).status, 404);
  t.mock.method(f.prisma.advisorArtifact, "create", async () => { throw new Error("storage_unavailable"); });
  const failed = await post("/api/advisor/message", request);
  assert.equal(failed.status, 500); assert.equal((await failed.json()).scanStatus, undefined);
});
