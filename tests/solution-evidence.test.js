const assert = require("node:assert/strict");
const db = require("../server/db");
const { registerSolutionRoutes } = require("../server/routes/solutionRoutes");
const handlers = new Map(), app = {};
for (const method of ["get", "post", "delete", "patch"]) app[method] = (url, ...chain) => handlers.set(`${method} ${url}`, chain.at(-1));
const data = { recommendations: [], dvirRecords: [
  { id: "today", orgId: "A", submittedAt: "2026-09-08T18:30:00Z", defectStatus: "satisfactory" },
  { id: "other-company", orgId: "B", submittedAt: "2026-09-08T18:30:00Z", defectStatus: "satisfactory" }
] };
let scores = [], writes = 0;
db.listVehicles = async () => [{ vehicleId: "V_A", orgId: "A" }];
db.listDrivers = async () => [];
db.getAllModelStates = async () => scores;
let recordQuery;
db.getPrisma = () => ({ workOrder: { findMany: async (query) => {
  recordQuery = query;
  return [{ id: "existing-work", vehicleId: "V_A", orgId: "A", title: "Existing advisor work", vehicle: { orgId: "B", unitName: "Private name" } }];
} } });
registerSolutionRoutes(app, {
  readData: async () => data, writeData: async () => { writes++; },
  sanitizeString: (v) => String(v || "").trim(),
  parseNumberField: (v, fallback = null) => v === null || v === undefined || v === "" ? fallback : Number(v),
  nowIso: () => "2026-09-08T18:00:00Z", makeId: () => "REC_TEST", addAudit() {},
  requireEmployeeOrCustomerApi: (_req, _res, next) => next()
});
async function call(method, url, query = {}) {
  const res = { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; } };
  await handlers.get(`${method} ${url}`)({ customer: { orgId: "A" }, query }, res, (err) => { throw err; });
  return res;
}
(async () => {
  let result = await call("post", "/api/predictive/run");
  assert.equal(result.body.assessed, 0);
  assert.match(result.body.message, /not been assessed/);
  scores = [{ vehicleId: "V_A", orgId: "B", healthScore: 0 }];
  result = await call("post", "/api/predictive/run");
  assert.equal(result.body.created, 0, "other tenant's prediction must be ignored");
  scores = [{ vehicleId: "V_A", orgId: "A", healthScore: 0 }];
  result = await call("post", "/api/predictive/run");
  assert.equal(result.body.created, 1, "zero health must not default to 100");
  assert.equal(data.recommendations[0].autoScheduled, false);
  result = await call("post", "/api/predictive/run");
  assert.equal(result.body.created, 0);
  assert.equal(writes, 1);
  assert.match(result.body.message, /already have open/);
  result = await call("get", "/api/reports/compliance", { from: "2026-09-08", to: "2026-09-08", type: "dvir" });
  assert.equal(result.body.data.dvirRecords.length, 1);
  assert.equal(result.body.data.dvirRecords[0].id, "today", "date-only end includes the day's afternoon records");
  assert.equal((await call("get", "/api/reports/compliance", { from: "invalid" })).statusCode, 400);
  assert.equal((await call("get", "/api/reports/compliance", { from: "2026-09-10", to: "2026-09-08" })).statusCode, 400);
  result = await call("get", "/api/work-orders");
  assert.deepEqual(recordQuery.where, { orgId: "A" });
  assert.equal(recordQuery.take, 500);
  assert.equal(result.body.data[0].title, "Existing advisor work");
  assert.equal(result.body.data[0].vehicleName, "V_A", "moved vehicle's new company details stay private");
  console.log("Recommendation evidence and inclusive report date tests passed");
})().catch((err) => { console.error(err); process.exitCode = 1; });
