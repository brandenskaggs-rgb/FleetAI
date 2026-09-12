"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createEldService } = require("../server/eld/eldService");
const { getCycleWindowStart } = require("../server/eld/hosCalculator");

const device = { orgId: "org-a", driverId: "driver-a", deviceId: "device-a" };
const range = { from: "2026-09-01T00:00:00Z", to: "2026-09-09T00:00:00Z" };
function fixture(rows = []) {
  const calls = [];
  const service = createEldService({ eldEvent: { findMany: async (query) => {
    calls.push(query);
    return rows.filter((row) => row.orgId === query.where.orgId
      && row.driverId === query.where.driverId
      && new Date(row.occurredAt) >= query.where.occurredAt.gte
      && new Date(row.occurredAt) <= query.where.occurredAt.lte).slice(0, query.take);
  } } });
  return { service, calls };
}
const row = { id: "a", ...device, occurredAt: "2026-09-05T12:00:00Z" };

test("device records enforce both organization and driver scope", async () => {
  const { service, calls } = fixture([
    row,
    { ...row, id: "other-org", orgId: "org-b" },
    { ...row, id: "other-driver", driverId: "driver-b" }
  ]);
  assert.deepEqual(await service.listRecords(device, range), [row]);
  assert.equal(calls[0].where.orgId, device.orgId);
  assert.equal(calls[0].where.driverId, device.driverId);
});

test("missing scope and caller-selected drivers fail before database access", async () => {
  const { service, calls } = fixture();
  for (const invalid of [null, {}, { ...device, orgId: "" }, { ...device, driverId: null }]) {
    await assert.rejects(service.listRecords(invalid, range), { code: "ELD_DRIVER_SCOPE_REQUIRED", statusCode: 403 });
  }
  for (const driverId of ["driver-b", "", null, { not: "driver-a" }, ["driver-a"]]) {
    await assert.rejects(service.listRecords(device, { ...range, driverId }),
      { code: "ELD_DRIVER_SCOPE_MISMATCH", statusCode: 403 });
  }
  assert.equal(calls.length, 0);
});

test("explicit own-driver filtering remains compatible", async () => {
  const { service } = fixture([row]);
  assert.deepEqual(await service.listRecords(device, { ...range, driverId: device.driverId }), [row]);
});

test("invalid ranges and limits fail with client errors before database access", async () => {
  const { service, calls } = fixture();
  for (const from of ["garbage", "", null, true, [], {}, new Date(NaN), Infinity]) {
    await assert.rejects(service.listRecords(device, { ...range, from }), { code: "ELD_RECORD_RANGE_INVALID", statusCode: 400 });
  }
  await assert.rejects(service.listRecords(device, { from: range.to, to: range.from }),
    { code: "ELD_RECORD_RANGE_INVALID" });
  for (const limit of [0, -1, 1.5, "no", Infinity, true, [], {}, null]) {
    await assert.rejects(service.listRecords(device, { ...range, limit }), { code: "ELD_RECORD_LIMIT_INVALID", statusCode: 400 });
  }
  assert.equal(calls.length, 0);
});

test("epoch zero is not replaced with today's timestamp", async () => {
  const { service, calls } = fixture();
  await service.listRecords(device, { from: 0, to: 1 });
  assert.equal(calls[0].where.occurredAt.gte.getTime(), 0);
});

test("ordinary lists stay bounded with stable ordering", async () => {
  const { service, calls } = fixture();
  await service.listRecords(device, { ...range, limit: "999999" });
  assert.equal(calls[0].take, 5000);
  assert.deepEqual(calls[0].orderBy.at(-1), { id: "desc" });
});

test("complete export detects overflow rather than signing a partial history", async () => {
  const { service, calls } = fixture(Array.from({ length: 5001 }, (_, i) => ({ ...row, id: String(i) })));
  await assert.rejects(service.listRecords(device, range, { requireComplete: true }),
    { code: "ELD_OUTPUT_RECORD_LIMIT_EXCEEDED", statusCode: 422 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].take, 5001);
});

test("complete export accepts exactly 5000 without applying the ordinary 1000 cap", async () => {
  const { service } = fixture(Array.from({ length: 5000 }, (_, i) => ({ ...row, id: String(i) })));
  assert.equal((await service.listRecords(device, range, { requireComplete: true })).length, 5000);
});

test("query parameters cannot opt out of complete-export checking", async () => {
  const { service } = fixture(Array.from({ length: 5001 }, () => row));
  await assert.rejects(service.listRecords(device, { ...range, requireComplete: false, limit: 1 },
    { requireComplete: true }), { code: "ELD_OUTPUT_RECORD_LIMIT_EXCEEDED" });
});

test("eight-day roadside window uses terminal calendar days across DST", () => {
  assert.equal(getCycleWindowStart(new Date("2026-03-09T18:00:00Z"), 8,
    "America/Chicago", 0).toISOString(), "2026-03-02T06:00:00.000Z");
  assert.equal(getCycleWindowStart(new Date("2026-11-02T18:00:00Z"), 8,
    "America/Chicago", 0).toISOString(), "2026-10-26T05:00:00.000Z");
  assert.equal(getCycleWindowStart(new Date("2026-09-11T07:00:00Z"), 8,
    "America/Chicago", 240).toISOString(), "2026-09-03T09:00:00.000Z");
});
