const DEFAULTS = Object.freeze({
  runningRpm: 400,
  offRpm: 100,
  stoppedSpeedKph: 3,
  movingSpeedKph: 8,
  maxTransitionGapSeconds: 60,
  confirmationWindowSeconds: 90,
  contextWindowSeconds: 60,
  adjacentRunningWindowSeconds: 15,
  minimumOffConfirmations: 2,
  minimumIdleSamples: 4,
  minimumBaselineIdleSamples: 12
});

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function timestampMs(sample) {
  const value = new Date(sample?.ts || sample?.timestamp || "").getTime();
  return Number.isFinite(value) ? value : null;
}

function sampleMetric(sample, key) {
  return finiteNumber(sample?.metrics?.[key]);
}

function sortedSamples(samples) {
  return (Array.isArray(samples) ? samples : [])
    .map((sample) => ({ sample, at: timestampMs(sample) }))
    .filter((item) => item.at != null)
    .sort((left, right) => left.at - right.at);
}

function populationStats(values) {
  const valid = values.map(finiteNumber).filter((value) => value != null);
  if (!valid.length) return { count: 0, mean: null, std: null, min: null, max: null };
  const mean = valid.reduce((sum, value) => sum + value, 0) / valid.length;
  const variance = valid.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / valid.length;
  return {
    count: valid.length,
    mean: Math.round(mean * 10) / 10,
    std: Math.round(Math.sqrt(variance) * 10) / 10,
    min: Math.min(...valid),
    max: Math.max(...valid)
  };
}

function isoFromMs(value) {
  return Number.isFinite(value) ? new Date(value).toISOString() : null;
}

function baseResult(status, overrides = {}) {
  return Object.assign({
    status,
    confidence: 0,
    alertable: false,
    occurredAt: null,
    lastRunningAt: null,
    gapSeconds: null,
    evidence: {}
  }, overrides);
}

/**
 * Classify only transitions supported by device event timestamps. Database
 * arrival time is deliberately ignored because queued telemetry may arrive
 * long after the physical drive event.
 */
