const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const db = require("../server/db");
const { buildReportArtifact, reportSections, planAdvisorActions } = require("../server/services/advisorAgentService");
const { sealReportPdf, getReportPdf, TEMPLATE_VERSION } = require("../server/services/advisorReportPdf");
const { registerSolutionRoutes } = require("../server/routes/solutionRoutes");

const context = {
  organization: { id: "A", name: "Example Fleet - Test Evidence Only" }, generatedAt: "2026-11-19T01:00:00Z", lookbackDays: 30,
  assets: [{ vehicleId: "unitA", unitName: "Test vehicle", make: "Example", model: "Test unit", year: 2020 }, { vehicleId: "unitB", unitName: "Other vehicle" }],
  vehicleHealth: [{ vehicleId: "unitA", healthScore: 78, confidenceStage: "calibrating", updatedAt: "2026-11-19T00:30:00Z" }],
  predictions: [{ vehicleId: "unitA", source: "synthetic_prior", modelVersion: "TEST-ONLY", confidence: 0.4, createdAt: "2026-11-19T00:30:00Z" }],
  alerts: [{ vehicleId: "unitA", type: "Inspection follow-up", severity: "warning", explanation: "Illustrative data only. Confirm the warning light and inspect before drawing conclusions.", createdAt: "2026-11-19T00:30:00Z" }],
  maintenance: [], workOrders: [], driveLogs: [], fuel: [], inspections: {}, compliance: {}, recordCounts: { vehicles: 2, telemetrySamples: 0 }
};

test("PDF uses a fixed template and saved bytes; missing values and long cells remain bounded", async () => {
  const data = buildReportArtifact({ action: { reportType: "fleet", title: "Test vehicle evidence report", vehicleId: "unitA" },
    context, reply: "TEST FIXTURE ONLY. No real customer data. This report demonstrates the fixed Fleet AI template.", request: "Generate a vehicle PDF" });
  data.content.sources.readings = Array.from({ length: 95 }, (_, i) => ({ label: `Test sensor ${i} with a long wrapped label`, value: i % 2 ? null : i, unit: "test units", state: i % 2 ? "unreported" : "historical", recordedAt: context.generatedAt }));
  const sealed = await sealReportPdf(data);
  const buffer = await getReportPdf(sealed);
  assert.equal(buffer.subarray(0, 5).toString(), "%PDF-");
  assert.equal(sealed.content.pdf.templateVersion, TEMPLATE_VERSION);
  assert.ok(buffer.length < 4 * 1024 * 1024);
  assert.deepEqual(await getReportPdf({ ...sealed, title: "Changed after sealing" }), buffer);
  await assert.rejects(getReportPdf({ content: { pdf: { ...sealed.content.pdf, sha256: "bad" } } }), /integrity/);
  const dir = path.join(__dirname, "../artifacts/reports"); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "advisor-template-test.pdf"), buffer);
});

test("each report type scopes records and never merges unknown vehicles into a selected vehicle", () => {
  const c = { ...context, alerts: [{ vehicleId: "unitA" }, { vehicleId: "unitB" }, {}], maintenance: [{ vehicleId: "unitB" }],
    compliance: { dutyEvents: [{ vehicleId: "unitB" }], recentCertifications: [{ driverId: "unrelated" }] } };
  for (const type of ["fleet", "risk", "maintenance", "cost", "drive", "compliance"]) {
    const sections = reportSections(type, c, "unitA");
    assert.equal(JSON.stringify(sections).includes('"unitB"'), false);
    assert.equal(JSON.stringify(sections).includes('"unrelated"'), false);
  }
  assert.equal(planAdvisorActions("Generate a PDF for all vehicles", { ...c, selectedVehicleId: "unitA" })[0].vehicleId, null);
  assert.equal(planAdvisorActions("Do not generate a report", c).length, 0);
});

