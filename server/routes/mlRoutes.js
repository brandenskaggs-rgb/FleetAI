const ml = require("../ml");
const sqliteDb = require("../db");
const pythonMlClient = require("../services/pythonMlClient");
const aiReportSvc = require("../services/aiReportService");
const { sanitizeString } = require("../lib/utils");
const { mergePythonAndNodePrediction } = require("../lib/mlMerge");
const { predictionLimiter, defaultLimiter } = require("../middleware/rateLimiter");

function registerMlRoutes(app, deps) {
  const { requireEmployeeOrCustomerApi, readData, resolveOrgIdForVehicle } = deps;

  app.get("/api/ml/service/status", requireEmployeeOrCustomerApi, async (req, res) => {
    try {
      const status = await pythonMlClient.status();
      return res.json({ ok: true, data: status });
    } catch (err) {
      return res.json({
        ok: true,
        data: {
          modelLoaded: false,
          serviceAvailable: false,
          error: err.message || "python_ml_unavailable",
          fallback: "node-ewma-v1"
        }
      });
    }
  });

  app.get("/api/ml/state", requireEmployeeOrCustomerApi, async (req, res) => {
    try {
      const states = await sqliteDb.getAllModelStates();
      const orgId = req.customer?.orgId || null;
      const filtered = orgId ? states.filter((s) => !s.orgId || s.orgId === orgId) : states;
      return res.json({ ok: true, data: filtered });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get("/api/ml/alerts", requireEmployeeOrCustomerApi, defaultLimiter, async (req, res) => {
    try {
      const orgId = req.customer?.orgId || req.query.orgId || "ORG_DEFAULT";
      const alerts = await sqliteDb.getAlertsForOrg(orgId, { limit: 100, unresolvedOnly: req.query.unresolved === "true" });
      return res.json({ ok: true, data: alerts });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post("/api/ml/recompute", requireEmployeeOrCustomerApi, predictionLimiter, async (req, res) => {
    try {
      const vehicleId = sanitizeString(req.body?.vehicleId || req.query.vehicleId, 120);
      if (!vehicleId) return res.status(400).json({ ok: false, error: "vehicleId required" });
      const data = await readData();
      const orgId = resolveOrgIdForVehicle(data, vehicleId);
      if (req.customer && req.customer.orgId && req.customer.orgId !== orgId) {
        return res.status(403).json({ ok: false, error: "cross_org_vehicle_denied" });
      }
      const samples = await sqliteDb.getSamplesForVehicle(vehicleId, { limit: 5000 });
      const jsPrediction = ml.computeFullPrediction(samples, vehicleId);
      const caps = (await sqliteDb.getVehicleCapabilities(vehicleId)) || {};
      let pythonPrediction = null;
      let pythonError = null;
      try {
        const latestSample = samples.length ? samples[samples.length - 1] : null;
        const dtcCodes = latestSample?.raw?.activeDTCs || latestSample?.metrics?.activeDTCs || [];
        pythonPrediction = await pythonMlClient.predict({ orgId, vehicleId, vehicleMeta: Object.assign({}, caps, { vehicleId }), samples, dtcCodes });
      } catch (err) {
        pythonError = err.message || "python_ml_unavailable";
      }
      const prediction = mergePythonAndNodePrediction(jsPrediction, pythonPrediction, { orgId, vehicleId, pythonError });
      await sqliteDb.upsertModelState(prediction);
      const runId = await sqliteDb.insertMlPredictionRun({
        orgId,
        vehicleId,
        modelVersion: prediction.modelVersion || "node-fallback",
        source: prediction.predictionSource || "node_fallback",
        confidenceStage: prediction.confidenceStage || null,
        confidence: prediction.confidence,
        riskProbability: prediction.riskProbability,
        healthScore: prediction.healthScore,
        prediction
      });
      if (prediction.featureVector) {
        await sqliteDb.insertMlFeatureSnapshot({ orgId, vehicleId, predictionRunId: runId, features: prediction.featureVector });
      }
      return res.json({ ok: true, data: prediction });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  /**
   * GET /api/vehicles/:vehicleId/prediction
   * Returns the current ML health prediction for a vehicle.
   * Merges Node EWMA model with Python ML service output.
   * Falls back to Node-only prediction when Python service is unavailable.
   * @param {string} req.params.vehicleId - Vehicle identifier
   * @param {string} [req.query.alertMode] - Alert mode override (default: "launch_default")
   */
  app.get("/api/vehicles/:vehicleId/prediction", requireEmployeeOrCustomerApi, predictionLimiter, async (req, res) => {
    try {
      const { vehicleId } = req.params;
      const data = await readData();
      const orgId = resolveOrgIdForVehicle(data, vehicleId);
      if (req.customer && req.customer.orgId && req.customer.orgId !== orgId) {
        return res.status(403).json({ ok: false, error: "cross_org_vehicle_denied" });
      }
      const samples = await sqliteDb.getSamplesForVehicle(vehicleId, { limit: 5000 });
      const jsPrediction = ml.computeFullPrediction(samples, vehicleId);
      const caps = (await sqliteDb.getVehicleCapabilities(vehicleId)) || {};
      let pythonPrediction = null;
      let pythonError = null;
      try {
        pythonPrediction = await pythonMlClient.predict({
          orgId,
          vehicleId,
          vehicleMeta: Object.assign({}, caps, { vehicleId }),
          samples,
          alertMode: req.query.alertMode || "launch_default"
        });
      } catch (err) {
        pythonError = err.message || "python_ml_unavailable";
      }
      const prediction = mergePythonAndNodePrediction(jsPrediction, pythonPrediction, { orgId, vehicleId, pythonError });
      await sqliteDb.upsertModelState(prediction);
      const runId = await sqliteDb.insertMlPredictionRun({
        orgId,
        vehicleId,
        modelVersion: prediction.modelVersion || "node-fallback",
        source: prediction.predictionSource || "node_fallback",
        confidenceStage: prediction.confidenceStage || null,
        confidence: prediction.confidence,
        riskProbability: prediction.riskProbability,
        healthScore: prediction.healthScore,
        prediction
      });
      if (prediction.featureVector) {
        await sqliteDb.insertMlFeatureSnapshot({ orgId, vehicleId, predictionRunId: runId, features: prediction.featureVector });
      }
      return res.json({ ok: true, data: prediction });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get("/api/vehicles/:vehicleId/report", requireEmployeeOrCustomerApi, async (req, res) => {
    try {
      const { vehicleId } = req.params;
      const data = await readData();
      const orgId = resolveOrgIdForVehicle(data, vehicleId);
      if (req.customer && req.customer.orgId && req.customer.orgId !== orgId) {
        return res.status(403).json({ ok: false, error: "cross_org_vehicle_denied" });
      }
      const report = await sqliteDb.getLatestAiReport(vehicleId);
      if (!report) return res.status(404).json({ ok: false, error: "No report found" });
      return res.json({ ok: true, data: report });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post("/api/vehicles/:vehicleId/report/generate", requireEmployeeOrCustomerApi, async (req, res) => {
    try {
      const { vehicleId } = req.params;
      const data = await readData();
      const orgId = resolveOrgIdForVehicle(data, vehicleId);
      if (req.customer && req.customer.orgId && req.customer.orgId !== orgId) {
        return res.status(403).json({ ok: false, error: "cross_org_vehicle_denied" });
      }
      const samples = await sqliteDb.getSamplesForVehicle(vehicleId, { limit: 5000 });
      const prediction = ml.computeFullPrediction(samples, vehicleId);
      await sqliteDb.upsertModelState(prediction);
      const caps = await sqliteDb.getVehicleCapabilities(vehicleId);
      const report = await aiReportSvc.generateReport(prediction, caps || {});
      return res.json({ ok: true, data: report });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get("/api/vehicles/:vehicleId/capabilities", requireEmployeeOrCustomerApi, async (req, res) => {
    try {
      const { vehicleId } = req.params;
      const data = await readData();
      const orgId = resolveOrgIdForVehicle(data, vehicleId);
      if (req.customer && req.customer.orgId && req.customer.orgId !== orgId) {
        return res.status(403).json({ ok: false, error: "cross_org_vehicle_denied" });
      }
      const caps = await sqliteDb.getVehicleCapabilities(vehicleId);
      return res.json({ ok: true, data: caps || null });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get("/api/vehicles/:vehicleId/alerts", requireEmployeeOrCustomerApi, async (req, res) => {
    try {
      const { vehicleId } = req.params;
      const data = await readData();
      const orgId = resolveOrgIdForVehicle(data, vehicleId);
      if (req.customer && req.customer.orgId && req.customer.orgId !== orgId) {
        return res.status(403).json({ ok: false, error: "cross_org_vehicle_denied" });
      }
      const unresolved = req.query.unresolved === "true";
      const alerts = await sqliteDb.getAlertsForVehicle(vehicleId, { limit: 50, unresolvedOnly: unresolved });
      return res.json({ ok: true, data: alerts });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post("/api/alerts/:alertId/ack", requireEmployeeOrCustomerApi, async (req, res) => {
    try {
      await sqliteDb.ackAlert(req.params.alertId);
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post("/api/alerts/:alertId/resolve", requireEmployeeOrCustomerApi, async (req, res) => {
    try {
      await sqliteDb.resolveAlert(req.params.alertId);
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });
}

module.exports = { registerMlRoutes };
