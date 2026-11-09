"use strict";

const COMPONENTS = new Set(["charging", "cooling", "fuel", "engine", "emissions", "drivetrain", "brakes", "tires", "bearings", "sensor"]);
const SOURCES = new Set(["technician", "repair_invoice", "inspection", "maintenance_integration"]);

function validateOutcomeEvidence(input, outcome, now = new Date()) {
  if (input == null) return {}; // Legacy feedback is review evidence only.
  if (typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid outcome evidence");
  if (!COMPONENTS.has(input.component) || !SOURCES.has(input.source)) throw new Error("Choose a supported component and evidence source");
  const observedAt = new Date(input.observedAt);
  if (!input.observedAt || !Number.isFinite(observedAt.getTime()) || observedAt > now) throw new Error("Outcome date must be an observed past date");
  const confirmedFailure = input.confirmedFailure === true;
  const inspectedNormal = input.inspectedNormal === true;
  if (confirmedFailure && inspectedNormal) throw new Error("Failure and normal inspection cannot both be confirmed");
  if (outcome === "confirmed_breakdown" && !confirmedFailure) throw new Error("A breakdown label requires confirmed failure evidence");
  if (["false_positive", "confirmed_normal"].includes(outcome) && (!inspectedNormal || confirmedFailure)) throw new Error("A negative outcome requires a confirmed normal inspection");
  const evidence = {
    version: 1, component: input.component, source: input.source,
    observedAt: observedAt.toISOString(), confirmedFailure, inspectedNormal,
    maintenanceType: String(input.maintenanceType || "").trim().slice(0, 160),
    technicianNotes: String(input.technicianNotes || "").trim().slice(0, 2000),
    repairNotes: String(input.repairNotes || "").trim().slice(0, 2000),
    severity: ["low", "medium", "high", "critical"].includes(input.severity) ? input.severity : "unknown",
    dtcs: Array.isArray(input.dtcs) ? input.dtcs.filter(x => typeof x === "string").slice(0, 50).map(x => x.slice(0, 40)) : []
  };
  if (!evidence.maintenanceType || !evidence.technicianNotes) throw new Error("Maintenance type and inspection evidence are required");
  for (const field of ["mileage", "cost"]) {
    if (input[field] != null) {
      if (typeof input[field] !== "number" || !Number.isFinite(input[field]) || input[field] < 0) throw new Error(`Invalid ${field}`);
      evidence[field] = input[field];
    }
  }
  if (input.coverageStart) {
    const start = new Date(input.coverageStart);
    if (!Number.isFinite(start.getTime()) || start >= observedAt) throw new Error("Invalid confirmed observation coverage");
    evidence.coverageStart = start.toISOString();
  }
  return evidence;
}

function learningScope(req) {
  if (req.customer) return req.customer.orgId || null;
  if (!req.employee) return null;
  return req.employee.orgId || (typeof req.query?.orgId === "string" ? req.query.orgId : null);
}

async function learningSummary(prisma, orgId) {
  if (!orgId) throw new Error("org_scope_required");
  try {
    const latest = await prisma.mlLearningRun.findFirst({ where: { orgId }, orderBy: { createdAt: "desc" } });
    const recentOutcomes = await prisma.feedbackLog.findMany({ where: { orgId }, orderBy: { createdAt: "desc" }, take: 10,
      select: { id: true, vehicleId: true, outcome: true, outcomeEvidence: true, createdAt: true } });
    const summary = latest?.summary || {};
    return { available: true, lastRun: latest ? { id: latest.id, status: latest.status, updatedAt: latest.updatedAt } : null,
      dataset: summary.dataset || null, evaluation: summary.training?.report || null,
      candidateId: summary.training?.candidateId || null, error: summary.error || null,
      recentOutcomes: recentOutcomes.map(row => ({ evidenceRef: `outcome:${row.id}`, vehicleId: row.vehicleId,
        outcome: row.outcome, component: row.outcomeEvidence?.component, observedAt: row.outcomeEvidence?.observedAt,
        confirmedFailure: row.outcomeEvidence?.confirmedFailure === true, source: row.outcomeEvidence?.source })),
      evidenceBoundary: "Human-reviewed outcomes; synthetic priors are not proven field accuracy. Registry status is as of the last worker run." };
  } catch (_) {
    return { available: false, reason: "learning_status_unavailable" };
  }
}

module.exports = { validateOutcomeEvidence, learningScope, learningSummary };
