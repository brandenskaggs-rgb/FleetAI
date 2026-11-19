const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");

function fixture() {
  const vehicles = [{ vehicleId: "a", orgId: "A", motiveId: "m-a", vin: "SAMEVIN" },
    { vehicleId: "b", orgId: "B", motiveId: null, vin: "SAMEVIN" }];
  const drivers = [{ driverId: "driver-a", orgId: "A", motiveId: "md-a" }];
  const table = rows => ({
    findFirst: async ({ where }) => rows.find(row => Object.entries(where).every(([k, v]) => row[k] === v)) || null,
    findUnique: async ({ where }) => rows.find(row => Object.entries(where).every(([k, v]) => row[k] === v)) || null,
    update: async ({ where, data }) => {
      const row = rows.find(row => Object.entries(where).every(([k, v]) => row[k] === v));
      assert.ok(row, "scoped record exists");
      if (data.motiveId && rows.some(r => r !== row && r.motiveId === data.motiveId)) throw new Error("unique_conflict");
      Object.assign(row, data); return row;
    },
    create: async ({ data }) => {
      if (data.motiveId && rows.some(r => r.motiveId === data.motiveId)) throw new Error("unique_conflict");
      rows.push(data); return data;
    }
  });
  const prisma = { vehicle: table(vehicles), driver: table(drivers) };
  const filename = path.resolve(__dirname, "../server/db.js"), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), { module, exports: module.exports,
    __dirname: path.dirname(filename), process: { env: {} }, Buffer, console,
    require: id => {
      if (id === "@prisma/client") return { PrismaClient: function () { return prisma; } };
      if (id === "pg") return { Pool: function () {} };
      if (id === "@prisma/adapter-pg") return { PrismaPg: function () {} };
      return createRequire(filename)(id);
    }
  }, { filename });
  return { db: module.exports, vehicles, drivers };
}

test("Motive VIN matching and metadata updates never cross organizations", async () => {
  const { db, vehicles } = fixture();
  await assert.rejects(db.findVehicleByMotiveIdOrVin("m-a", "SAMEVIN"), /scope_required/);
  assert.equal(await db.findVehicleByMotiveIdOrVin("m-a", null, "B"), null);
  const result = await db.upsertVehicleFromMotive({ motiveId: "m-b", vin: "samevin", orgId: "B", unitName: "Updated B" });
  assert.equal(result.vehicle.vehicleId, "b");
  assert.equal(vehicles[0].unitName, undefined);
  assert.equal(await db.updateVehicleMotiveMetadata("a", { foreign: true }, "B"), null);
  await db.updateVehicleMotiveMetadata("b", { connected: true }, "B");
  assert.equal(vehicles[1].motiveMetadata.connected, true);
});

test("foreign globally unique Motive IDs fail closed instead of reassigning vehicles or drivers", async () => {
  const { db, vehicles, drivers } = fixture();
  await assert.rejects(db.upsertVehicleFromMotive({ motiveId: "m-a", vin: "SAMEVIN", orgId: "B", unitName: "Wrong" }), /unique_conflict/);
  assert.equal(vehicles[0].orgId, "A"); assert.equal(vehicles[0].unitName, undefined);
  assert.equal(await db.findDriverByMotiveUserId("md-a", "B"), null);
  await assert.rejects(db.upsertDriverFromMotive({ motiveUserId: "md-a", orgId: "B", firstName: "Wrong" }), /unique_conflict/);
  assert.equal(await db.updateDriverMotiveMetadata("driver-a", { foreign: true }, "B"), null);
  assert.equal(drivers[0].firstName, undefined);
  await assert.rejects(db.upsertDriverFromMotive({ motiveUserId: "md-a" }), /scope_required/);
});

test("Motive data routes cannot map another organization's matching VIN to integration purchases", async t => {
  const express = require("express"), db = require("../server/db"), client = require("../server/services/motiveClient");
  const { registerMotiveDataRoutes } = require("../server/routes/motiveDataRoutes");
  t.mock.method(client, "isConfigured", () => true);
  t.mock.method(client, "getFuelPurchases", () => assert.fail("must not query foreign integration"));
  t.mock.method(client, "getIdleEvents", () => assert.fail("must not query foreign integration"));
  t.mock.method(db, "listVehicles", () => assert.fail("must not match a foreign VIN"));
  const app = express();
  registerMotiveDataRoutes(app, { requireEmployeeOrCustomerApi(req, res, next) { req.customer = { orgId: "UNRELATED_ORG" }; next(); }, sanitizeString: s => s });
  app.use((req, res) => res.json({ fallback: true }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  for (const route of ["fuel-events", "cost-analytics", "driver-scores"]) {
    const body = await (await fetch(`http://127.0.0.1:${server.address().port}/api/${route}`)).json();
    assert.ok(body.fallback || body.data.length === 0);
  }
});
