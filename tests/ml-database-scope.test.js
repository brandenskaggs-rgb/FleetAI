const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

function fixture() {
  const calls = [];
  const prisma = {
    telemetrySample: { findMany: async (query) => { calls.push(query); return []; } },
    modelState: { findMany: async (query) => { calls.push(query); return []; } },
    vehicle: { findFirst: async (query) => { calls.push(query); return null; } },
    $executeRaw: async (strings, ...params) => { calls.push({ sql: strings.join("?"), params }); return 1; }
  };
  const module = { exports: {} };
  const filename = path.resolve(__dirname, "../server/db.js");
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
    module, exports: module.exports, __dirname: path.dirname(filename), process: { env: {} },
    require: (id) => {
      if (id === "@prisma/client") return { PrismaClient: function () { return prisma; } };
      if (id === "pg") return { Pool: function () {} };
      if (id === "@prisma/adapter-pg") return { PrismaPg: function () {} };
      return require(id);
    }, Buffer, console
  }, { filename });
  return { db: module.exports, calls };
}

test("Telemetry and model queries require organization filters", async () => {
  const { db, calls } = fixture();
  await assert.rejects(db.getSamplesForVehicle("fixture"), /Organization scope/);
  await db.getSamplesForVehicle("fixture", { orgId: "org-a" });
  assert.equal(calls[0].where.orgId, "org-a");
  await assert.rejects(db.getAllModelStates(), /Organization scope/);
  await db.getAllModelStates("org-a");
  assert.equal(calls[1].where.orgId, "org-a");
});

test("State save atomically merges JSON and enforces ownership", async () => {
  const { db, calls } = fixture();
  await assert.rejects(db.upsertModelState({ vehicleId: "fixture" }), /scope required/);
  await db.upsertModelState({ vehicleId: "fixture", orgId: "org-a", lineage: { version: 1 } });
  assert.match(calls[0].sql, /COALESCE\("ModelState"\."state"/);
  assert.match(calls[0].sql, /WHERE "ModelState"\."orgId"=EXCLUDED\."orgId"/);
  assert.match(calls[0].sql, /WHERE EXISTS/);
  assert.equal(calls[0].params.includes("org-a"), true);
});

test("Prediction lineage writes cannot create unowned vehicle stubs", async () => {
  const { db, calls } = fixture();
  await assert.rejects(db.insertMlPredictionRun({ vehicleId: "fixture" }), /scope required/);
  await assert.rejects(db.insertMlFeatureSnapshot({ vehicleId: "fixture" }), /scope required/);
  await assert.rejects(db.insertMlPredictionRun({ vehicleId: "fixture", orgId: "org-b" }), /ownership mismatch/);
  await assert.rejects(db.insertMlFeatureSnapshot({ vehicleId: "fixture", orgId: "org-b" }), /ownership mismatch/);
  assert.equal(calls.length, 2);
  assert.equal(calls.every((query) => query.where.orgId === "org-b"), true);
});

test("Node saves cannot overwrite Python-owned learning with a stale read", async () => {
  const { db, calls } = fixture();
  const input = { vehicleId: "fixture", orgId: "org-a", nodeScore: 0.2,
    welford: { rpm: { count: 1 } }, learningHistory: { cursor: "old" },
    isolation_forest: { old: true }, last_running_sample_ts: "old", updated_at: 1,
    stage3History: { old: true }, reviewCandidate: { old: true } };
  await db.upsertModelState(input);
  const saved = JSON.parse(calls[0].params[2]);
  assert.equal(saved.nodeScore, 0.2);
  for (const key of ["welford", "learningHistory", "isolation_forest", "last_running_sample_ts", "updated_at", "stage3History", "reviewCandidate"]) {
    assert.equal(Object.hasOwn(saved, key), false);
  }
  assert.equal(input.welford.rpm.count, 1);
});
