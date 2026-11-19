const test = require("node:test");
const assert = require("node:assert/strict");
const { diagnosticIntent, diagnosticStatusReply, guardDiagnosticClaims } = require("../server/services/advisorDiagnosticStatus");

test("scan follow-ups use user intent, not assistant promises as execution evidence", () => {
  const history = [{ role: "user", content: "Run a diagnostic scan" }, { role: "assistant", content: "Still running; I'll notify you" }];
  for (const msg of ["Is it done?", "Are you done?", "Any results?", "What is the scan status?", "Is the scan still running?"]) assert.equal(diagnosticIntent(msg, history), "status", msg);
  for (const msg of ["try again", "run it again", "Run a full scan", "Can you start a scan?"]) assert.equal(diagnosticIntent(msg, history), "run", msg);
  assert.equal(diagnosticIntent("try again", [{ role: "assistant", content: "Run a scan" }]), null);
  assert.equal(diagnosticIntent("is it done?", [{ role: "user", content: "Make a fuel report" }]), null);
  assert.equal(diagnosticIntent("don't run a scan", history), null);
  assert.equal(diagnosticIntent("Is it still running?", [...history, { role: "user", content: "Is it done?" }]), "status");
  assert.equal(diagnosticIntent("Is it done?", [...history, { role: "user", content: "Generate a fuel report" }]), null);
});

test("status reads saved artifacts for the authorized tenant and vehicle only", async () => {
  let found = null, queries = 0;
  const prisma = {
    vehicle: { findFirst: async ({ where }) => where.orgId === "A" && where.vehicleId === "car" ? { vehicleId: "car" } : null },
    advisorArtifact: { findFirst: async ({ where }) => {
      queries++; assert.equal(where.orgId, "A"); assert.equal(where.type, "live_diagnostic");
      assert.deepEqual(where.content, { path: ["scope", "vehicleId"], equals: "car" }); return found;
    } }
  };
  assert.equal(await diagnosticStatusReply(prisma, "B", "car"), null); assert.equal(queries, 0);
  let result = await diagnosticStatusReply(prisma, "A", "car");
  assert.equal(result.scanStatus, "not_running"); assert.equal(result.artifacts.length, 0);
  assert.match(result.reply, /earlier message.*incorrect/);
  found = { id: "saved", type: "live_diagnostic", title: "Report", createdAt: new Date("2026-11-18T12:00:00Z") };
  result = await diagnosticStatusReply(prisma, "A", "car");
  assert.equal(result.scanStatus, "not_running"); assert.equal(result.artifacts[0].id, "saved");
  assert.match(result.reply, /2026-11-18T12:00:00.000Z/);
});

test("ordinary LLM chat cannot deliver a fictional scan receipt or notification promise", () => {
  for (const reply of ["The scan is still running.", "I've started a diagnostic scan.", "I sent the scan to your tablet.", "I'm running diagnostics.", "The diagnostic scan is complete.", "I'll notify you when it finishes.", "I will let you know when done."]) {
    assert.match(guardDiagnosticClaims(reply), /can't verify an active background scan/, reply);
  }
  assert.equal(guardDiagnosticClaims("The coolant reading is stale."), "The coolant reading is stale.");
});
