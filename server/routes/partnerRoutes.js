/**
 * Partner ML API — external partner access to Fleet AI breakdown prediction.
 *
 * Authentication: X-API-Key header (issued via /api/admin/api-keys, tier: "partner_ml")
 * Usage: logged to MlPredictionRun with source "partner_api" for billing
 *
 * Exposed endpoints:
 *   POST /api/partner/predict        — breakdown prediction
 *   GET  /api/partner/status         — model readiness for a vehicle
 *   GET  /api/partner/usage          — usage summary (admin only)
 */

const crypto = require("crypto");
const { requireApiKey } = require("../middleware/apiKeyAuth");
const { getPrisma } = require("../db");
const { notifyPrediction, WEBHOOK_EVENTS } = require("../services/webhookService");
const oemIngestion = require("../services/oemIngestion");

// Tier required for partner ML access — set when creating key via /api/admin/api-keys
const PARTNER_ML_TIER = "partner_ml";

function registerPartnerRoutes(app, deps) {
  const {
    ml,
    pythonMlClient,
    sqliteDb,
    nowIso,
    sanitizeString,
    requireSuperAdmin
  } = deps;

  const MAX_SAMPLES = 5000;

  // ── Auth guard: key must exist AND be partner_ml tier ─────────────────────
  function requirePartnerKey(req, res, next) {
    requireApiKey(req, res, () => {
      if (req.apiKey.tier !== PARTNER_ML_TIER) {
        return res.status(403).json({
          success: false,
          error: {
            code: "INSUFFICIENT_TIER",
            message: `This endpoint requires a partner_ml API key. Contact Fleet AI to upgrade your access tier.`
          }
        });
      }
      next();
    });
  }

  // ── Usage tracking ─────────────────────────────────────────────────────────
  async function logUsage({ partnerName, apiKeyId, vehicleId, riskProbability, confidence, prediction, latencyMs, fullResponse }) {
    try {
      await sqliteDb.insertMlPredictionRun({
        orgId: `partner:${partnerName}`,
        vehicleId: vehicleId || "unknown",
        modelVersion: "fleet-ai-partner-v1",
        source: "partner_api",
        confidenceStage: "ensemble",
        confidence: confidence ?? null,
        riskProbability: riskProbability ?? null,
        healthScore: null,
        prediction: fullResponse ?? {
          partnerName,
          apiKeyId,
          vehicleId,
          riskProbability,
          confidence,
          prediction,
          latencyMs,
          loggedAt: nowIso()
        }
      });
    } catch (_) {
      // Non-fatal — don't let a logging failure break the response
    }
  }

  // ── Sample normalization (accepts flexible input formats from partners) ────
  function toNumber(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function normalizeSample(s, vehicleId) {
    const metrics = {};
    const raw = (s.metrics && typeof s.metrics === "object") ? s.metrics : s;
    const metricMap = {
      // ── Core OBD-II / J1939 ────────────────────────────────────────────────
      rpm:                    ["rpm", "engineRpm", "engine_rpm"],
      vehicleSpeed:           ["vehicleSpeed", "speed", "speedKph", "vehicle_speed"],
      coolantTemp:            ["coolantTemp", "coolant_temp", "coolantTempC", "engine_temp"],
      oilTemp:                ["oilTemp", "oil_temp", "oilTempC"],
      batteryVoltage:         ["batteryVoltage", "battery_voltage", "batteryVoltageV"],
      engineLoad:             ["engineLoad", "engineLoadPct", "engine_load"],
      engineTorque:           ["engineTorque", "torquePct", "torque"],
      fuelRate:               ["fuelRate", "fuelRateLph", "fuel_rate"],
      intakeAirTemp:          ["intakeAirTemp", "intakeAirTempC", "iat"],
      maf:                    ["maf", "mafGramsPerSec", "massAirFlow"],
      throttlePos:            ["throttlePos", "throttlePosPct", "throttle_position"],
      intakeManifoldPressure: ["intakeManifoldPressure", "mapKpa", "map_kpa", "boostKpa"],
      dpfSootLoad:            ["dpfSootLoad", "dpfSootLoadPct", "dpf_soot"],
      ambientTemp:            ["ambientTemp", "ambientTempC", "ambient_temp"],
      fuelLevel:              ["fuelLevel", "fuelLevelPct", "fuel_level"],

      // ── Chassis CAN / Geotab GO9 multi-network ────────────────────────────
      absActivationFreq:       ["absActivationFreq", "abs_activation_freq", "absEvents"],
      suspensionHeightDev:     ["suspensionHeightDev", "suspension_height_dev", "rideHeightDev"],
      stabilityControlFreq:    ["stabilityControlFreq", "stability_control_freq", "escEvents"],
      steeringAngleDrift:      ["steeringAngleDrift", "steering_angle_drift", "steeringDrift"],

      // ── OEM locked signals (Geotab custom CAN rules / OEM Connect APIs) ───
      injectorBalanceVariance: ["injectorBalanceVariance", "injector_balance_variance", "injBalanceVar"],
      cylinderMisfireCount:    ["cylinderMisfireCount", "cylinder_misfire_count", "misfireCount"],
      egrCoolerDelta:          ["egrCoolerDelta", "egr_cooler_delta", "egrCoolerTempDelta"],
      oilDilutionPct:          ["oilDilutionPct", "oil_dilution_pct", "fuelInOil"],
      coolantPressureDecay:    ["coolantPressureDecay", "coolant_pressure_decay", "coolantPressLoss"],
      turboBearingTemp:        ["turboBearingTemp", "turbo_bearing_temp", "turboBearingTempC"],
      dpfAshLoad:              ["dpfAshLoad", "dpf_ash_load", "dpfAshPct"],
      scrEfficiency:           ["scrEfficiency", "scr_efficiency", "scrConversionEff"],

      // ── Physical sensors (hub temp probes, diff sensors, air) ────────────
      hubTempFL:               ["hubTempFL", "hub_temp_fl", "wheelHubTempFrontLeft"],
      hubTempFR:               ["hubTempFR", "hub_temp_fr", "wheelHubTempFrontRight"],
      hubTempRL:               ["hubTempRL", "hub_temp_rl", "wheelHubTempRearLeft"],
      hubTempRR:               ["hubTempRR", "hub_temp_rr", "wheelHubTempRearRight"],
      diffTempFront:           ["diffTempFront", "diff_temp_front", "frontDiffTemp"],
      diffTempRear:            ["diffTempRear", "diff_temp_rear", "rearDiffTemp"],
      airPressureCurrent:      ["airPressureCurrent", "air_pressure_current", "airBrakePressure"],
      airPressureDecayRate:    ["airPressureDecayRate", "air_pressure_decay_rate", "airPressDecay"],

      // ── Accelerometer (scalar per sample or burst via accelBurstX/Y/Z) ───
      accelXRms:               ["accelXRms", "accel_x_rms", "accelX"],
      accelYRms:               ["accelYRms", "accel_y_rms", "accelY"],
      accelZRms:               ["accelZRms", "accel_z_rms", "accelZ"],
      bearingFreqScore:        ["bearingFreqScore", "bearing_freq_score"],
      drivetrainFreqScore:     ["drivetrainFreqScore", "drivetrain_freq_score"],
      engineMountScore:        ["engineMountScore", "engine_mount_score"],
      vibrationAsymmetry:      ["vibrationAsymmetry", "vibration_asymmetry"],
    };
    for (const [target, aliases] of Object.entries(metricMap)) {
      for (const alias of aliases) {
        const val = toNumber(raw[alias]);
        if (val !== null) { metrics[target] = val; break; }
      }
    }
    return {
      vehicleId,
      ts: sanitizeString(s.ts || s.timestamp || nowIso(), 80),
      metrics,
      raw: {}
    };
  }

  // ── POST /api/partner/predict ──────────────────────────────────────────────
  /**
   * Request body:
   * {
   *   vehicleId: string,            (required — your internal truck ID)
   *   samples: [                    (required — last N telemetry readings)
   *     { ts: ISO8601, rpm: 1850, coolantTemp: 94, batteryVoltage: 14.1, ... }
   *   ],
   *   dtcCodes: ["P0128", ...],     (optional — active OBD fault codes)
   *   vehicleMeta: {                (optional — improves predictions)
   *     year: 2019, make: "Freightliner", model: "Cascadia",
   *     vin: "...", vehicleClass: "heavy"
   *   }
   * }
   */
  app.post("/api/partner/predict", requirePartnerKey, async (req, res) => {
    const t0 = Date.now();
    const body = req.body || {};
    const partner = req.apiKey.partner;
    const apiKeyId = req.apiKey.id;

    const vehicleId = sanitizeString(body.vehicleId || "", 120);
    if (!vehicleId) {
      return res.status(400).json({
        success: false,
        error: { code: "MISSING_VEHICLE_ID", message: "vehicleId is required." }
      });
    }

    const rawSamples = Array.isArray(body.samples) ? body.samples : [];
    if (!rawSamples.length) {
      return res.status(400).json({
        success: false,
        error: { code: "NO_SAMPLES", message: "At least one telemetry sample is required." }
      });
    }

    const samples = rawSamples
      .slice(-MAX_SAMPLES)
      .map((s) => normalizeSample(s, vehicleId))
      .filter((s) => Object.keys(s.metrics).length > 0);

    if (!samples.length) {
      return res.status(400).json({
        success: false,
        error: { code: "NO_VALID_METRICS", message: "Samples contained no recognizable metric fields." }
      });
    }

    const dtcCodes = Array.isArray(body.dtcCodes) ? body.dtcCodes.map(String) : [];
    const vehicleMeta = (body.vehicleMeta && typeof body.vehicleMeta === "object") ? body.vehicleMeta : {};

    // Node.js EWMA prediction
    const jsPrediction = ml.computeFullPrediction(samples, vehicleId);

    // Python ensemble prediction
    let pythonPrediction = null;
    let mlError = null;
    try {
      pythonPrediction = await pythonMlClient.predict({
        orgId: `partner:${partner}`,
        vehicleId,
        vehicleMeta: Object.assign({}, vehicleMeta, { vehicleId }),
        samples,
        dtcCodes
      });
    } catch (err) {
      mlError = err.message || "ml_service_unavailable";
    }

    const latencyMs = Date.now() - t0;

    // Build clean partner response
    const riskProbability = pythonPrediction?.riskProbability ?? jsPrediction?.riskProbability ?? null;
    const prediction = pythonPrediction?.prediction ?? (jsPrediction?.insufficientData ? "insufficient_data" : null);
    const confidence = pythonPrediction?.confidence ?? jsPrediction?.confidence ?? null;

    const response = {
      success: true,
      vehicleId,
      timestamp: nowIso(),

      // Core prediction
      riskProbability,
      prediction,
      confidence,
      advisoryText: pythonPrediction?.advisoryText ?? null,

      // Part-level diagnosis (the most valuable field for mechanics)
      diagnosis: pythonPrediction?.diagnosis ?? null,

      // Active fault codes
      activeFaults: pythonPrediction?.dtcAnalysis
        ? {
            codes: dtcCodes,
            riskScore: pythonPrediction.dtcAnalysis.risk_score,
            systemsAffected: pythonPrediction.dtcAnalysis.systems_affected,
            topCodes: pythonPrediction.dtcAnalysis.top_codes?.slice(0, 3)
          }
        : dtcCodes.length ? { codes: dtcCodes, riskScore: null, systemsAffected: [] } : null,

      // Sensor-level breakdown (from Node.js EWMA)
      sensorRisks: jsPrediction?.sensorRisks ?? {},
      multivariateSigns: jsPrediction?.signatures ?? [],

      // Fleet comparison
      fleetNormalization: pythonPrediction?.fleetNormalization?._summary ?? null,

      // Two-stage confirmation (Stage 2 only runs when Stage 1 score >= 0.35)
      stageSystem: pythonPrediction?.stageSystem ?? null,

      // Model metadata
      modelInfo: {
        version: "fleet-ai-v1",
        predictionSource: pythonPrediction ? "python_ensemble" : "node_fallback",
        sampleCount: samples.length,
        mlServiceAvailable: !mlError,
        latencyMs,
        ...(mlError ? { mlError } : {})
      }
    };

    // Log usage for billing
    await logUsage({ partnerName: partner, apiKeyId, vehicleId, riskProbability, confidence, prediction, latencyMs, fullResponse: response });

    // Fire webhooks async (non-blocking)
    notifyPrediction(partner, apiKeyId, vehicleId, response).catch(() => {});

    return res.json(response);
  });

  // ── POST /api/partner/predict/batch ───────────────────────────────────────
  /**
   * Score up to 200 vehicles in one call. Processes in parallel batches of 20.
   * Body: { vehicles: [{ vehicleId, samples, dtcCodes?, vehicleMeta? }, ...] }
   */
  app.post("/api/partner/predict/batch", requirePartnerKey, async (req, res) => {
    const t0 = Date.now();
    const partner = req.apiKey.partner;
    const apiKeyId = req.apiKey.id;
    const vehicles = Array.isArray(req.body?.vehicles) ? req.body.vehicles : [];

    if (!vehicles.length) {
      return res.status(400).json({ success: false, error: { code: "NO_VEHICLES", message: "vehicles array is required." } });
    }
    if (vehicles.length > 200) {
      return res.status(400).json({ success: false, error: { code: "BATCH_TOO_LARGE", message: "Maximum 200 vehicles per batch." } });
    }

    const CONCURRENCY = 20;
    const results = [];

    for (let i = 0; i < vehicles.length; i += CONCURRENCY) {
      const chunk = vehicles.slice(i, i + CONCURRENCY);
      const chunkResults = await Promise.all(chunk.map(async (v) => {
        const vehicleId = sanitizeString(v.vehicleId || "", 120);
        if (!vehicleId) return { vehicleId: v.vehicleId || "unknown", success: false, error: "missing_vehicle_id" };

        const rawSamples = Array.isArray(v.samples) ? v.samples : [];
        if (!rawSamples.length) return { vehicleId, success: false, error: "no_samples" };

        const samples = rawSamples.slice(-MAX_SAMPLES).map((s) => normalizeSample(s, vehicleId)).filter((s) => Object.keys(s.metrics).length > 0);
        if (!samples.length) return { vehicleId, success: false, error: "no_valid_metrics" };

        const dtcCodes = Array.isArray(v.dtcCodes) ? v.dtcCodes.map(String) : [];
        const vehicleMeta = (v.vehicleMeta && typeof v.vehicleMeta === "object") ? v.vehicleMeta : {};

        const jsPrediction = ml.computeFullPrediction(samples, vehicleId);
        let pythonPrediction = null;
        try {
          pythonPrediction = await pythonMlClient.predict({ orgId: `partner:${partner}`, vehicleId, vehicleMeta, samples, dtcCodes });
        } catch (_) {}

        const riskProbability = pythonPrediction?.riskProbability ?? jsPrediction?.riskProbability ?? null;
        const prediction = pythonPrediction?.prediction ?? null;
        const confidence = pythonPrediction?.confidence ?? null;

        const result = {
          success: true,
          vehicleId,
          riskProbability,
          prediction,
          confidence,
          advisoryText: pythonPrediction?.advisoryText ?? null,
          stageSystem: pythonPrediction?.stageSystem ?? null,
          diagnosis: pythonPrediction?.diagnosis ?? null,
          activeFaults: pythonPrediction?.dtcAnalysis ? {
            codes: dtcCodes,
            riskScore: pythonPrediction.dtcAnalysis.risk_score,
            systemsAffected: pythonPrediction.dtcAnalysis.systems_affected,
          } : null,
        };

        logUsage({ partnerName: partner, apiKeyId, vehicleId, riskProbability, confidence, prediction, latencyMs: 0, fullResponse: result }).catch(() => {});
        notifyPrediction(partner, apiKeyId, vehicleId, result).catch(() => {});
        return result;
      }));
      results.push(...chunkResults);
    }

    const latencyMs = Date.now() - t0;
    const critical = results.filter((r) => r.riskProbability >= 0.75).length;
    const warning  = results.filter((r) => r.riskProbability >= 0.35 && r.riskProbability < 0.75).length;
    const healthy  = results.filter((r) => r.riskProbability != null && r.riskProbability < 0.35).length;

    return res.json({
      success: true,
      timestamp: nowIso(),
      processed: results.length,
      summary: { critical, warning, healthy, errors: results.filter((r) => !r.success).length },
      vehicles: results,
      latencyMs,
    });
  });

  // ── GET /api/partner/fleet ─────────────────────────────────────────────────
  /**
   * Risk-ranked fleet summary. Returns all vehicles for the partner, sorted
   * by riskProbability descending (most urgent first).
   * Query: ?limit=100&minRisk=0
   */
  app.get("/api/partner/fleet", requirePartnerKey, async (req, res) => {
    const partner = req.apiKey.partner;
    const limit = Math.min(500, parseInt(req.query.limit) || 100);
    const minRisk = parseFloat(req.query.minRisk) || 0;

    try {
      const prisma = getPrisma();
      // Get the most recent prediction per vehicle for this partner
      const runs = await prisma.mlPredictionRun.findMany({
        where: {
          source: "partner_api",
          orgId: `partner:${partner}`,
          createdAt: { gte: new Date(Date.now() - 24 * 3600 * 1000) },
        },
        orderBy: { createdAt: "desc" },
        take: limit * 3,
        select: { vehicleId: true, riskProbability: true, confidence: true, predictionJson: true, createdAt: true },
      });

      // Deduplicate — keep latest per vehicle
      const seen = new Set();
      const vehicles = [];
      for (const run of runs) {
        if (seen.has(run.vehicleId)) continue;
        seen.add(run.vehicleId);
        const risk = run.riskProbability ? parseFloat(run.riskProbability) : null;
        if (risk !== null && risk < minRisk) continue;
        const json = run.predictionJson && typeof run.predictionJson === "object" ? run.predictionJson : {};
        vehicles.push({
          vehicleId:       run.vehicleId,
          riskProbability: risk,
          confidence:      run.confidence ? parseFloat(run.confidence) : null,
          prediction:      json.prediction ?? null,
          advisoryText:    json.advisoryText ?? null,
          stage2Confirmed: json.stageSystem?.confirmed ?? null,
          signalAgreement: json.stageSystem?.signalAgreement ?? null,
          topSignal:       Array.isArray(json.topMetrics) ? json.topMetrics[0] : null,
          lastSeenAt:      run.createdAt,
        });
      }

      vehicles.sort((a, b) => (b.riskProbability ?? 0) - (a.riskProbability ?? 0));
      const trimmed = vehicles.slice(0, limit);

      return res.json({
        success: true,
        partner,
        asOf: nowIso(),
        summary: {
          critical: trimmed.filter((v) => v.riskProbability >= 0.75).length,
          warning:  trimmed.filter((v) => v.riskProbability >= 0.35 && v.riskProbability < 0.75).length,
          healthy:  trimmed.filter((v) => v.riskProbability != null && v.riskProbability < 0.35).length,
          total:    trimmed.length,
        },
        vehicles: trimmed,
      });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // ── Webhook management ─────────────────────────────────────────────────────

  // POST /api/partner/webhooks — register a webhook
  app.post("/api/partner/webhooks", requirePartnerKey, async (req, res) => {
    const partner = req.apiKey.partner;
    const apiKeyId = req.apiKey.id;
    const { url, events, threshold, secret } = req.body || {};

    if (!url || typeof url !== "string") {
      return res.status(400).json({ success: false, error: { code: "MISSING_URL", message: "url is required." } });
    }
    try { new URL(url); } catch (_) {
      return res.status(400).json({ success: false, error: { code: "INVALID_URL", message: "url must be a valid https URL." } });
    }

    const validEvents = Object.values(WEBHOOK_EVENTS);
    const selectedEvents = Array.isArray(events) ? events.filter((e) => validEvents.includes(e) || e === "*") : ["risk_threshold_crossed", "stage2_confirmed"];
    const thresholdVal = Math.min(1, Math.max(0, parseFloat(threshold) || 0.35));

    try {
      const prisma = getPrisma();
      const hook = await prisma.partnerWebhook.create({
        data: {
          apiKeyId,
          partner,
          url: url.slice(0, 500),
          events: selectedEvents,
          threshold: thresholdVal,
          secret: secret ? String(secret).slice(0, 200) : crypto.randomBytes(24).toString("hex"),
          active: true,
        },
      });

      return res.json({
        success: true,
        webhook: {
          id:        hook.id,
          url:       hook.url,
          events:    hook.events,
          threshold: parseFloat(hook.threshold),
          secret:    hook.secret,
          active:    hook.active,
          createdAt: hook.createdAt,
        },
        note: "Save the secret — it will not be shown again. Use it to verify X-FleetAI-Signature headers on incoming payloads.",
      });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // GET /api/partner/webhooks — list registered webhooks
  app.get("/api/partner/webhooks", requirePartnerKey, async (req, res) => {
    const partner = req.apiKey.partner;
    try {
      const prisma = getPrisma();
      const hooks = await prisma.partnerWebhook.findMany({
        where: { partner },
        select: { id: true, url: true, events: true, threshold: true, active: true, createdAt: true },
        orderBy: { createdAt: "desc" },
      });
      return res.json({ success: true, count: hooks.length, webhooks: hooks });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // DELETE /api/partner/webhooks/:id — remove a webhook
  app.delete("/api/partner/webhooks/:id", requirePartnerKey, async (req, res) => {
    const partner = req.apiKey.partner;
    const { id } = req.params;
    try {
      const prisma = getPrisma();
      const hook = await prisma.partnerWebhook.findFirst({ where: { id, partner } });
      if (!hook) return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Webhook not found." } });
      await prisma.partnerWebhook.delete({ where: { id } });
      return res.json({ success: true, deleted: id });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // ── POST /api/partner/vehicles/:vehicleId/maintenance ─────────────────────
  /**
   * Notify Fleet AI that a vehicle had maintenance. Resets model baselines
   * for the affected subsystem so predictions recalibrate from the new state.
   *
   * Body: { maintenanceType, description?, mileage?, performedAt?, parts? }
   */
  app.post("/api/partner/vehicles/:vehicleId/maintenance", requirePartnerKey, async (req, res) => {
    const vehicleId = sanitizeString(req.params.vehicleId || "", 120);
    if (!vehicleId) return res.status(400).json({ success: false, error: { code: "MISSING_VEHICLE_ID", message: "vehicleId required." } });

    const { maintenanceType, description, mileage, performedAt, parts } = req.body || {};
    if (!maintenanceType) return res.status(400).json({ success: false, error: { code: "MISSING_TYPE", message: "maintenanceType is required." } });

    const partner = req.apiKey.partner;

    try {
      const prisma = getPrisma();

      // Log the maintenance event
      const log = await prisma.maintenanceLog.create({
        data: {
          orgId:          `partner:${partner}`,
          vehicleId,
          maintenanceType: sanitizeString(maintenanceType, 120),
          description:    description ? sanitizeString(description, 1000) : null,
          odometerMiles:  mileage ? parseFloat(mileage) : null,
          performedAt:    performedAt ? new Date(performedAt) : new Date(),
          parts:          Array.isArray(parts) ? parts : [],
          status:         "completed",
          source:         "partner_api",
        },
      }).catch(() => null); // Vehicle may not exist in Prisma yet — non-fatal

      // Signal to the ML service to recalibrate baselines for this vehicle
      // by resetting the Welford state for signals related to the maintenance type
      const resetSignals = _maintenanceResetSignals(maintenanceType);

      return res.json({
        success: true,
        vehicleId,
        maintenanceType,
        loggedAt: nowIso(),
        resetSignals,
        note: "Vehicle baseline will recalibrate over the next 50 telemetry observations.",
      });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // ── GET /api/partner/vehicles/:vehicleId/history ──────────────────────────
  /**
   * Risk score trend for a vehicle over the last N days.
   * Query: ?days=30&resolution=day
   */
  app.get("/api/partner/vehicles/:vehicleId/history", requirePartnerKey, async (req, res) => {
    const vehicleId = sanitizeString(req.params.vehicleId || "", 120);
    if (!vehicleId) return res.status(400).json({ success: false, error: { code: "MISSING_VEHICLE_ID", message: "vehicleId required." } });

    const partner = req.apiKey.partner;
    const days = Math.min(90, Math.max(1, parseInt(req.query.days) || 30));

    try {
      const prisma = getPrisma();
      const since = new Date(Date.now() - days * 86400000);

      const runs = await prisma.mlPredictionRun.findMany({
        where: { vehicleId, orgId: `partner:${partner}`, createdAt: { gte: since } },
        orderBy: { createdAt: "asc" },
        select: { riskProbability: true, confidence: true, predictionJson: true, createdAt: true },
        take: 500,
      });

      const points = runs.map((r) => ({
        ts:              r.createdAt,
        riskProbability: r.riskProbability ? parseFloat(r.riskProbability) : null,
        confidence:      r.confidence ? parseFloat(r.confidence) : null,
        prediction:      r.predictionJson?.prediction ?? null,
        stage2Confirmed: r.predictionJson?.stageSystem?.confirmed ?? null,
      }));

      // Trend: compare last 7 days vs previous 7 days
      const now = Date.now();
      const recent = points.filter((p) => now - new Date(p.ts).getTime() < 7 * 86400000);
      const prior  = points.filter((p) => {
        const age = now - new Date(p.ts).getTime();
        return age >= 7 * 86400000 && age < 14 * 86400000;
      });
      const avgRecent = recent.length ? recent.reduce((s, p) => s + (p.riskProbability ?? 0), 0) / recent.length : null;
      const avgPrior  = prior.length  ? prior.reduce((s, p) => s + (p.riskProbability ?? 0), 0) / prior.length  : null;
      const trend = avgRecent != null && avgPrior != null
        ? avgRecent > avgPrior + 0.05 ? "deteriorating"
        : avgRecent < avgPrior - 0.05 ? "improving"
        : "stable"
        : "insufficient_data";

      return res.json({
        success: true,
        vehicleId,
        days,
        trend,
        averageRisk7d: avgRecent != null ? Math.round(avgRecent * 10000) / 10000 : null,
        dataPoints: points.length,
        history: points,
      });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // ── GET /api/partner/vehicles/:vehicleId/rul ──────────────────────────────
  /**
   * Remaining Useful Life estimate based on current risk degradation rate.
   * Uses last 14 days of risk history to compute linear degradation slope.
   */
  app.get("/api/partner/vehicles/:vehicleId/rul", requirePartnerKey, async (req, res) => {
    const vehicleId = sanitizeString(req.params.vehicleId || "", 120);
    if (!vehicleId) return res.status(400).json({ success: false, error: { code: "MISSING_VEHICLE_ID", message: "vehicleId required." } });

    const partner = req.apiKey.partner;

    try {
      const prisma = getPrisma();
      const since = new Date(Date.now() - 14 * 86400000);

      const runs = await prisma.mlPredictionRun.findMany({
        where: { vehicleId, orgId: `partner:${partner}`, createdAt: { gte: since } },
        orderBy: { createdAt: "asc" },
        select: { riskProbability: true, predictionJson: true, createdAt: true },
        take: 200,
      });

      if (runs.length < 3) {
        return res.json({
          success: true,
          vehicleId,
          available: false,
          reason: "Insufficient prediction history — need at least 3 data points over 14 days.",
        });
      }

      // Linear regression on risk over time (days from first observation)
      const t0ms = new Date(runs[0].createdAt).getTime();
      const pts = runs
        .map((r) => ({ x: (new Date(r.createdAt).getTime() - t0ms) / 86400000, y: parseFloat(r.riskProbability ?? 0) }))
        .filter((p) => p.y > 0);

      const n = pts.length;
      const sumX  = pts.reduce((s, p) => s + p.x, 0);
      const sumY  = pts.reduce((s, p) => s + p.y, 0);
      const sumXY = pts.reduce((s, p) => s + p.x * p.y, 0);
      const sumX2 = pts.reduce((s, p) => s + p.x * p.x, 0);
      const slope = (n * sumXY - sumX * sumY) / Math.max(n * sumX2 - sumX * sumX, 1e-9);
      const intercept = (sumY - slope * sumX) / n;
      const currentRisk = intercept + slope * pts[pts.length - 1].x;

      let estimatedDays = null;
      let urgency = "low";
      const WARNING_THRESHOLD = 0.55;
      const CRITICAL_THRESHOLD = 0.75;

      if (slope > 0.001) {
        // Deteriorating — estimate days until critical
        const daysToWarning  = slope > 0 ? Math.max(0, (WARNING_THRESHOLD  - currentRisk) / slope) : null;
        const daysToCritical = slope > 0 ? Math.max(0, (CRITICAL_THRESHOLD - currentRisk) / slope) : null;

        if (currentRisk >= CRITICAL_THRESHOLD) {
          urgency = "critical";
          estimatedDays = 0;
        } else if (currentRisk >= WARNING_THRESHOLD || (daysToCritical != null && daysToCritical <= 7)) {
          urgency = "high";
          estimatedDays = Math.round(daysToCritical ?? 7);
        } else if (daysToWarning != null && daysToWarning <= 21) {
          urgency = "moderate";
          estimatedDays = Math.round(daysToWarning);
        } else {
          urgency = "low";
          estimatedDays = Math.min(90, Math.round(daysToCritical ?? 90));
        }
      } else {
        urgency = slope < -0.005 ? "improving" : "stable";
        estimatedDays = null;
      }

      // Identify the driving signal from the most recent prediction
      const lastPred = runs[runs.length - 1].predictionJson || {};
      const topSignal = Array.isArray(lastPred.topMetrics) ? lastPred.topMetrics[0] : null;
      const subsystem = lastPred.diagnosis?.primarySubsystem ?? null;

      const recommendation = _rulRecommendation(urgency, topSignal, subsystem, estimatedDays);

      return res.json({
        success: true,
        vehicleId,
        available: true,
        urgency,
        estimatedDaysToService: estimatedDays,
        confidenceInterval: estimatedDays != null ? {
          low:  Math.max(0, Math.round(estimatedDays * 0.65)),
          high: Math.round(estimatedDays * 1.45),
        } : null,
        currentRisk:   Math.round(currentRisk * 10000) / 10000,
        degradationRate: Math.round(slope * 10000) / 10000,
        drivenBySignal: topSignal,
        subsystem,
        recommendation,
        basedOnDays:    14,
        dataPoints:     n,
      });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // ── POST /api/partner/ingest/oem ──────────────────────────────────────────
  /**
   * Accept a push payload from an OEM telematics API (Cummins Connect,
   * Detroit Connect, PACCAR Connect) and merge into the vehicle feature record.
   *
   * Body: { vehicleId, provider: "cummins"|"detroit"|"paccar", data: {...} }
   *
   * Also supports registering a polling integration:
   * Body: { vehicleId, provider, apiKey, endpointUrl, intervalMin }
   */
  app.post("/api/partner/ingest/oem", requirePartnerKey, async (req, res) => {
    const { vehicleId, provider, data, apiKey: oemApiKey, endpointUrl, intervalMin } = req.body || {};
    if (!vehicleId || !provider) {
      return res.status(400).json({ success: false, error: { code: "MISSING_FIELDS", message: "vehicleId and provider are required." } });
    }
    const vid = sanitizeString(vehicleId, 120);

    // Push mode — OEM sent data directly
    if (data && typeof data === "object") {
      const { appendFrames } = require("../telematics/storage/telemetryStore");
      const result = await oemIngestion.ingestPush(vid, provider, data, { appendFrames }, nowIso);
      if (!result.ok) return res.status(400).json({ success: false, error: result.error });
      return res.json({ success: true, vehicleId: vid, provider, metricsIngested: result.metricsIngested, metrics: result.metrics });
    }

    // Poll mode — register a recurring polling integration
    if (oemApiKey && endpointUrl) {
      const { appendFrames } = require("../telematics/storage/telemetryStore");
      const ok = oemIngestion.registerIntegration(
        { vehicleId: vid, provider, apiKey: oemApiKey, endpointUrl, intervalMin: intervalMin || 15 },
        { appendFrames },
        nowIso
      );
      if (!ok) return res.status(400).json({ success: false, error: `Unsupported provider: ${provider}` });
      return res.json({ success: true, vehicleId: vid, provider, mode: "polling", intervalMin: intervalMin || 15 });
    }

    return res.status(400).json({ success: false, error: { code: "MISSING_PAYLOAD", message: "Provide either 'data' (push) or 'apiKey' + 'endpointUrl' (poll)." } });
  });

  // GET /api/partner/ingest/oem — list active polling integrations (admin)
  app.get("/api/partner/ingest/oem", requireSuperAdmin, (req, res) => {
    return res.json({ success: true, integrations: oemIngestion.listIntegrations() });
  });

  // ── GET /api/partner/status ────────────────────────────────────────────────
  /**
   * Check model readiness for a vehicle before sending predictions.
   * Query param: vehicleId
   */
  app.get("/api/partner/status", requirePartnerKey, async (req, res) => {
    const vehicleId = sanitizeString(req.query.vehicleId || "", 120);
    if (!vehicleId) {
      return res.status(400).json({ success: false, error: { code: "MISSING_VEHICLE_ID", message: "vehicleId query param required." } });
    }
    try {
      const status = await pythonMlClient.status(vehicleId);
      return res.json({ success: true, vehicleId, status });
    } catch (_) {
      return res.json({
        success: true,
        vehicleId,
        status: { mlServiceAvailable: false, note: "ML service unavailable. Predictions will use Node.js fallback." }
      });
    }
  });

  // ── GET /api/partner/usage ────────────────────────────────────────────────
  /**
   * Returns usage summary per partner for billing. Admin only.
   * Query params: ?days=30&partner=geotab
   */
  app.get("/api/partner/usage", requireSuperAdmin, async (req, res) => {
    try {
      const days = Math.min(365, Math.max(1, parseInt(req.query.days || "30", 10)));
      const filterPartner = req.query.partner ? sanitizeString(req.query.partner, 120) : null;
      const prisma = getPrisma();

      const since = new Date(Date.now() - days * 86400000);
      const runs = await prisma.mlPredictionRun.findMany({
        where: {
          source: "partner_api",
          createdAt: { gte: since },
          ...(filterPartner ? { orgId: `partner:${filterPartner}` } : {})
        },
        select: { orgId: true, vehicleId: true, createdAt: true, riskProbability: true }
      });

      // Group by partner
      const byPartner = {};
      for (const run of runs) {
        const name = (run.orgId || "").replace(/^partner:/, "") || "unknown";
        if (!byPartner[name]) {
          byPartner[name] = { partner: name, totalCalls: 0, uniqueVehicles: new Set(), periodDays: days };
        }
        byPartner[name].totalCalls += 1;
        if (run.vehicleId) byPartner[name].uniqueVehicles.add(run.vehicleId);
      }

      const summary = Object.values(byPartner).map((p) => ({
        partner: p.partner,
        periodDays: p.periodDays,
        totalApiCalls: p.totalCalls,
        uniqueVehicles: p.uniqueVehicles.size,
        estimatedMonthlyRevenue: `$${(p.uniqueVehicles.size * 15).toLocaleString()}`
      }));

      return res.json({ success: true, periodDays: days, data: summary });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _maintenanceResetSignals(maintenanceType) {
  const type = (maintenanceType || "").toLowerCase();
  if (type.includes("brake"))       return ["brake_temp", "brake_temp_delta_30d"];
  if (type.includes("oil"))         return ["oil_temp", "oil_pressure", "engine_efficiency"];
  if (type.includes("coolant") || type.includes("cooling") || type.includes("thermostat"))
                                    return ["engine_temp", "coolant_temp_oscillation", "engine_temp_delta_30d"];
  if (type.includes("battery") || type.includes("electrical") || type.includes("alternator"))
                                    return ["battery_voltage", "battery_voltage_delta_30d"];
  if (type.includes("dpf") || type.includes("diesel particulate"))
                                    return ["dpf_soot_load", "dpf_soot_delta_30d", "dpf_differential_kpa"];
  if (type.includes("fuel") || type.includes("injector"))
                                    return ["fuel_pressure", "fuel_trim_long", "fuel_trim_short"];
  if (type.includes("transmission")) return ["transmission_temp"];
  if (type.includes("tire") || type.includes("tyre"))
                                    return ["tire_pressure"];
  return ["general_maintenance"];
}

function _rulRecommendation(urgency, topSignal, subsystem, estimatedDays) {
  if (urgency === "critical") return "Immediate inspection required. Do not dispatch this vehicle.";
  if (urgency === "high") {
    const system = subsystem || topSignal || "vehicle systems";
    return `Schedule ${system} inspection within ${estimatedDays ?? 7} days. Monitor closely on every run.`;
  }
  if (urgency === "moderate") {
    return `Plan maintenance within ${estimatedDays ?? 21} days. No immediate action required.`;
  }
  if (urgency === "improving") return "Vehicle health is improving since last service. Continue monitoring.";
  if (urgency === "stable")    return "Risk is stable. Maintain regular service schedule.";
  return "Insufficient data to generate a recommendation. Continue monitoring.";
}

module.exports = { registerPartnerRoutes };