test("report action works without an LLM and downloads are authenticated, scoped, immutable PDFs", async t => {
  const saved = [];
  const scopedEmpty = { findMany: async ({ where }) => { assert.equal(where.orgId, "A"); return []; } };
  const vehicles = context.assets.map(v => ({ ...v, orgId: "A" }));
  const prisma = {
    org: { findUnique: async ({ where }) => { assert.equal(where.id, "A"); return context.organization; } },
    vehicle: { findMany: async ({ where }) => { assert.equal(where.orgId, "A"); return vehicles; },
      findFirst: async ({ where }) => vehicles.find(v => v.orgId === where.orgId && v.vehicleId === where.vehicleId) || null },
    advisorArtifact: {
      create: async ({ data }) => { const record = { ...data, id: "test-report", createdAt: new Date() }; saved.push(record); return record; },
      findMany: async () => [],
      findFirst: async ({ where }) => saved.find(row => row.orgId === where.orgId && row.id === where.id) || null
    }
  };
  for (const table of ["driver", "alert", "modelState", "telemetrySample", "maintenanceLog", "workOrder", "diagnosticScan", "fuelEvent", "aiReport", "mlPredictionRun", "eldEvent", "eldDiagnostic", "eldRecordCertification"]) prisma[table] = {
    findMany: async args => {
      if (!["driver", "eldRecordCertification"].includes(table)) assert.equal(args.where.vehicleId, "unitA", `${table} filters before applying its query limit`);
      return scopedEmpty.findMany(args);
    }
  };
  prisma.telemetrySample.count = async ({where}) => {
    assert.deepEqual(where,{orgId:"A",vehicleId:"unitA",vehicle:{orgId:"A"}}); return 0;
  };
  t.mock.method(db, "getPrisma", () => prisma);
  t.mock.method(db, "listVehicles", async () => vehicles);
  t.mock.method(db, "listDrivers", async () => []);
  const app = express(); app.use(express.json());
  registerSolutionRoutes(app, { readData: async () => ({}), sanitizeString: (s, n) => String(s || "").slice(0, n),
    requireEmployeeOrCustomerApi(req, res, next) {
      if (!req.headers["x-test-org"]) return res.sendStatus(401);
      req.customer = { orgId: req.headers["x-test-org"], userId: "test-user" }; next();
    }
  });
  app.use((error, req, res, next) => res.status(500).json({ error: error.message }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { "Content-Type": "application/json", "x-test-org": "A" };
  const response = await fetch(base + "/api/advisor/message", { method: "POST", headers,
    body: JSON.stringify({ message: "Generate a PDF for unitA", vehicleId: "unitA", orgId: "B" }) });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.source, "fleetai_report_template"); assert.equal(body.artifacts.length, 1);
  assert.equal(saved[0].orgId, "A"); assert.equal(saved[0].content.scope.vehicleId, "unitA");
  const url = base + body.artifacts[0].downloadUrl;
  const pdf = await fetch(url + "?inline=1", { headers });
  assert.equal(pdf.status, 200); assert.equal(pdf.headers.get("content-type"), "application/pdf");
  assert.match(pdf.headers.get("content-disposition"), /^inline;/); assert.match(pdf.headers.get("cache-control"), /no-store/);
  assert.deepEqual(Buffer.from(await pdf.arrayBuffer()), await getReportPdf(saved[0]));
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers: { "x-test-org": "B" } })).status, 404);
  const foreign = await fetch(base + "/api/advisor/message", { method: "POST", headers, body: JSON.stringify({ message: "Generate a report", vehicleId: "foreign" }) });
  assert.equal(foreign.status, 404);
  t.mock.method(prisma.advisorArtifact, "create", async () => { throw new Error("storage_failure"); });
  const failed = await fetch(base + "/api/advisor/message", { method: "POST", headers, body: JSON.stringify({ message: "Generate a report", vehicleId: "unitA" }) });
  assert.equal(failed.status, 500); assert.equal((await failed.json()).artifacts, undefined);
});
