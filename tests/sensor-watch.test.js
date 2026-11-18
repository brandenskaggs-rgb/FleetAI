const { test } = require("node:test");
const assert = require("node:assert/strict");
const { watchProposal, saveWatch, getWatch, acknowledgeWatch, describeWatch } = require("../server/services/sensorWatchService");
const { planAdvisorActions } = require("../server/services/advisorAgentService");
const { normalizeMetrics } = require("../server/telematics/normalize/normalizeMetrics");
const { buildSensorView } = require("../server/telematics/diagnostics/sensorCatalog");
const { buildTelemetrySample } = require("../server/ml");
const { decodeJ1939Frames } = require("../server/telematics/decoders/j1939PgnDecoder");
const { buildFleetAdvisorContext } = require("../server/services/advisorContextService");

function memoryStore() {
  const rows = new Map();
  const key = x => `${x.orgId}/${x.vehicleId}`;
  return { sensorWatch: {
    upsert: async ({ where, create, update }) => {
      const k = key(where.orgId_vehicleId); const row = { ...(rows.get(k) || create), ...update }; rows.set(k, row); return row;
    },
    findUnique: async ({ where }) => rows.get(key(where.orgId_vehicleId)) || null,
    updateMany: async ({ where, data }) => {
      const row = rows.get(key(where));
      if (!row || row.requestId !== where.requestId || row.stoppedAt || row.expiresAt <= where.expiresAt.gt) return { count: 0 };
      Object.assign(row, data); return { count: 1 };
    }
  } };
}

test("watch intent needs confirmation and a scoped vehicle; symptoms are not diagnoses", () => {
  assert.equal(watchProposal("watch the car", null), null);
  assert.equal(watchProposal("don't watch my car", "car"), null);
  const action = planAdvisorActions("Watch the Camaro, it is jerking", { assets: [{ vehicleId: "car", unitName: "Camaro" }] })[0];
  assert.equal(action.mode, "confirmation_required");
  assert.deepEqual(action.payload.groups, ["engine", "transmission", "brakes"]);
  assert.equal(watchProposal("stop monitoring the car", "car").action, "stop_sensor_watch");
});

test("watch storage and acknowledgments cannot cross tenant, vehicle, or request revision", async () => {
  const db = memoryStore(); const now = new Date();
  const a = await saveWatch(db, { orgId: "A", vehicleId: "car", groups: ["transmission"] }, now);
  assert.equal(a.status, "awaiting_tablet");
  assert.equal(await getWatch(db, "B", "car"), null);
  assert.equal((await acknowledgeWatch(db, { orgId: "B", vehicleId: "car" }, { requestId: a.requestId, supportedKeys: ["transmissionTempC"] })).count, 0);
  assert.equal((await acknowledgeWatch(db, { orgId: "A", vehicleId: "other" }, { requestId: a.requestId })).count, 0);
  await acknowledgeWatch(db, { orgId: "A", vehicleId: "car" }, { requestId: a.requestId, supportedKeys: ["transmissionTempC", "04", "transmissionTempC"] });
  const applied = await getWatch(db, "A", "car");
  assert.equal(applied.status, "tablet_applied");
  assert.deepEqual(applied.supportedKeys, ["transmissionTempC"]);
  assert.ok(applied.unavailableKeys.includes("torqueConverterSlipRpm"));
  const replacement = await saveWatch(db, { orgId: "A", vehicleId: "car", groups: ["brakes"] });
  assert.notEqual(a.requestId, replacement.requestId);
  assert.equal((await acknowledgeWatch(db, { orgId: "A", vehicleId: "car" }, { requestId: a.requestId })).count, 0);
  await assert.rejects(() => saveWatch(db, { orgId: "", vehicleId: "car", groups: ["engine"] }));
  await assert.rejects(() => saveWatch(db, { orgId: "A", vehicleId: "car", groups: ["write_ecu"] }));
  await assert.rejects(() => saveWatch(db, { orgId: "A", vehicleId: "car", groups: ["engine"], durationMinutes: 500 }));
  const row = await db.sensorWatch.findUnique({ where: { orgId_vehicleId: { orgId: "A", vehicleId: "car" } } });
  assert.equal(describeWatch(row, new Date(row.expiresAt).getTime() + 1).status, "expired");
});

