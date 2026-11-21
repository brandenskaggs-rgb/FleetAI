const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { sanitizeTelemetryMeta } = require("../server/telematics/ingest/prepareTelemetryIngest");
const { buildTelemetrySample } = require("../server/ml");
const { scanSession } = require("../server/services/liveScanSession");

test("scan proof survives ingest but raw payload and background replay cannot manufacture live readings", async () => {
  const now = Date.now(), requestId = randomUUID(), deviceId = "tablet";
  const row = { orgId: "A", vehicleId: "car", requestId, groups: ["engine"], reason: "Live diagnostic scan",
    createdAt: new Date(now-10000), expiresAt: new Date(now+300000), deviceId, supportedKeys: ["rpm"] };
  const makeSample = (id, device, metrics, ages, at = now) => buildTelemetrySample({
    timestamp: new Date(at).toISOString(), vehicleId: "car", orgId: "A"
  }, { pairedScanDeviceId: device, meta: sanitizeTelemetryMeta({ sensorWatchRequestId: id, metricAgesMs: ages }),
    rawPids: { ...metrics, heartbeatMs: at+100, sensorWatchRequestId: requestId, watchDeviceId: deviceId,
      watchReadings: { rpm: { at, value: 9000 } } } });
  const packet = makeSample(requestId, deviceId, { rpm: 0, coolantTempC: 85, batteryVoltageV: 14, absActive: 1 },
    { rpm: 300, coolantTempC: 11000, batteryVoltageV: 200 });
  const samples = [makeSample(randomUUID(), deviceId, { rpm: 4500 }, { rpm: 0 }),
    makeSample(requestId,"other", { rpm: 4500 }, { rpm: 0 }), makeSample(requestId,deviceId,{},{} )];
  assert.equal(makeSample("invalid",deviceId,{rpm:700},{rpm:0}).raw.watchReadings,undefined);
  assert.equal(makeSample(requestId,null,{rpm:700},{rpm:0}).raw.watchReadings,undefined);
  const prisma = { sensorWatch: { findUnique: async ({ where }) => where.orgId_vehicleId.orgId === "A" ? row : null },
    telemetrySample: { findMany: async ({where,take}) => {
      assert.equal(take,64);assert.equal(where.orgId,"A");assert.equal(where.vehicleId,"car");
      assert.deepEqual(where.raw,{path:["sensorWatchRequestId"],equals:requestId});
      assert.equal(+where.ts.gte,+row.createdAt);return samples;
    } } };
  const status = t => scanSession(prisma,"A","car",t ?? now);
  assert.equal((await scanSession(prisma,"B","car",now)).status,"idle");
  assert.equal((await status()).status,"awaiting_tablet");
  row.acknowledgedAt=new Date(now-5000);
  assert.equal((await status()).status,"waiting_for_readings");
  samples.push(packet);
  const live=await status();
  assert.equal(live.status,"receiving");
  assert.deepEqual(live.readings.map(r=>[r.key,r.value,r.at]),[["rpm",0,now-200],["batteryVoltageV",14,now-100]]);
  assert.equal((await status(now+20000)).status,"interrupted");
  assert.equal((await status(now+310000)).status,"expired");
  row.stoppedAt=new Date(now-1000);
  assert.equal((await status()).status,"stopped");
  assert.deepEqual((await status()).readings,[]);
});
