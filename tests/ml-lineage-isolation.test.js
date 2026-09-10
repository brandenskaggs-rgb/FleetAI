const assert = require("node:assert/strict");
const test = require("node:test");
const { mergePythonAndNodePrediction } = require("../server/lib/mlMerge");
const { createTelemetryPredictionCoordinator } = require("../server/services/telemetryPredictionCoordinator");

test("Node/Python results remain independently traceable", () => {
  const node = { healthScore: 80, confidence: .4, riskProbability: .2 };
  const py = { riskProbability: .7, confidence: .9, lineage: { stage1: { riskProbability: .5 } } };
  const result = mergePythonAndNodePrediction(node, py, { orgId: "fixture-a", vehicleId: "fixture" });
  assert.equal(result.riskProbability, .7);
  assert.equal(result.healthScore, 80);
  assert.equal(result.confidence, .4);
  assert.equal(result.lineage.node.riskProbability, .2);
  assert.equal(result.lineage.python.evidence.stage1.riskProbability, .5);
});

test("Mismatched Python tenant is rejected, including lineage", () => {
  const result = mergePythonAndNodePrediction({}, { orgId: "fixture-b", riskProbability: .9,
    lineage: { privateEvidence: "other-tenant-fixture" } }, { orgId: "fixture-a" });
  assert.equal(result.predictionSource, "node_fallback");
  assert.equal(JSON.stringify(result).includes("other-tenant-fixture"), false);
});

test("Coordinator does not share predictions across organizations", async () => {
  let calls = 0;
  const coordinator = createTelemetryPredictionCoordinator({
    ml: { computeFullPrediction: () => ({}) },
    pythonMlClient: { predict: async ({ orgId }) => ({ orgId, available: true, fixture: ++calls }) },
    mergePredictions: (_, py) => py,
    now: () => 1000
  });
  const request = { vehicleId: "same-fixture-id", samples: [{ ts: "2026-01-01" }] };
  assert.equal((await coordinator.predict({ ...request, orgId: "fixture-a" })).prediction.fixture, 1);
  assert.equal((await coordinator.predict({ ...request, orgId: "fixture-b" })).prediction.fixture, 2);
  assert.equal((await coordinator.predict({ ...request, orgId: "fixture-a" })).prediction.fixture, 1);
});
