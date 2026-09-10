// Merges Python ML service prediction with Node.js EWMA fallback prediction.
// Called after every prediction request regardless of whether Python is available.

const PREDICTION_LABEL_MAP = {
  failure_imminent: "FAILURE_IMMINENT",
  maintenance_soon: "MAINTENANCE_SOON",
  monitor_closely: "MONITOR_CLOSELY",
  healthy: "HEALTHY",
  insufficient_data: "CALIBRATING"
};

// Single source of truth for the raw Python label -> API vocabulary mapping.
// partnerRoutes.js and internalMlApiRoutes.js used to pass the raw lowercase
// Python label straight through unmapped, so the identical model output
// surfaced as e.g. "FAILURE_IMMINENT" via the internal dashboard API but
// "failure_imminent" via the partner API — same value, different API surfaces.
function normalizePredictionLabel(rawLabel) {
  return PREDICTION_LABEL_MAP[rawLabel] || rawLabel || null;
}

function deriveSensorRisksFromPython(py) {
  const risks = {};
  const riskProbability = Number(py?.riskProbability);
  if (Number.isFinite(riskProbability)) {
    const base = Math.round(Math.max(0, Math.min(1, riskProbability)) * 100);
    risks.modelPrior = base;
  }
  (py?.topFeatures || []).forEach((feature) => {
    const z = Number(feature.zScore || 0);
    // z * 18 maps a 3σ outlier → 54 (warning), 5σ → 90 (critical), 6σ → 100 (max)
    risks[feature.metric] = Math.max(risks[feature.metric] || 0, Math.round(Math.min(100, z * 18)));
  });
  // Map new topMetrics format
  (py?.topMetrics || []).forEach((metricKey) => {
    if (!risks[metricKey] && Number.isFinite(riskProbability)) {
      risks[metricKey] = Math.round(Math.max(0, Math.min(1, riskProbability)) * 70);
    }
  });
  return risks;
}

function _buildTopContributors(jsPrediction, py) {
  // JS contributors are highest signal — prefer them
  if (Array.isArray(jsPrediction.topContributors) && jsPrediction.topContributors.length) {
    return jsPrediction.topContributors;
  }
  // Fall back to Python topMetrics
  if (Array.isArray(py?.topMetrics) && py.topMetrics.length) {
    return py.topMetrics.map((metric) => ({
      metric,
      value: py.currentMetrics?.[metric] ?? null,
      zScore: null,
      reason: `${metric} identified as elevated by ensemble model.`
    }));
  }
  return [];
}

function _healthScoreFromRisk(riskProbability, jsHealthScore) {
  if (jsHealthScore != null) return jsHealthScore;
  if (!Number.isFinite(riskProbability)) return null;
  // Non-linear mapping: risk 0→health 100, risk 0.5→health 60, risk 1→health 10
  return Math.max(0, Math.round(100 - riskProbability * 90));
}

function _mergeSignatures(jsSignatures, pyFleetNorm) {
  const combined = Array.isArray(jsSignatures) ? [...jsSignatures] : [];
  // DPF soot load critical from fleet normalization
  const dpfNorm = pyFleetNorm?.dpfSootLoad;
  if (dpfNorm?.deviation_label === "critical" && !combined.find((s) => s.id === "dpf_critical_stack")) {
    combined.push({
      id: "dpf_fleet_outlier",
      label: "DPF Fleet Outlier",
      severity: "warning",
      description: `DPF soot load is ${dpfNorm.z_score?.toFixed(1)}σ above fleet average (${dpfNorm.percentile}th percentile).`
    });
  }
  return combined;
}

function _advisoryText(py, jsPrediction) {
  if (py?.advisoryText) return py.advisoryText;
  if (jsPrediction.insufficientData || jsPrediction.insufficientHistory) {
    return "Insufficient telemetry history to generate a full prediction. Continue collecting data.";
  }
  return "Risk assessment based on vehicle telemetry baseline and sensor thresholds.";
}

