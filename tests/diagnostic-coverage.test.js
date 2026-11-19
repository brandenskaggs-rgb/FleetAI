const { test } = require("node:test");
const assert = require("node:assert/strict");
const db = require("../server/db");
const { registerDiagnosticsRoutes } = require("../server/routes/diagnosticsRoutes");
const { driverGuidance } = require("../server/telematics/diagnostics/dtcCatalog");

test("missing scan payload is rejected and history exposes scoped completeness", async t => {
  const routes = new Map();
  const app = Object.fromEntries(["get", "post"].map(method => [method, (url, ...handlers) => routes.set(`${method} ${url}`, handlers.at(-1))]));
  registerDiagnosticsRoutes(app, { requireEmployeeOrCustomerApi() {}, sanitizeString: s => String(s || ""), telemetryLatest: new Map(), nowIso: () => new Date().toISOString() });
  t.mock.method(db, "getVehicleOrgId", async () => "A");
  t.mock.method(db, "insertDiagnosticScan", async () => { throw new Error("missing input must not write a scan"); });
  t.mock.method(db, "listDiagnosticScans", async (vehicle, options) => { assert.equal(vehicle, "unitA"); assert.equal(options.orgId, "A"); return []; });
  const req = { body: { vehicleId: "unitA" }, query: {}, params: {}, customer: { orgId: "A" } };
  const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
  const missing = response();
  await routes.get("post /api/diagnostics/scan")(req, missing, e => { throw e; });
  assert.equal(missing.statusCode, 400); assert.equal(missing.body.error, "CODES_REQUIRED");
  const history = response();
  await routes.get("get /api/dtc-history")(req, history, e => { throw e; });
  assert.equal(history.body.diagnosticStatus.completeness, "not_read");
  assert.match(history.body.diagnosticStatus.message, /warning light/);
  const denied = response();
  await routes.get("get /api/dtc-history")({ ...req, customer: { orgId: "B" } }, denied, e => { throw e; });
  assert.equal(denied.statusCode, 403);
});

test("empty reads never reassure and partial reads do not suppress a stop warning", () => {
  assert.doesNotMatch(driverGuidance({ severity: "info", driveability: "ok" }).headline, /No action needed/);
  assert.match(driverGuidance({ driveability: "stop", obdFaultRead: { status: "partial" } }).headline, /Stop/);
  assert.match(driverGuidance({ driveability: "ok", obdFaultRead: { status: "inconsistent" } }).headline, /Incomplete/);
});
