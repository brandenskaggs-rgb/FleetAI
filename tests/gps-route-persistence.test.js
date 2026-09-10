const assert = require("node:assert/strict");
const db = require("../server/db");
const { buildTelemetrySample } = require("../server/ml");
const { registerSolutionRoutes, gpsPositionFromSnapshot } = require("../server/routes/solutionRoutes");
const now = Date.now();
const location = { latitude: 37.2, longitude: -89.5, locationCapturedAt: now, locationSpeedMps: 10 };
const sample = buildTelemetrySample({ vehicleId: "V_A", orgId: "A", timestamp: new Date(now).toISOString(), engine: { rpm: 900 } }, { meta: location });
assert.deepEqual(sample.raw.location, location);
assert.equal(gpsPositionFromSnapshot(sample, now).lat, 37.2);
assert.equal(gpsPositionFromSnapshot({ latitude: null, longitude: 40, locationCapturedAt: now }, now), null);
assert.equal(gpsPositionFromSnapshot({ ...location, locationCapturedAt: now + 60000 }, now), null);

const routes = new Map();
const app = {};
for (const method of ["get", "post", "delete", "patch"]) app[method] = (url, ...handlers) => routes.set(`${method} ${url}`, handlers.at(-1));
let reads = [];
db.listVehicles = async ({ orgId }) => [{ vehicleId: "V_A", orgId }];
db.listDrivers = async () => [];
db.getSamplesForVehicle = async (vehicleId) => { reads.push(vehicleId); return [sample]; };
const latest = new Map([["V_B", { vehicleId: "V_B", deviceDiagnostics: { ...location, latitude: 50 } }]]);
registerSolutionRoutes(app, {
  readData: async () => ({}), writeData: async () => {},
  sanitizeString: (v) => String(v || "").trim(), telemetryLatest: latest,
  requireEmployeeOrCustomerApi: (_req, _res, next) => next()
});
async function getPositions() {
  let body;
  await routes.get("get /api/gps/live")({ customer: { orgId: "A" }, query: {} }, { json: (result) => { body = result; } }, (err) => { throw err; });
  return body.data;
}
(async () => {
  let positions = await getPositions();
  assert.equal(positions.length, 1);
  assert.equal(positions[0].lat, 37.2, "position survives a restart without the JSON mirror");
  assert.deepEqual(reads, ["V_A"], "never query another tenant's vehicles");
  latest.set("V_A", { vehicleId: "V_A", deviceDiagnostics: { ...location, latitude: 38, locationCapturedAt: now + 1000 } });
  positions = await getPositions();
  assert.equal(positions[0].lat, 38, "fresh live position supersedes history");
  assert.equal(reads.length, 1, "fresh positions do not repeatedly query history");
  console.log("GPS persistence and tenant isolation tests passed");
})().catch((err) => { console.error(err); process.exitCode = 1; });
