const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const db = require("../server/db");
const { registerSolutionRoutes } = require("../server/routes/solutionRoutes");
const { registerDriverAppRoutes } = require("../server/routes/driverAppRoutes");

test("watch routes enforce session roles, paired vehicle scope, and revision checks", async (t) => {
  const rows = new Map();
  const key = w => `${w.orgId}/${w.vehicleId}`;
  const prisma = {
    vehicle: { findFirst: async ({ where }) => where.orgId === "A" && where.vehicleId === "carA" ? { vehicleId: "carA", unitName: "Test car" } : null },
    sensorWatch: {
      upsert: async ({ where, create, update }) => {
        const k = key(where.orgId_vehicleId);
        const row = { ...(rows.get(k) || create), ...update };
        rows.set(k, row); return row;
      },
      findUnique: async ({ where }) => rows.get(key(where.orgId_vehicleId)) || null,
      updateMany: async ({ where, data }) => {
        const row = rows.get(key(where));
        if (!row || (where.requestId && (row.requestId !== where.requestId || row.stoppedAt || row.expiresAt <= where.expiresAt.gt))) return { count: 0 };
        Object.assign(row, data); return { count: 1 };
      }
    }
  };
  t.mock.method(db, "getPrisma", () => prisma);
  t.mock.method(db, "listVehicles", async () => []);
  t.mock.method(db, "listDrivers", async () => []);
  t.mock.method(db, "findPairingByDeviceToken", async token => token === "test-device-A" ? { id: "pairA", orgId: "A", vehicleId: "carA", deviceId: "deviceA" } : null);
  const app = express();
  app.use(express.json());
  const deps = {
    sanitizeString: (value, length) => String(value || "").slice(0, length),
    readData: async () => ({}), nowIso: () => new Date().toISOString(),
    requireEmployeeOrCustomerApi(req, res, next) {
      // Fixture substitutes session lookup only; actual route authorization is exercised.
      if (!req.headers["x-test-role"]) return res.sendStatus(401);
      req.customer = { orgId: "A", userId: "adminA", role: req.headers["x-test-role"] }; next();
    }
  };
  registerDriverAppRoutes(app, deps);
  registerSolutionRoutes(app, deps);
  app.use((error, req, res, next) => res.status(500).json({ error: error.message }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function call(path, body, headers = {}) {
    const response = await fetch(origin + path, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
    const text = await response.text();
    return { status: response.status, data: text.startsWith("{") ? JSON.parse(text) : text };
  }
  const action = { action: "start_sensor_watch", confirmed: true, orgId: "B", payload: { vehicleId: "carA", groups: ["transmission"] } };
  const admin = { "x-test-role": "CUSTOMER_ADMIN" };
  const device = { Authorization: "Bearer test-device-A" };
  const execute = "/api/advisor/actions/execute";
  assert.equal((await call(execute, action)).status, 401);
  for (const role of ["CUSTOMER_VIEWER", "UNKNOWN", "SALES"]) assert.equal((await call(execute, action, { "x-test-role": role })).status, 403);
  assert.equal((await call(execute, { ...action, confirmed: false }, admin)).status, 400);
  assert.equal((await call(execute, { ...action, payload: { ...action.payload, vehicleId: "carB" } }, admin)).status, 404);
  assert.equal((await call(execute, { ...action, payload: { ...action.payload, durationMinutes: 1000 } }, admin)).status, 400);
  const started = await call(execute, action, admin);
  assert.equal(started.status, 200);
  assert.ok(rows.has("A/carA")); assert.equal(rows.has("B/carA"), false);
  assert.equal((await call("/api/driver/sensor-watch")).status, 401);
  const fetched = await call("/api/driver/sensor-watch?orgId=B&vehicleId=carB", null, device);
  assert.equal(fetched.data.watch.vehicleId, "carA");
  const ack = "/api/driver/sensor-watch/ack";
  assert.equal((await call(ack, { requestId: "wrong-revision" }, device)).status, 409);
  assert.equal((await call(ack, { requestId: started.data.data.requestId, orgId: "B", vehicleId: "carB", supportedKeys: ["transmissionTempC", "04"] }, device)).status, 200);
  assert.deepEqual(rows.get("A/carA").supportedKeys, ["transmissionTempC"]);
  assert.equal((await call(execute, { action: "stop_sensor_watch", confirmed: true, payload: { vehicleId: "carA" } }, admin)).status, 200);
  assert.equal((await call(ack, { requestId: started.data.data.requestId }, device)).status, 409);
  assert.equal((await call("/api/driver/sensor-watch", null, device)).data.watch.status, "stopped");
  assert.equal((await call("/api/driver/releases/latest?channel=unknown")).data.release, null);
  assert.equal((await call("/downloads/driver/unpublished.apk")).status, 404);
});
