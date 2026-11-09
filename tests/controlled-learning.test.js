const test = require("node:test");
const assert = require("node:assert/strict");
const { validateOutcomeEvidence, learningScope, learningSummary } = require("../server/services/learningEvidence");
const { buildAdvisorSystemPrompt } = require("../server/services/advisorConversation");

const evidence = { component: "charging", source: "technician", observedAt: "2025-01-02T00:00:00Z",
  confirmedFailure: true, maintenanceType: "Alternator repair", technicianNotes: "Fixture inspection evidence" };
test("outcome validation cannot convert replacement or missing evidence into failure", () => {
  assert.deepEqual(validateOutcomeEvidence(undefined, "confirmed_breakdown"), {});
  assert.throws(() => validateOutcomeEvidence({ ...evidence, confirmedFailure: false }, "confirmed_breakdown"));
  assert.throws(() => validateOutcomeEvidence({ ...evidence, observedAt: "2999-01-01" }, "confirmed_breakdown"));
  assert.throws(() => validateOutcomeEvidence({ ...evidence, inspectedNormal: true }, "confirmed_breakdown"));
  assert.equal(validateOutcomeEvidence(evidence, "confirmed_breakdown").confirmedFailure, true);
});
test("customer scope wins over supplied organization and coexisting employee", () => {
  assert.equal(learningScope({ customer: { orgId: "a" }, employee: {}, query: { orgId: "b" } }), "a");
  assert.equal(learningScope({ customer: {}, employee: {}, query: { orgId: "b" } }), null);
  assert.equal(learningScope({ query: { orgId: "b" } }), null);
});
test("Advisor receives only scoped learning evidence and cannot promote or label", async () => {
  const requests = [];
  const prisma = {
    mlLearningRun: { findFirst: async q => { requests.push(q); return null; } },
    feedbackLog: { findMany: async q => { requests.push(q); return []; } }
  };
  assert.equal((await learningSummary(prisma, "org-a")).available, true);
  assert(requests.every(q => q.where.orgId === "org-a"));
  await assert.rejects(learningSummary(prisma, ""));
  const prompt = buildAdvisorSystemPrompt({});
  assert.match(prompt, /Never generate supervised labels/);
  assert.match(prompt, /not a countdown to breakdown/);
});
test("old deployments fail closed without taking Advisor offline", async () => {
  assert.equal((await learningSummary({}, "org-a")).available, false);
});

test("feedback route discards forged OOF features and rejects another fleet", async () => {
  const db = require("../server/db");
  const { registerFeedbackRoutes } = require("../server/routes/feedbackRoutes");
  const original = db.getPrisma;
  let created;
  db.getPrisma = () => ({ vehicle: { findUnique: async () => ({ vehicleId: "v-a", orgId: "org-a" }) },
    feedbackLog: { create: async ({ data }) => { created = data; return { ...data, id: "fixture" }; } } });
  const routes = new Map();
  const app = { get: (url,...handlers) => routes.set(url,handlers.at(-1)), post: (url,...handlers) => routes.set("POST " + url,handlers.at(-1)) };
  registerFeedbackRoutes(app, { requireAuth: (_,__,next) => next() });
  const res = { statusCode: 200, status(code) { this.statusCode=code; return this; }, json(data) { this.body=data; return this; } };
  try {
    const body = { vehicleId: "v-a", outcome: "no_event", features: { provenance: { source: "real_oof" }, battery_voltage: 99 } };
    await routes.get("POST /api/telemetry/feedback")({ body, customer: { orgId: "org-b" } }, res);
    assert.equal(res.statusCode, 403);
    assert.equal(created, undefined);
    res.statusCode = 200;
    await routes.get("POST /api/telemetry/feedback")({ body, customer: { orgId: "org-a" } }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(created.features, {});
    assert.deepEqual(created.outcomeEvidence, {});
    assert.equal(created.orgId, "org-a");
  } finally { db.getPrisma = original; }
});
