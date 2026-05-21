const crypto = require("crypto");

function registerInternalMlApiRoutes(app, deps) {
  const {
    ml,
    pythonMlClient,
    sqliteDb,
    nowIso,
    sanitizeString
  } = deps;

  const MAX_SAMPLES = 5000;

  function enabled() {
    return String(process.env.INTERNAL_ML_API_ENABLED || "false").toLowerCase() === "true";
  }

  function configuredKey() {
    return String(process.env.INTERNAL_ML_API_KEY || "").trim();
  }

  function localOnly() {
    return String(process.env.INTERNAL_ML_API_LOCAL_ONLY || "true").toLowerCase() !== "false";
  }

  function remoteAddress(req) {
    return String(req.socket?.remoteAddress || req.ip || "").trim();
  }

  function isLocalRequest(req) {
    const remote = remoteAddress(req);
    return (
      remote === "127.0.0.1" ||
      remote === "::1" ||
      remote === "::ffff:127.0.0.1" ||
      remote === "localhost"
    );
  }

  function timingSafeEqualString(a, b) {
    const left = crypto.createHash("sha256").update(String(a || "")).digest();
    const right = crypto.createHash("sha256").update(String(b || "")).digest();
    return crypto.timingSafeEqual(left, right);
  }

  function presentedKey(req) {
    const auth = String(req.headers.authorization || "").trim();
    if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
    return String(req.headers["x-internal-ml-key"] || "").trim();
  }

  function requireInternalMlApi(req, res, next) {
    if (!enabled()) return res.status(404).json({ ok: false, error: "not_found" });
    const key = configuredKey();
    if (!key || key.length < 32) {
      return res.status(503).json({ ok: false, error: "internal_ml_api_key_not_configured" });
    }
    if (localOnly() && !isLocalRequest(req)) {
      return res.status(403).json({ ok: false, error: "local_only" });
    }
    if (!timingSafeEqualString(presentedKey(req), key)) {
      return res.status(401).json({ ok: false, error: "invalid_api_key" });
    }
    next();
  }

  function numberOrNull(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function copyMetric(source, keys) {
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(source, key)) {
        const value = numberOrNull(source[key]);
        if (value != null) return value;
      }
    }
    return null;
  }

  function normalizeMetrics(input = {}) {
    const source = input && typeof input === "object" ? input : {};
    const metrics = Object.assign({}, source.metrics && typeof source.metrics === "object" ? source.metrics : {}, source);
    const out = {};
    const mappings = {
      rpm: ["rpm", "engineRpm"],
      vehicleSpeed: ["vehicleSpeed", "speed", "speedKph", "speedMph"],
      coolantTemp: ["coolantTemp", "coolant_temp", "engine_temp", "engineTemp", "coolantTempC"],
      oilTemp: ["oilTemp", "oil_temp", "oilTempC"],
      transmissionTemp: ["transmissionTemp", "transmission_temp", "transmissionTempC"],
      oilPressure: ["oilPressure", "oil_pressure", "oilPressurePsi"],
      fuelPressure: ["fuelPressure", "fuel_pressure", "fuelRailPressure", "fuel_rail"],
      fuelRate: ["fuelRate", "fuel_rate", "fuelRateLph"],
      batteryVoltage: ["batteryVoltage", "battery_voltage", "batteryVoltageV"],
      vibration: ["vibration", "vibrationG"],
      dpfSootLoad: ["dpfSootLoad", "dpf_soot_load", "dpfSootLoadPct"],
      brakeTemp: ["brakeTemp", "brake_temp", "brakeTempC"],
      tirePressure: ["tirePressure", "tire_pressure", "tpmsPressure"],
      engineLoad: ["engineLoad", "engineLoadPct"],
      engineTorque: ["engineTorque", "torquePct"],
      ambientTemp: ["ambientTemp", "ambient_temp", "ambientTempC"],
      payloadRatio: ["payloadRatio", "payload_ratio"],
      roadGradePct: ["roadGradePct", "road_grade_pct"],
      idleHoursDay: ["idleHoursDay", "idle_hours_day"],
      stopGoRatio: ["stopGoRatio", "stop_go_ratio"],
      longHaulRatio: ["longHaulRatio", "long_haul_ratio"],
      towingRatio: ["towingRatio", "towing_ratio"],
      maintenanceNeglect: ["maintenanceNeglect", "maintenance_neglect"],
      elevation: ["elevation", "elevation_ft"]
    };
    Object.entries(mappings).forEach(([target, names]) => {
      const value = copyMetric(metrics, names);
      if (value != null) out[target] = value;
    });
    return out;
  }

  function normalizeSample(input, context = {}) {
    const source = input && typeof input === "object" ? input : {};
    const metrics = normalizeMetrics(source);
    return {
      orgId: context.orgId || null,
      vehicleId: context.vehicleId || null,
      ts: sanitizeString(source.ts || source.timestamp || nowIso(), 80),
      odometer: numberOrNull(source.odometer ?? source.odometerKm ?? source.odometerMiles),
      engineHours: numberOrNull(source.engineHours),
      metrics,
      raw: Object.assign({}, source.raw && typeof source.raw === "object" ? source.raw : {}, source)
    };
  }

  function normalizeSamples(body, context) {
    const inputSamples = Array.isArray(body.samples)
      ? body.samples
      : Array.isArray(body.telemetry)
        ? body.telemetry
        : body.telemetry && typeof body.telemetry === "object"
          ? [body.telemetry]
          : [];
    return inputSamples
      .slice(-MAX_SAMPLES)
      .map((sample) => normalizeSample(sample, context))
      .filter((sample) => Object.keys(sample.metrics || {}).length || Object.keys(sample.raw || {}).length);
  }

  function normalizeVehicle(body) {
    const vehicle = body.vehicle && typeof body.vehicle === "object" ? body.vehicle : {};
    const externalVehicleId = sanitizeString(body.externalVehicleId || body.vehicleId || vehicle.vehicleId || vehicle.id || "", 120);
    return {
      vehicleId: externalVehicleId || "internal-vehicle",
      orgId: sanitizeString(body.orgId || vehicle.orgId || "INTERNAL_PERSONAL", 120),
      meta: {
        vehicleId: externalVehicleId || undefined,
        vin: sanitizeString(vehicle.vin || body.vin || "", 80) || undefined,
        make: sanitizeString(vehicle.make || body.make || "", 80) || undefined,
        model: sanitizeString(vehicle.model || body.model || "", 80) || undefined,
        year: numberOrNull(vehicle.year || body.year) || undefined,
        protocol: sanitizeString(vehicle.protocol || body.protocol || "", 30) || undefined,
        vehicleClass: sanitizeString(vehicle.vehicleClass || vehicle.class || body.vehicleClass || "", 80) || undefined,
        powertrain: sanitizeString(vehicle.powertrain || body.powertrain || "", 50) || undefined
      }
    };
  }

  function fallbackRiskProbability(prediction) {
    if (prediction?.riskProbability != null) return prediction.riskProbability;
    if (prediction?.healthScore != null) return Math.max(0, Math.min(1, (100 - Number(prediction.healthScore)) / 100));
    if (prediction?.anomalyScore != null) return Math.max(0, Math.min(1, Number(prediction.anomalyScore) / 100));
    return null;
  }

  function fallbackRiskLevel(probability) {
    if (probability == null) return "unknown";
    if (probability >= 0.7) return "high";
    if (probability >= 0.4) return "medium";
    return "low";
  }

  function fallbackAction(level) {
    if (level === "high") return "Schedule inspection soon and review the top contributing signals.";
    if (level === "medium") return "Monitor the vehicle and plan preventive maintenance if the trend continues.";
    if (level === "low") return "No urgent action. Continue normal telemetry monitoring.";
    return "Send more telemetry samples to improve prediction confidence.";
  }

  function normalizePredictionResponse({ vehicleId, orgId, pythonPrediction, jsPrediction, pythonError }) {
    if (pythonPrediction && pythonPrediction.ok !== false) {
      const probability = numberOrNull(pythonPrediction.riskProbability);
      const level = pythonPrediction.prediction || fallbackRiskLevel(probability);
      return {
        predictionSource: "python_ml_service",
        mlServiceAvailable: true,
        vehicleId,
        orgId,
        riskProbability: probability,
        riskLevel: level,
        recommendedAction: fallbackAction(level),
        confidence: pythonPrediction.confidence ?? null,
        confidenceStage: pythonPrediction.confidenceStage || "pretrained_prior",
        modelVersion: pythonPrediction.modelVersion || null,
        trainingSource: pythonPrediction.trainingSource || null,
        baselineProfile: pythonPrediction.baselineProfile || null,
        dataQuality: pythonPrediction.dataQuality || null,
        topFeatures: pythonPrediction.topFeatures || [],
        featureVector: pythonPrediction.featureVector || null,
        subsystemPriors: pythonPrediction.subsystemPriors || null,
        advisoryLanguage: "Best available risk probability using pretrained synthetic priors that calibrate toward vehicle-specific telemetry."
      };
    }

    const probability = fallbackRiskProbability(jsPrediction);
    const level = fallbackRiskLevel(probability);
    return {
      predictionSource: "node_fallback",
      mlServiceAvailable: false,
      mlServiceError: pythonError || null,
      vehicleId,
      orgId,
      riskProbability: probability,
      riskLevel: level,
      recommendedAction: fallbackAction(level),
      confidence: jsPrediction?.confidence ?? null,
      confidenceStage: jsPrediction?.insufficientData ? "calibrating" : "vehicle_specific",
      modelVersion: "node-ewma-v1",
      trainingSource: "vehicle_telemetry_fallback",
      healthScore: jsPrediction?.healthScore ?? null,
      sampleCount: jsPrediction?.sampleCount ?? 0,
      sensorRisks: jsPrediction?.sensorRisks || {},
      topFeatures: jsPrediction?.topContributors || [],
      currentMetrics: jsPrediction?.currentMetrics || null,
      advisoryLanguage: "Python ML unavailable. Returned deterministic Node fallback prediction."
    };
  }

  function persistPrediction(result) {
    try {
      const runId = sqliteDb.insertMlPredictionRun({
        orgId: result.orgId,
        vehicleId: result.vehicleId,
        modelVersion: result.modelVersion,
        source: `internal_${result.predictionSource}`,
        confidenceStage: result.confidenceStage,
        confidence: result.confidence,
        riskProbability: result.riskProbability,
        healthScore: result.healthScore,
        prediction: result
      });
      if (result.featureVector) {
        sqliteDb.insertMlFeatureSnapshot({
          orgId: result.orgId,
          vehicleId: result.vehicleId,
          predictionRunId: runId,
          features: result.featureVector
        });
      }
      return runId;
    } catch (err) {
      return null;
    }
  }

  app.get("/internal/ml/status", requireInternalMlApi, async (req, res) => {
    try {
      const status = await pythonMlClient.status();
      return res.json({ ok: true, data: Object.assign({}, status, { internalApiEnabled: true, localOnly: localOnly() }) });
    } catch (err) {
      return res.json({
        ok: true,
        data: {
          modelLoaded: false,
          serviceAvailable: false,
          internalApiEnabled: true,
          localOnly: localOnly(),
          fallback: "node-ewma-v1",
          error: err.message || "python_ml_unavailable"
        }
      });
    }
  });

  app.get("/internal/ml/baselines/:profileKey", requireInternalMlApi, async (req, res) => {
    const profileKey = sanitizeString(req.params.profileKey || "", 160);
    if (!profileKey) return res.status(400).json({ ok: false, error: "profileKey required" });
    try {
      const profile = await pythonMlClient.baseline(profileKey);
      return res.json({ ok: true, data: profile, source: "python_ml_service" });
    } catch (err) {
      const profile = sqliteDb.getMlBaselineProfile(profileKey);
      if (profile) return res.json({ ok: true, data: profile, source: "sqlite_artifact_cache" });
      return res.status(404).json({ ok: false, error: "baseline_not_found" });
    }
  });

  app.post("/internal/ml/predict", requireInternalMlApi, async (req, res) => {
    const body = req.body || {};
    const vehicle = normalizeVehicle(body);
    const samples = normalizeSamples(body, { orgId: vehicle.orgId, vehicleId: vehicle.vehicleId });
    if (!samples.length) {
      return res.status(400).json({ ok: false, error: "telemetry sample required" });
    }

    const jsPrediction = ml.computeFullPrediction(samples, vehicle.vehicleId);
    let pythonPrediction = null;
    let pythonError = null;
    try {
      pythonPrediction = await pythonMlClient.predict({
        orgId: vehicle.orgId,
        vehicleId: vehicle.vehicleId,
        vehicleMeta: Object.assign({}, vehicle.meta, { vehicleId: vehicle.vehicleId }),
        samples,
        alertMode: sanitizeString(body.alertMode || "internal_personal", 80)
      });
    } catch (err) {
      pythonError = err.message || "python_ml_unavailable";
    }

    const result = normalizePredictionResponse({
      vehicleId: vehicle.vehicleId,
      orgId: vehicle.orgId,
      pythonPrediction,
      jsPrediction,
      pythonError
    });
    const predictionRunId = persistPrediction(result);
    return res.json({
      ok: true,
      data: Object.assign({}, result, {
        predictionRunId,
        sampleCount: samples.length,
        receivedAt: nowIso()
      })
    });
  });
}

module.exports = {
  registerInternalMlApiRoutes
};