function mergePythonAndNodePrediction(jsPrediction, pythonPrediction, context = {}) {
  const lineage = {
    version: 1,
    mergePolicy: "python_risk_node_health_minimum_confidence_v1",
    node: {
      modelVersion: jsPrediction.modelVersion || "node-ewma-v2",
      riskProbability: jsPrediction.riskProbability ?? null,
      healthScore: jsPrediction.healthScore ?? null,
      confidence: jsPrediction.confidence ?? null,
      evidence: jsPrediction.lineage || null
    },
    python: pythonPrediction ? {
      available: pythonPrediction.available !== false && pythonPrediction.ok !== false,
      riskProbability: pythonPrediction.riskProbability ?? null,
      confidence: pythonPrediction.confidence ?? null,
      evidence: pythonPrediction.lineage || null
    } : null
  };
  const scopeMatches = (!pythonPrediction?.orgId || !context.orgId || pythonPrediction.orgId === context.orgId)
    && (!pythonPrediction?.vehicleId || !context.vehicleId || pythonPrediction.vehicleId === context.vehicleId);
  if (!scopeMatches) lineage.python = { available: false, reason: "scope_mismatch" };
  const py = scopeMatches && pythonPrediction && pythonPrediction.available !== false && pythonPrediction.ok !== false
    ? pythonPrediction
    : null;

  if (!py) {
    return Object.assign({}, jsPrediction, {
      orgId: context.orgId || jsPrediction.orgId || null,
      vehicleId: context.vehicleId || jsPrediction.vehicleId,
      predictionSource: "node_fallback",
      lineage,
      mlServiceAvailable: false,
      mlServiceError: context.pythonError || null,
      confidenceStage: jsPrediction.insufficientData || jsPrediction.insufficientHistory
        ? "calibrating"
        : "vehicle_specific",
      trainingSource: "vehicle_telemetry_fallback",
      modelVersion: "node-ewma-v2",
      signatures: jsPrediction.signatures || [],
      advisoryText: _advisoryText(null, jsPrediction),
      diagnosis: null,
      dtcAnalysis: null,
      fleetNormalization: null,
      ensembleComponents: null,
      dataQuality: Object.assign({}, jsPrediction.dataQuality || {}, {
        engineRunningSamples: jsPrediction.sampleCount ?? null,
        excludedEngineOffSamples: jsPrediction.excludedEngineOffSamples ?? 0
      })
    });
  }

  const riskProbability = Number(py.riskProbability);
  const healthScore = _healthScoreFromRisk(
    Number.isFinite(riskProbability) ? riskProbability : null,
    jsPrediction.healthScore
  );
  const topContributors = _buildTopContributors(jsPrediction, py);
  const signatures = _mergeSignatures(jsPrediction.signatures, py.fleetNormalization);
  const predictionLabel = PREDICTION_LABEL_MAP[py.prediction] || py.prediction || null;
  const pythonConfidence = py.confidence == null ? null : Number(py.confidence);
  const nodeConfidence = jsPrediction.confidence == null ? null : Number(jsPrediction.confidence);
  const confidence = Number.isFinite(pythonConfidence) && Number.isFinite(nodeConfidence)
    ? Math.min(pythonConfidence, nodeConfidence)
    : Number.isFinite(nodeConfidence)
      ? nodeConfidence
      : Number.isFinite(pythonConfidence) ? pythonConfidence : null;

  // Blend sensor risks: JS per-sensor detail + Python model prior
  const sensorRisks = Object.keys(jsPrediction.sensorRisks || {}).length
    ? Object.assign({}, jsPrediction.sensorRisks, deriveSensorRisksFromPython(py))
    : deriveSensorRisksFromPython(py);

  return Object.assign({}, jsPrediction, {
    orgId: context.orgId || jsPrediction.orgId || py.orgId || null,
    vehicleId: context.vehicleId || jsPrediction.vehicleId || py.vehicleId,
    insufficientData: Boolean(jsPrediction.insufficientData),
    insufficientHistory: Boolean(jsPrediction.insufficientHistory),

    // Prediction outputs
    predictionSource: "python_ml_ensemble",
    mlServiceAvailable: true,
    riskProbability: Number.isFinite(riskProbability) ? riskProbability : null,
    prediction: predictionLabel,
    anomalyScore: jsPrediction.anomalyScore != null
      ? jsPrediction.anomalyScore
      : Number.isFinite(riskProbability) ? Math.round(riskProbability * 100) : null,
    healthScore,
    confidence,
    advisoryText: _advisoryText(py, jsPrediction),

    // Model metadata
    confidenceStage: py.modelStatus?.ifTrained ? "ensemble" : "welford_only",
    trainingSource: "synthetic_priors_and_vehicle_telemetry",
    modelVersion: py.modelVersion || "python-multistage-legacy",
    lineage,
    stageSystem: py.stageSystem || null,
    calibration: py.lineage?.calibration || { ensemble: "uncalibrated" },
    modelStatus: py.modelStatus || null,
    engineEvent: py.engineEvent || jsPrediction.engineEvent || null,
    excludedEngineOffSamples: py.dataQuality?.excludedEngineOffSamples
      ?? jsPrediction.excludedEngineOffSamples
      ?? 0,

    // Enriched signal
    topContributors,
    sensorRisks,
    signatures,
    diagnosis: py.diagnosis || null,
    dtcAnalysis: py.dtcAnalysis || null,
    fleetNormalization: py.fleetNormalization || null,
    ensembleComponents: py.components || null,
    features: py.features || null,

    // Legacy fields kept for backward compat
    baselineProfile: py.baselineProfile || null,
    dataQuality: Object.assign({}, py.dataQuality || {}, {
      operatingMinutes: jsPrediction.operatingMinutes ?? null,
      operatingSessionCount: jsPrediction.operatingSessionCount ?? null,
      wallClockSpanHours: jsPrediction.wallClockSpanHours ?? null,
      engineRunningSamples: jsPrediction.sampleCount ?? py.dataQuality?.engineRunningSamples ?? null,
      excludedEngineOffSamples: py.dataQuality?.excludedEngineOffSamples
        ?? jsPrediction.excludedEngineOffSamples
        ?? 0,
      confidenceCappedByObservedData: Number.isFinite(pythonConfidence)
        && Number.isFinite(confidence)
        && confidence < pythonConfidence
    }),
    featureVector: py.featureVector || null,
    subsystemPriors: py.subsystemPriors || null,

    latencyMs: py.latencyMs || null
  });
}

module.exports = { mergePythonAndNodePrediction, deriveSensorRisksFromPython, normalizePredictionLabel };
