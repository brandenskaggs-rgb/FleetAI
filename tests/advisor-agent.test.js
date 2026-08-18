const assert = require("assert");
const {
  buildReportArtifact,
  planAdvisorActions,
  renderReportHtml,
  renderReportText,
  reportTypeFor
} = require("../server/services/advisorAgentService");

const context = {
  generatedAt: "2026-08-18T21:30:00.000Z",
  lookbackDays: 30,
  organization: { id: "ORG_1", name: "Demo Fleet" },
  selectedVehicleId: null,
  assets: [{ vehicleId: "Car-01", unitName: "Camaro" }],
  recordCounts: { telemetrySamples: 362 },
  riskOverview: { activeCriticalAlerts: 0 },
  driveLogs: [{ vehicleId: "Car-01", sampleCount: 362 }],
  vehicleHealth: [], alerts: [], maintenance: [], workOrders: [], inspections: {},
  compliance: {}, drivers: [], fuel: []
};

assert.strictEqual(reportTypeFor("Generate a report from the latest drive logs"), "drive");
assert.strictEqual(reportTypeFor("Build a DOT compliance brief"), "compliance");

const reportActions = planAdvisorActions("Generate a risk report for Car-01", context);
assert.strictEqual(reportActions.length, 1);
assert.strictEqual(reportActions[0].action, "generate_report");
assert.strictEqual(reportActions[0].mode, "automatic");
assert.strictEqual(reportActions[0].vehicleId, "Car-01");

const workOrderActions = planAdvisorActions("Create a high priority work order for the Camaro", context);
assert.strictEqual(workOrderActions.length, 1);
assert.strictEqual(workOrderActions[0].action, "create_work_order");
assert.strictEqual(workOrderActions[0].mode, "confirmation_required");
assert.strictEqual(workOrderActions[0].payload.vehicleId, "Car-01");
assert.strictEqual(workOrderActions[0].payload.priority, "high");

const artifactData = buildReportArtifact({
  action: reportActions[0], context, reply: "No critical risks are active.", request: "Generate a risk report", userId: "USR_1"
});
const report = renderReportText({ id: "ART_1", createdAt: new Date(context.generatedAt), ...artifactData, content: artifactData.content });
assert(report.includes("Executive summary"));
assert(report.includes("Fleet AI evidence"));
assert(report.includes("No critical risks are active."));
const html = renderReportHtml({ id: "ART_1", createdAt: new Date(context.generatedAt), ...artifactData, content: artifactData.content });
assert(html.startsWith("<!doctype html>"));
assert(html.includes("Print / Save PDF"));
assert(html.includes("Supporting fleet records"));

console.log("Advisor agent tests passed.");