test("transmission readings reach inventory and ML sample without inventing missing values", () => {
  const normalized = normalizeMetrics({ metrics: { transmissionTempF: 212, wheelSpeedFlKph: 40 }, vehicleId: "car" });
  assert.equal(normalized.transmission.transmissionTempC, 100);
  assert.equal(normalized.transmission.torqueConverterSlipRpm, null);
  const view = buildSensorView(normalized, { supportedPids: ["010C"] });
  assert.equal(view.readings.find(s => s.key === "transmissionTempC").supported, true);
  assert.equal(view.readings.find(s => s.key === "transmissionTempC").state, "unknown");
  assert.equal(view.readings.find(s => s.key === "transmissionGear").state, "unsupported");
  const sample = buildTelemetrySample(normalized);
  assert.equal(sample.metrics.transmissionTempC, 100);
  assert.equal(sample.metrics.wheelSpeedFlKph, 40);
  assert.equal(sample.metrics.wheelSpeedFrKph, null);
  assert.equal(buildTelemetrySample(normalized, { meta: { metricAgesMs: { wheelSpeedFlKph: 31_000 } } }).metrics.wheelSpeedFlKph, null);
  assert.equal(buildTelemetrySample(normalized, { meta: { metricAgesMs: { transmissionTempF: 31_000 } } }).metrics.transmissionTempC, null);
  assert.equal(buildTelemetrySample(normalizeMetrics({ metrics: { rpm: 800 } })).metrics.transmissionTempC, null);
});

test("Advisor watch evidence is tenant scoped and retains sparse/stale sample times", async () => {
  const now = new Date("2026-11-18T12:00:00Z");
  const samples = [
    { vehicleId: "carA", ts: now, metrics: { rpm: 850, transmissionTempC: null } },
    { vehicleId: "carB", ts: now, metrics: { transmissionTempC: 200 } },
    { vehicleId: "carA", ts: new Date(now - 60_000), metrics: { rpm: 800, transmissionTempC: 70 } }
  ];
  const prisma = new Proxy({}, { get: (_target, model) => ({
    findUnique: async () => ({ id: "A", name: "Test Fleet" }),
    findMany: async ({ where }) => {
      assert.equal(where.orgId, "A");
      if (model === "vehicle") return [{ vehicleId: "carA", orgId: "A", unitName: "Test car" }];
      if (model === "telemetrySample") {
        assert.equal(where.vehicle.orgId, "A");
        return samples;
      }
      if (model === "sensorWatch") {
        assert.equal(where.vehicleId, "carA");
        return [{ vehicleId: "carA", requestId: "requestA", groups: ["transmission"], expiresAt: new Date(now.getTime() + 60_000), supportedKeys: [], acknowledgedAt: null }];
      }
      return [];
    }
  }) });
  const context = await buildFleetAdvisorContext({ db: { getPrisma: () => prisma }, orgId: "A", selectedVehicleId: "carA", query: "watch transmission", now });
  assert.equal(context.sensorWatches[0].status, "awaiting_tablet");
  assert.ok(context.focusedSensorEvidence.every(row => row.vehicleId === "carA"));
  const temperature = context.focusedSensorEvidence.find(row => row.signal === "transmissionTempC");
  assert.equal(temperature.value, 70);
  assert.equal(temperature.stale, true);
  assert.equal(temperature.recordedAt, "2026-11-18T11:59:00.000Z");
  assert.equal(context.focusedSensorEvidence.find(row => row.signal === "rpm").value, 850);
});

test("SPN 127 must never be decoded as transmission temperature", () => {
  const map = require("../server/telematics/decoders/j1939_spn_map.json");
  assert.equal(map[127], undefined);
  assert.equal(map[177].scale * 11936 + map[177].offset, 100);
  assert.equal(decodeJ1939Frames([{ spn: 177, value: 11936 }]).metrics.transmissionTempC, 100);
  assert.equal(decodeJ1939Frames([{ spn: 177, value: 65535 }]).metrics.transmissionTempC, undefined);
  assert.equal(decodeJ1939Frames([{ spn: 127, value: 100 }]).metrics.transmissionTempC, undefined);
});
