const test = require("node:test");
const assert = require("node:assert/strict");
const { selectPredictionFaultEvidence } = require("../server/services/faultEvidence");

test("fault selection uses acquisition time, not array order or upload time", () => {
  const now = Date.now();
  const raw = { activeDTCs: ["P0300"], dtcScanStatus: "read", dtcCapturedAt: new Date(now - 1000).toISOString() };
  assert.deepEqual(selectPredictionFaultEvidence([{ raw }, { raw: {} }], null, now).codes, ["P0300"]);
  assert.equal(selectPredictionFaultEvidence([{ raw: { ...raw, dtcCapturedAt: new Date(now - 600000).toISOString() } }], null, now).status, "historical");
  assert.deepEqual(selectPredictionFaultEvidence([{ raw: { ...raw, dtcCapturedAt: new Date(now + 60000).toISOString() } }], null, now).codes, []);
  const partial = { obdFaultRead: { capturedAt: new Date(now).toISOString(), confirmed: null, pending: ["P0133"], permanent: ["P0420"] } };
  const evidence = selectPredictionFaultEvidence([{ raw }], partial, now);
  assert.equal(evidence.completeness, "partial"); assert.deepEqual(evidence.codes, ["P0133"]);
});

test("normal prediction and explicit recompute pass identical tenant-scoped persisted DTC evidence", async t => {
  const express = require("express"), db = require("../server/db"), ml = require("../server/ml"), python = require("../server/services/pythonMlClient");
  const { registerMlRoutes } = require("../server/routes/mlRoutes");
  const calls = [];
  t.mock.method(db, "getVehicleOrgId", async () => "A");
  t.mock.method(db, "getSamplesForVehicle", async (id, options) => { assert.equal(options.orgId, "A"); return []; });
  t.mock.method(db, "getVehicleByVehicleId", async () => ({ vehicleId: "carA", orgId: "A" }));
  t.mock.method(db, "getVehicleCapabilities", async () => ({}));
  t.mock.method(db, "getPrisma", () => ({ diagnosticScan: { findFirst: async ({ where }) => {
    assert.equal(where.orgId, "A"); assert.equal(where.vehicle.orgId, "A");
    return { orgId: "A", vehicleId: "carA", id: "scan", scannedAt: new Date(), codes: [],
      summary: { obdFaultRead: { capturedAt: new Date().toISOString(), confirmed: ["P0300"], pending: [], permanent: [], milOn: true, reportedCodeCount: 1 } } };
  } } }));
  t.mock.method(ml, "computeFullPrediction", () => ({ healthScore: 80 }));
  t.mock.method(python, "predict", async args => { calls.push(args); return null; });
  t.mock.method(db, "upsertModelState", async prediction => { assert.deepEqual(prediction.faultEvidence.codes, ["P0300"]); });
  t.mock.method(db, "insertMlPredictionRun", async () => "run");
  t.mock.method(db, "insertMlFeatureSnapshot", async () => {});
  const app = express(); app.use(express.json());
  registerMlRoutes(app, { requireEmployeeOrCustomerApi(req, res, next) { req.customer = { orgId: req.headers["x-test-org"] || "A" }; next(); } });
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/vehicles/carA/prediction`)).status, 200);
  assert.equal((await fetch(`${base}/api/ml/recompute`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ vehicleId: "carA" }) })).status, 200);
  assert.equal(calls.length, 2);
  for (const call of calls) { assert.equal(call.orgId, "A"); assert.deepEqual(call.dtcCodes, ["P0300"]); }
  assert.equal((await fetch(`${base}/api/vehicles/carA/prediction`, { headers: { "x-test-org": "B" } })).status, 403);
  assert.equal(calls.length, 2);
});
