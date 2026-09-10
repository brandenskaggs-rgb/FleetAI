function latestSampleKey(samples) {
  const latest = Array.isArray(samples) && samples.length ? samples[samples.length - 1] : null;
  if (!latest) return "";
  return `${latest.id || ""}:${latest.ts || latest.timestamp || ""}`;
}

function createTelemetryPredictionCoordinator({
  ml,
  pythonMlClient,
  mergePredictions,
  intervalMs = 60_000,
  now = () => Date.now()
}) {
  const cache = new Map();

  async function predict({ orgId, vehicleId, vehicleMeta, samples, dtcCodes }) {
    if (!orgId || !vehicleId) throw new Error("Prediction requires organization and vehicle scope");
    const cacheKey = JSON.stringify([orgId, vehicleId]);
    const jsPrediction = ml.computeFullPrediction(samples, vehicleId, vehicleMeta || {});
    const sampleKey = latestSampleKey(samples);
    const previous = cache.get(cacheKey) || null;
    const elapsed = previous ? now() - previous.attemptedAt : Number.POSITIVE_INFINITY;
    const hasNewSample = !previous || previous.sampleKey !== sampleKey;
    const shouldAttempt = !previous || (elapsed >= intervalMs && (hasNewSample || !previous.serviceAvailable));

    let pythonPrediction = previous?.pythonPrediction || null;
    let pythonError = previous?.pythonError || null;
    let attempted = false;

    if (shouldAttempt) {
      attempted = true;
      try {
        pythonPrediction = await pythonMlClient.predict({
          orgId,
          vehicleId,
          vehicleMeta: vehicleMeta || {},
          samples: Array.isArray(samples) ? samples : [],
          dtcCodes: Array.isArray(dtcCodes) ? dtcCodes : []
        });
        pythonError = pythonPrediction?.available === false
          ? pythonPrediction.reason || "theorem_prediction_unavailable"
          : null;
      } catch (error) {
        pythonPrediction = null;
        pythonError = error?.message || "theorem_unavailable";
      }
      cache.set(cacheKey, {
        attemptedAt: now(),
        sampleKey,
        pythonPrediction,
        pythonError,
        serviceAvailable: Boolean(pythonPrediction && pythonPrediction.available !== false)
      });
    }

    const prediction = mergePredictions(jsPrediction, pythonPrediction, {
      orgId,
      vehicleId,
      pythonError
    });
    return { prediction, attempted, pythonError, pythonPrediction };
  }

  return {
    predict,
    clear: () => cache.clear()
  };
}

module.exports = { createTelemetryPredictionCoordinator, latestSampleKey };
