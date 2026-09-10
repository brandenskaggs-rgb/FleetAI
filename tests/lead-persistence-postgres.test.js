// Opt-in integration test. Only synthetic rows in a uniquely named temporary schema.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { createLeadStore } = require('../server/storage/leadStore');
const { normalizeLeadStatus, normalizeOrgStatus } = require('../server/routes/adminRoutes');
const { registerOrgManagementRoutes } = require('../server/routes/orgManagementRoutes');
const { registerAdminRoutes } = require('../server/routes/adminRoutes');
const express = require('express');

async function main() {
  const connectionString = process.env.LEAD_TEST_DATABASE_URL;
  assert.ok(connectionString, 'Set LEAD_TEST_DATABASE_URL explicitly; this test does not load .env');
  const schema = `fleetai_lead_test_${crypto.randomBytes(10).toString('hex')}`;
  const admin = new Pool({ connectionString });
  let pool, prisma, server;
  async function connect() {
    pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema }) });
  }
  const makeStore = readLegacy => createLeadStore({ getPrisma: () => prisma, readLegacy, normalizeLeadStatus, normalizeOrgStatus });
  const request = { companyName: 'Persistence Test Fleet', contactName: 'Test Contact',
    contactEmail: 'test@example.invalid', contactPhone: '000', fleetSize: '50-100',
    message: 'Synthetic integration test only', leadType: 'PILOT', sourcePage: 'pilot' };
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    for (const table of ['Org', 'User', 'Lead', 'AuditLog']) {
      await admin.query(`CREATE TABLE "${schema}"."${table}" (LIKE public."${table}" INCLUDING ALL)`);
    }
    await connect();
    const migration = fs.readFileSync(path.join(__dirname, '../prisma/migrations/20260911000100_durable_lead_details/migration.sql'), 'utf8');
    await pool.query(migration);
    await pool.query(migration);
    await pool.query('ALTER TABLE "Lead" ADD FOREIGN KEY ("orgId") REFERENCES "Org"(id)');
    let store = makeStore(async () => ({ leads: [] }));
    const created = await store.create(request);
    assert.equal(created.fleetSize, '50-100');
    await store.update(created.id, { internalNotes: 'Follow up', status: 'CONTACTED', id: 'malicious', orgId: 'wrong' });

    await prisma.$disconnect();
    await pool.end();
    await connect();
    store = makeStore(async () => ({ leads: [] }));
    const restored = await store.get(created.id);
    assert.equal(restored.message, request.message);
    assert.equal(restored.leadType, 'PILOT');
    assert.equal(restored.internalNotes, 'Follow up');
    assert.equal(restored.orgId, null);
    assert.equal((await store.list()).length, 1);
    const legacy = makeStore(async () => ({ leads: [{ ...created, status: 'NEW', message: 'old' },
      { ...request, id: 'LEGACY_TEST', orgId: 'LOST_ORG' }] }));
    await legacy.list();
    assert.equal((await legacy.get(created.id)).status, 'CONTACTED');
    assert.equal((await legacy.get('LEGACY_TEST')).orgId, null);

    const second = await store.create(request);
    const results = await Promise.all([
      store.convert(created.id, 'PILOT'), store.convert(created.id, 'PILOT'), store.convert(second.id, 'PILOT')
    ]);
    assert.equal(new Set(results.map(item => item.org.id)).size, 1);
    assert.equal(await prisma.org.count(), 1);
    const canonical = await prisma.org.create({ data: { name: 'Canonical', status: 'PILOT', email: request.contactEmail } });
    await prisma.user.create({ data: { email: request.contactEmail, role: 'ORG_ADMIN', orgId: canonical.id } });
    assert.equal((await store.convert(created.id)).org.id, canonical.id);
    await prisma.org.update({ where: { id: canonical.id }, data: { status: 'DELETED' } });
    await assert.rejects(store.convert(created.id), error => error.status === 409);

    // Fail inside the transaction: neither the lead nor a new org may be committed.
    const failed = await store.create({ ...request, contactEmail: 'rollback@example.invalid' });
    const countBefore = await prisma.org.count();
    await pool.query('ALTER TABLE "AuditLog" ADD CONSTRAINT reject_conversion CHECK (event != \'LEAD_CONVERTED_TO_ORG\') NOT VALID');
    await assert.rejects(store.convert(failed.id));
    assert.equal((await store.get(failed.id)).orgId, null);
    assert.equal(await prisma.org.count(), countBefore);
    await pool.query('ALTER TABLE "AuditLog" DROP CONSTRAINT reject_conversion');

    // Exercise public and legacy HTTP contracts with cookie-independent test guards.
    const app = express();
    app.use(express.json());
    const employee = (req, res, next) => req.headers['x-test-role'] ? next() : res.sendStatus(401);
    const role = allowed => (req, res, next) => allowed.includes(req.headers['x-test-role']) ? next() : res.sendStatus(403);
    const deps = { leadStore: store, readData: async () => ({ users: [], orgs: [], leads: [], audit: [] }),
      writeData: async () => { throw new Error('Durable lead routes must not write JSON'); },
      requireEmployeeApi: employee, requireCustomerApi: employee, requireRole: role,
      requireSuperAdmin: role(['SUPER_ADMIN']), getRateState: () => ({ allowed: true }),
      prismaAuthAdapter: { loadData: async () => ({ users: [], orgs: await prisma.org.findMany() }) } };
    registerAdminRoutes(app, deps);
    registerOrgManagementRoutes(app, deps);
    app.use((err, req, res, next) => res.status(err.status || 500).json({ error: 'Request failed' }));
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    async function http(url, method = 'GET', body, access) {
      return fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(access ? { 'x-test-role': access } : {}) },
        body: body ? JSON.stringify(body) : undefined });
    }
    assert.equal((await http('/api/leads')).status, 401);
    assert.equal((await http('/api/admin/leads')).status, 403);
    const response = await http('/api/leads/request-demo', 'POST', { ...request, email: 'http@example.invalid' });
    assert.equal(response.status, 201);
    const lead = (await response.json()).data;
    assert.equal(lead.leadType, 'DEMO');
    const listing = await http('/api/admin/leads', 'GET', null, 'SUPER_ADMIN');
    assert.ok((await listing.json()).data.some(item => item.id === lead.id));
    assert.equal((await http(`/api/leads/${lead.id}/convert`, 'POST', {}, 'SUPPORT')).status, 403);
    const convert = await http(`/api/admin/leads/${lead.id}/convert-to-org`, 'POST', {}, 'SUPER_ADMIN');
    assert.equal(convert.status, 200);
    const convertedOrg = (await convert.json()).data.org.orgId;
    // Org recovery GET persists only its derived local index, not the authoritative lead.
    deps.writeData = async () => {};
    const overview = await http('/api/overview', 'GET', null, 'SUPER_ADMIN');
    assert.equal(overview.status, 200);
    assert.ok((await overview.json()).data.totalOrgs >= 1);
    assert.ok(await prisma.org.findUnique({ where: { id: convertedOrg } }));
    await pool.query('ALTER TABLE "Lead" RENAME TO "LeadOffline"');
    assert.equal((await http('/api/leads/request-demo', 'POST', { ...request, email: 'offline@example.invalid' })).status, 500);
    assert.equal((await http('/api/leads', 'GET', null, 'SUPER_ADMIN')).status, 500);
    console.log('PASS: PostgreSQL persistence after reconnect, migration, import, race/idempotence, canonical ownership, rollback, authorization and fail-closed HTTP paths');
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    if (prisma) await prisma.$disconnect();
    if (pool) await pool.end();
    assert.match(schema, /^fleetai_lead_test_[a-f0-9]{20}$/);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
}

main().catch(error => { console.error(error.message.replace(/postgres(?:ql)?:\/\/\S+/g, '[redacted]')); process.exitCode = 1; });
