/**
 * Operator feedback routes — capture confirmed breakdowns and false positives
 * so Stage 2 can retrain on real labeled data.
 *
 * POST /api/telemetry/feedback   — submit prediction outcome
 * GET  /api/telemetry/feedback   — list feedback for a vehicle (admin/org)
 */

const db = require("../db");
const { validateOutcomeEvidence, learningScope } = require("../services/learningEvidence");

const VALID_OUTCOMES = ["confirmed_breakdown", "false_positive", "confirmed_normal", "maintenance_only", "no_event"];

function registerFeedbackRoutes(app, deps) {
  const { requireAuth } = deps;

  // ── POST /api/telemetry/feedback ──────────────────────────────────────────
  app.post("/api/telemetry/feedback", requireAuth, async (req, res) => {
    const { vehicleId, predictionRunId, outcome, notes, stage1Score, stage2Score, signalAgreement, features, reviewedBy } = req.body || {};

    if (!vehicleId || typeof vehicleId !== "string") {
      return res.status(400).json({ error: "vehicleId required" });
    }
    if (!outcome || !VALID_OUTCOMES.includes(outcome)) {
      return res.status(400).json({ error: `outcome must be one of: ${VALID_OUTCOMES.join(", ")}` });
    }

    try {
      let outcomeEvidence;
      try { outcomeEvidence = validateOutcomeEvidence(req.body.outcomeEvidence, outcome); }
      catch (error) { return res.status(400).json({ error: error.message }); }
      if (!req.customer?.orgId && !req.employee) return res.status(403).json({ error: "org_scope_required" });
      const prisma = db.getPrisma();
      const vehicle = await prisma.vehicle.findUnique({
        where: { vehicleId: String(vehicleId) },
        select: { vehicleId: true, orgId: true }
      });
      if (!vehicle) return res.status(404).json({ error: "vehicle_not_found" });
      if (req.customer?.orgId && req.customer.orgId !== vehicle.orgId) {
        return res.status(403).json({ error: "cross_org_vehicle_denied" });
      }
      if (req.employee?.orgId && req.employee.orgId !== vehicle.orgId) {
        return res.status(403).json({ error: "cross_org_vehicle_denied" });
      }
      const orgId = vehicle.orgId;
      if (predictionRunId) {
        const run = await prisma.mlPredictionRun.findFirst({
          where: { id: String(predictionRunId), vehicleId: vehicle.vehicleId, orgId },
          select: { id: true }
        });
        if (!run) return res.status(400).json({ error: "prediction_run_not_found_for_vehicle" });
      }
      const entry = await prisma.feedbackLog.create({
        data: {
          orgId,
          vehicleId,
          predictionRunId: predictionRunId ?? null,
          outcome,
          notes: notes ? String(notes).slice(0, 2000) : null,
          stage1Score: stage1Score != null ? parseFloat(stage1Score) : null,
          stage2Score: stage2Score != null ? parseFloat(stage2Score) : null,
          signalAgreement: signalAgreement != null ? parseFloat(signalAgreement) : null,
          // Client/LLM-provided vectors must never masquerade as genuine OOF evidence.
          features: {},
          outcomeEvidence,
          sourceReference: typeof req.body.sourceReference === "string" ? req.body.sourceReference.trim().slice(0, 200) || null : null,
          reviewedBy: req.employee?.email ?? req.customer?.email ?? null,
        },
      });

      return res.json({
        ok: true,
        id: entry.id,
        outcome: entry.outcome,
        vehicleId: entry.vehicleId,
        createdAt: entry.createdAt,
        evidenceStatus: outcomeEvidence.version ? "recorded_pending_dataset_validation" : "review_only_not_training_eligible",
      });
    } catch (err) {
      if (err.code === "P2002") return res.status(409).json({ error: "outcome_source_already_recorded" });
      console.error("[feedback] create error:", err);
      return res.status(500).json({ error: "Failed to save feedback" });
    }
  });

  // ── GET /api/telemetry/feedback?vehicleId=xxx ─────────────────────────────
  app.get("/api/telemetry/feedback", requireAuth, async (req, res) => {
    const { vehicleId, outcome, limit: rawLimit } = req.query;
    const limit = Math.max(1, Math.min(parseInt(rawLimit) || 50, 200));
    const orgId = learningScope(req);
    if (!orgId) return res.status(403).json({ error: "org_scope_required" });

    try {
      const prisma = db.getPrisma();
      const where = {};
      if (vehicleId) where.vehicleId = String(vehicleId);
      if (outcome && VALID_OUTCOMES.includes(outcome)) where.outcome = outcome;
      if (orgId) where.orgId = orgId;

      const rows = await prisma.feedbackLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        select: {
          id: true,
          vehicleId: true,
          outcome: true,
          notes: true,
          stage1Score: true,
          stage2Score: true,
          signalAgreement: true,
          reviewedBy: true,
          createdAt: true,
          outcomeEvidence: true,
          predictionRunId: true,
        },
      });

      return res.json({ ok: true, count: rows.length, rows });
    } catch (err) {
      console.error("[feedback] list error:", err);
      return res.status(500).json({ error: "Failed to fetch feedback" });
    }
  });

  app.get("/api/ml/learning", requireAuth, async (req, res) => {
    const orgId = learningScope(req);
    if (!orgId) return res.status(403).json({ error: "org_scope_required" });
    try {
      const prisma = db.getPrisma();
      const telemetryRecords = await prisma.telemetrySample.count({ where: { orgId } });
      const predictionRecords = await prisma.mlPredictionRun.count({ where: { orgId } });
      const reviewedOutcomes = await prisma.feedbackLog.count({ where: { orgId } });
      const confirmedOutcomes = await prisma.feedbackLog.count({ where: { orgId, OR: [
        { outcomeEvidence: { path: ["confirmedFailure"], equals: true } },
        { outcomeEvidence: { path: ["inspectedNormal"], equals: true } }
      ] } });
      const runs = await prisma.mlLearningRun.findMany({ where: { orgId }, orderBy: { createdAt: "desc" }, take: 20 });
      res.json({ ok: true, telemetryRecords, predictionRecords, reviewedOutcomes, confirmedOutcomes, runs,
        policy: "Verified outcomes only. LLM output is not a label. Production promotion requires operator review." });
    } catch (_) { res.status(503).json({ error: "learning_status_unavailable" }); }
  });
}

module.exports = { registerFeedbackRoutes };