function classifyEngineEvent(samples, options = {}) {
  const config = Object.assign({}, DEFAULTS, options);
  const ordered = sortedSamples(samples);
  const statePoints = ordered
    .map((item) => {
      const rpm = sampleMetric(item.sample, "rpm");
      if (rpm == null) return null;
      return Object.assign({}, item, {
        rpm,
        state: rpm >= config.runningRpm ? "running" : rpm <= config.offRpm ? "off" : "transition"
      });
    })
    .filter(Boolean);

  if (!statePoints.length) return baseResult("insufficient_data");

  const latest = statePoints[statePoints.length - 1];
  if (latest.state === "running") {
    return baseResult("engine_running", {
      confidence: 0.99,
      lastRunningAt: isoFromMs(latest.at),
      evidence: {
        rpm: latest.rpm,
        speedKph: sampleMetric(latest.sample, "vehicleSpeed")
      }
    });
  }
  if (latest.state !== "off") {
    return baseResult("transition_unknown", {
      confidence: 0.35,
      evidence: { rpm: latest.rpm }
    });
  }

  let offStartIndex = statePoints.length - 1;
  while (offStartIndex > 0 && statePoints[offStartIndex - 1].state === "off") offStartIndex -= 1;
  const firstOff = statePoints[offStartIndex];
  let lastRunningIndex = offStartIndex - 1;
  while (lastRunningIndex >= 0 && statePoints[lastRunningIndex].state !== "running") lastRunningIndex -= 1;
  if (lastRunningIndex < 0) {
    return baseResult("off_state_unknown", {
      confidence: 0.55,
      occurredAt: isoFromMs(firstOff.at),
      evidence: { offConfirmations: statePoints.length - offStartIndex }
    });
  }

  const lastRunning = statePoints[lastRunningIndex];
  const gapSeconds = (firstOff.at - lastRunning.at) / 1000;
  const offConfirmations = statePoints
    .slice(offStartIndex)
    .filter((point) => point.state === "off" && point.at - firstOff.at <= config.confirmationWindowSeconds * 1000)
    .length;
  const common = {
    occurredAt: isoFromMs(firstOff.at),
    lastRunningAt: isoFromMs(lastRunning.at),
    gapSeconds: Math.round(gapSeconds * 10) / 10,
    evidence: {
      lastRunningRpm: lastRunning.rpm,
      lastRunningSpeedKph: sampleMetric(lastRunning.sample, "vehicleSpeed"),
      firstOffSpeedKph: sampleMetric(firstOff.sample, "vehicleSpeed"),
      lastRunningBatteryVoltage: sampleMetric(lastRunning.sample, "batteryVoltage"),
      offConfirmations
    }
  };

  if (gapSeconds < 0 || gapSeconds > config.maxTransitionGapSeconds) {
    return baseResult("connectivity_unknown", Object.assign({}, common, {
      confidence: 0.2,
      evidence: Object.assign({}, common.evidence, {
        reason: "The event-time gap is too large to determine how the engine stopped."
      })
    }));
  }
  if (offConfirmations < config.minimumOffConfirmations) {
    return baseResult("shutdown_unconfirmed", Object.assign({}, common, {
      confidence: 0.3,
      evidence: Object.assign({}, common.evidence, {
        reason: "A second engine-off observation has not confirmed the transition."
      })
    }));
  }

  const transitionSpeed = Math.max(
    sampleMetric(lastRunning.sample, "vehicleSpeed") || 0,
    sampleMetric(firstOff.sample, "vehicleSpeed") || 0
  );
  if (transitionSpeed > config.movingSpeedKph) {
    return baseResult("possible_stall_moving", Object.assign({}, common, {
      confidence: 0.95,
      alertable: true,
      evidence: Object.assign({}, common.evidence, {
        transitionSpeedKph: transitionSpeed,
        reason: "Engine speed fell to zero while vehicle speed still indicated movement."
      })
    }));
  }

  const contextStart = firstOff.at - config.contextWindowSeconds * 1000;
  const preStopPoints = statePoints.filter((point) =>
    point.state === "running"
      && point.at >= contextStart
      && point.at <= lastRunning.at
      && (sampleMetric(point.sample, "vehicleSpeed") || 0) <= config.stoppedSpeedKph
  );
  const earlierIdlePoints = statePoints.filter((point) =>
    point.state === "running"
      && point.at < contextStart
      && point.rpm <= 1500
      && (sampleMetric(point.sample, "vehicleSpeed") || 0) <= config.stoppedSpeedKph
  );
  const preStats = populationStats(preStopPoints.map((point) => point.rpm));
  const baselinePool = earlierIdlePoints.slice(-200);
  const baselineStats = populationStats(baselinePool.map((point) => point.rpm));
  const referenceMean = baselineStats.count >= config.minimumBaselineIdleSamples
    ? baselineStats.mean
    : preStats.mean;
  const referenceStd = baselineStats.count >= config.minimumBaselineIdleSamples
    ? baselineStats.std
    : 0;
  const lowRpmCutoff = referenceMean == null ? 450 : Math.max(400, referenceMean - Math.max(180, referenceStd * 4));
  const lowDipCount = preStopPoints.filter((point) => point.rpm < lowRpmCutoff).length;
  const spread = preStats.count ? preStats.max - preStats.min : null;
  const unstableVariance = preStats.count >= config.minimumIdleSamples
    && preStats.std > Math.max(120, referenceStd * 3);
  const unstableSpread = spread != null && spread > Math.max(300, referenceStd * 6);
  const roughIdle = preStats.count >= config.minimumIdleSamples
    && ((unstableVariance && unstableSpread) || lowDipCount >= 2);
  const enrichedEvidence = Object.assign({}, common.evidence, {
    transitionSpeedKph: transitionSpeed,
    preStopSampleCount: preStats.count,
    preStopRpmMean: preStats.mean,
    preStopRpmStd: preStats.std,
    preStopRpmMin: preStats.min,
    idleBaselineSampleCount: baselineStats.count,
    idleBaselineRpmMean: baselineStats.mean,
    idleBaselineRpmStd: baselineStats.std,
    lowRpmDipCount: lowDipCount
  });

  if (roughIdle) {
    return baseResult("possible_stall_at_stop", Object.assign({}, common, {
      confidence: baselineStats.count >= config.minimumBaselineIdleSamples ? 0.82 : 0.72,
      alertable: true,
      evidence: Object.assign({}, enrichedEvidence, {
        reason: "RPM became unstable at a stop immediately before the engine-off transition."
      })
    }));
  }

  const cleanIdle = preStats.count >= config.minimumIdleSamples
    && preStats.mean >= config.runningRpm
    && preStats.mean <= 1200
    && preStats.std <= Math.max(120, referenceStd * 3)
    && (spread == null || spread <= Math.max(300, referenceStd * 6));
  if (cleanIdle && transitionSpeed <= config.stoppedSpeedKph) {
    return baseResult("intentional_shutdown", Object.assign({}, common, {
      confidence: baselineStats.count >= config.minimumBaselineIdleSamples ? 0.94 : 0.86,
      evidence: Object.assign({}, enrichedEvidence, {
        reason: "The vehicle was stopped with stable idle immediately before a confirmed engine-off transition."
      })
    }));
  }

  return baseResult("shutdown_unknown", Object.assign({}, common, {
    confidence: 0.45,
    evidence: Object.assign({}, enrichedEvidence, {
      reason: "The engine-off transition was confirmed, but the preceding evidence was not decisive."
    })
  }));
}

/** Keep complementary PID buckets near a confirmed running observation. */
function selectEngineRunningSamples(samples, options = {}) {
  const config = Object.assign({}, DEFAULTS, options);
  const ordered = sortedSamples(samples);
  const knownRunningTimes = ordered
    .filter((item) => {
      const rpm = sampleMetric(item.sample, "rpm");
      return rpm != null && rpm >= config.runningRpm;
    })
    .map((item) => item.at);
  let runningIndex = 0;
  return ordered
    .filter((item) => {
      const rpm = sampleMetric(item.sample, "rpm");
      if (rpm != null) return rpm >= config.runningRpm;
      while (runningIndex < knownRunningTimes.length && knownRunningTimes[runningIndex] < item.at) runningIndex += 1;
      const previous = runningIndex > 0 ? knownRunningTimes[runningIndex - 1] : null;
      const next = runningIndex < knownRunningTimes.length ? knownRunningTimes[runningIndex] : null;
      return previous != null
        && next != null
        && item.at - previous <= config.adjacentRunningWindowSeconds * 1000
        && next - item.at <= config.adjacentRunningWindowSeconds * 1000;
    })
    .map((item) => item.sample);
}

module.exports = {
  DEFAULT_ENGINE_STATE_OPTIONS: DEFAULTS,
  classifyEngineEvent,
  selectEngineRunningSamples
};
