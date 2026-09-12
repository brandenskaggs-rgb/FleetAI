const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { buildTelemetrySample } = require('../server/ml');
const { prepareTelemetryIngest, sanitizeTelemetryMeta } = require('../server/telematics/ingest/prepareTelemetryIngest');

const capture = '2026-09-11T12:00:00.000Z';
function sample(codes, status = 'read') {
  const prepared = prepareTelemetryIngest({ protocol: 'OBD2', metrics: { rpm: 700 }, dtc: { active: codes },
    meta: { dtcScanStatus: status, dtcCapturedAt: capture } }, {
    timestamp: '2026-09-11T12:00:02.000Z', nowEpochMs: Date.parse('2026-09-11T12:00:03.000Z'), orgId: 'org-a', vehicleId: 'car-a' });
  return buildTelemetrySample(prepared.normalized, { meta: prepared.decoded.meta });
}
function database() {
  const scans = new Map(), rows = [];
  let failScan = false;
  const prisma = {
    vehicle: { upsert: async () => {} },
    telemetrySample: { upsert: async query => rows.push(query) },
    diagnosticScan: { createMany: async query => {
      if (failScan) throw new Error('scan persistence unavailable');
      assert.equal(query.skipDuplicates, true);
      for (const scan of query.data) if (!scans.has(scan.id)) scans.set(scan.id, scan);
    } }
  };
  const filename = path.resolve(__dirname, '../server/db.js');
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, __dirname: path.dirname(filename), process: { env: {} },
    require: id => {
      if (id === '@prisma/client') return { PrismaClient: function () { return prisma; } };
      if (id === 'pg') return { Pool: function () {} };
      if (id === '@prisma/adapter-pg') return { PrismaPg: function () {} };
      return createRequire(filename)(id);
    }, Buffer, console
  }, { filename });
  return { db: module.exports, scans, rows, setFailure: value => { failScan = value; } };
}

test('OBD codes and actual scan time survive normalization for ML and persistence', () => {
  const result = sample(['P0133', 'P0133', 'p0420']);
  assert.deepEqual(result.raw.activeDTCs, ['P0133', 'P0420']);
  assert.equal(result.raw.dtcCapturedAt, capture);
  assert.equal(result.raw.dtcScanStatus, 'read');
  assert.equal(Object.hasOwn(sample([], 'not_read').raw, 'activeDTCs'), false);
  assert.deepEqual(sample([]).raw.activeDTCs, [], 'a confirmed clean scan remains distinguishable');
  assert.equal(Object.hasOwn(sample(['bad-code']).raw, 'activeDTCs'), false, 'invalid codes cannot become a clean scan');
  assert.equal(sample(['P0133'], 'stale').raw.dtcCapturedAt, capture, 'cached codes must not gain a newer observation time');
  assert.deepEqual(sanitizeTelemetryMeta({ dtcScanStatus: 'invented', dtcCapturedAt: capture }), {});
  assert.deepEqual(sanitizeTelemetryMeta({ dtcScanStatus: 'read', dtcCapturedAt: 'invalid' }), { dtcScanStatus: 'read' });
});

test('telemetry outbox replay persists one decoded scan in the dashboard history store', async () => {
  const { db, scans, rows } = database();
  const result = sample(['P0133']);
  await db.insertTelemetrySample(result);
  await db.insertTelemetrySample({ ...result, ts: '2026-09-11T12:00:04.000Z' });
  assert.equal(rows.length, 2);
  assert.equal(scans.size, 1);
  const scan = [...scans.values()][0];
  assert.equal(scan.orgId, 'org-a');
  assert.equal(scan.vehicleId, 'car-a');
  assert.equal(scan.codes[0].code, 'P0133');
  assert.equal(scan.scannedAt.toISOString(), capture);
  assert.equal(scan.codeCount, 1);
  await db.insertTelemetrySample({ ...result, orgId: 'org-b', vehicleId: 'car-b' });
  assert.equal(scans.size, 2, 'different tenants cannot share a scan identity');
});

test('failed diagnostic persistence rejects ingest so the existing outbox can retry', async () => {
  const fixture = database();
  fixture.setFailure(true);
  await assert.rejects(fixture.db.insertTelemetrySample(sample(['P0133'])), /scan persistence unavailable/);
  fixture.setFailure(false);
  await fixture.db.insertTelemetrySample(sample(['P0133']));
  assert.equal(fixture.scans.size, 1);
});

test('old uploads without a confirmed scan do not manufacture clean diagnostic records', async () => {
  const { db, scans } = database();
  await db.insertTelemetrySample(sample([], 'not_read'));
  assert.equal(scans.size, 0);
  await db.insertTelemetrySample(sample([]));
  assert.equal(scans.size, 1);
  assert.equal([...scans.values()][0].codeCount, 0);
});
