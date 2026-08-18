const assert = require("assert");
const { createTelemetryPredictionCoordinator } = require("../server/services/telemetryPredictionCoordinator");

function nodePrediction(samples, vehicleId) {
  return {
    vehicleId,
    healthScore: 92,
    confidence: 0.7,
    sampleCount: samples.length
  };
}

(async () => {
  let clock = 1_000;
  let calls = 0;
  let fail = false;
  const coordinator = createTelemetryPredictionCoordinator({
    ml: { computeFullPrediction: nodePrediction },
    pythonMlClient: {
      predict: async () => {
        calls += 1;
        if (fail) throw new Error("service unavailable");
        return { available: true, riskProbability: 0.14, confidence: 0.81 };
      }
    },
    mergePredictions: (node, python, context) => Object.assign({}, node, {
      predictionSource: python ? "python_ml_ensemble" : "node_fallback",
      pythonError: context.pythonError || null
    }),
    intervalMs: 60_000,
    now: () => clock
  });

  const firstSamples = [{ id: "TS_1", ts: "2026-08-17T12:00:00.000Z", metrics: { rpm: 700 } }];
  const first = await coordinator.predict({ vehicleId: "CAR_1", samples: firstSamples });
  assert.strictEqual(first.attempted, true);
  assert.strictEqual(first.prediction.predictionSource, "python_ml_ensemble");
  assert.strictEqual(calls, 1);

  clock += 10_000;
  const cached = await coordinator.predict({ vehicleId: "CAR_1", samples: firstSamples });
  assert.strictEqual(cached.attempted, false);
  assert.strictEqual(cached.prediction.predictionSource, "python_ml_ensemble");
  assert.strictEqual(calls, 1);

  clock += 60_000;
  const secondSamples = firstSamples.concat({
    id: "TS_2",
    ts: "2026-08-17T12:01:10.000Z",
    metrics: { rpm: 725 }
  });
  const refreshed = await coordinator.predict({ vehicleId: "CAR_1", samples: secondSamples });
  assert.strictEqual(refreshed.attempted, true);
  assert.strictEqual(calls, 2);

  fail = true;
  clock += 60_000;
  const failed = await coordinator.predict({
    vehicleId: "CAR_1",
    samples: secondSamples.concat({ id: "TS_3", ts: "2026-08-17T12:02:10.000Z", metrics: { rpm: 730 } })
  });
  assert.strictEqual(failed.attempted, true);
  assert.strictEqual(failed.prediction.predictionSource, "node_fallback");
  assert.strictEqual(failed.prediction.pythonError, "service unavailable");
  assert.strictEqual(calls, 3);

  console.log("Telemetry prediction coordinator tests passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
