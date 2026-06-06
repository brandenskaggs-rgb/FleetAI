/**
 * Operator feedback routes — capture confirmed breakdowns and false positives
 * so Stage 2 can retrain on real labeled data.
 *
 * POST /api/telemetry/feedback   — submit prediction outcome
 * GET  /api/telemetry/feedback   — list feedback for a vehicle (admin/org)
 */

const { getPrisma } = require("../db");

const VALID_OUTCOMES = ["confirmed_breakdown", "false_positive", "no_event"];

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

    const orgId = req.user?.orgId ?? null;

    try {
      const prisma = getPrisma();
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
          features: features && typeof features === "object" ? features : {},
          reviewedBy: reviewedBy ? String(reviewedBy).slice(0, 100) : (req.user?.email ?? null),
        },
      });

      return res.json({
        ok: true,
        id: entry.id,
        outcome: entry.outcome,
        vehicleId: entry.vehicleId,
        createdAt: entry.createdAt,
      });
    } catch (err) {
      console.error("[feedback] create error:", err);
      return res.status(500).json({ error: "Failed to save feedback" });
    }
  });

  // ── GET /api/telemetry/feedback?vehicleId=xxx ─────────────────────────────
  app.get("/api/telemetry/feedback", requireAuth, async (req, res) => {
    const { vehicleId, outcome, limit: rawLimit } = req.query;
    const limit = Math.min(parseInt(rawLimit) || 50, 200);
    const orgId = req.user?.orgId ?? null;

    try {
      const prisma = getPrisma();
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
        },
      });

      return res.json({ ok: true, count: rows.length, rows });
    } catch (err) {
      console.error("[feedback] list error:", err);
      return res.status(500).json({ error: "Failed to fetch feedback" });
    }
  });
}

module.exports = { registerFeedbackRoutes };
