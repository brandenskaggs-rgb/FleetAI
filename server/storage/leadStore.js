const { makeId, sanitizeString, normalizeEmail } = require('../lib/utils');

function publicLead(row) {
  if (!row) return null;
  const extra = row.details || {};
  return {
    id: row.id, leadId: row.id, companyName: row.company || '',
    contactName: row.name || '', contactEmail: row.email || '',
    contactPhone: row.phone || '', status: row.status, stage: row.status,
    orgId: row.orgId, fleetSize: extra.fleetSize ?? String(row.vehicleCount ?? ''),
    message: extra.message ?? row.notes ?? '', internalNotes: extra.internalNotes || '',
    notes: extra.internalNotes ?? row.notes ?? '', demoDate: extra.demoDate || null,
    leadType: extra.leadType || 'DEMO', sourcePage: row.source || 'web',
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString()
  };
}

function createLeadStore({ getPrisma, readLegacy, normalizeLeadStatus, normalizeOrgStatus }) {
  let imported;
  function fields(raw) {
    const fleetSize = sanitizeString(String(raw.fleetSize ?? ''), 50);
    const vehicleCount = /^\d+$/.test(fleetSize) && Number(fleetSize) <= 2147483647 ? Number(fleetSize) : null;
    return {
      company: sanitizeString(raw.companyName, 200), name: sanitizeString(raw.contactName, 200),
      email: normalizeEmail(raw.contactEmail || raw.email), phone: sanitizeString(raw.contactPhone || raw.phone, 80),
      status: normalizeLeadStatus(raw.status || raw.stage), source: sanitizeString(raw.sourcePage || 'web', 120),
      notes: sanitizeString(raw.message, 1200), vehicleCount,
      details: { fleetSize, message: sanitizeString(raw.message, 1200),
        internalNotes: sanitizeString(raw.internalNotes ?? raw.notes, 2000),
        leadType: raw.leadType === 'PILOT' ? 'PILOT' : 'DEMO',
        demoDate: sanitizeString(raw.demoDate, 80) || null }
    };
  }

  async function ready() {
    // Import surviving local records once. Never overwrite a newer durable record.
    // A database error is fatal for this request, never a JSON fallback.
    if (!imported) imported = (async () => {
      const legacy = readLegacy ? await readLegacy() : {};
      const db = getPrisma();
      for (const lead of legacy.leads || []) {
        const id = lead.id || lead.leadId;
        if (!id) continue;
        const org = lead.orgId ? await db.org.findUnique({ where: { id: lead.orgId } }) : null;
        const payload = fields(lead);
        if (lead.orgId && !org) payload.details.legacyOrgId = lead.orgId;
        const createdAt = new Date(lead.createdAt);
        await db.lead.upsert({ where: { id }, update: {}, create: {
          ...payload, id, orgId: org?.id || null,
          ...(Number.isFinite(createdAt.getTime()) ? { createdAt } : {})
        } });
      }
    })().catch(error => { imported = null; throw error; });
    await imported;
    return getPrisma();
  }

  async function audit(tx, event, id, userId, orgId) {
    await tx.auditLog.create({ data: { event, detail: id, userId: userId || null, orgId: orgId || null } });
  }

  return {
    async list() {
      const db = await ready();
      return (await db.lead.findMany({ orderBy: { createdAt: 'desc' } })).map(publicLead);
    },
    async get(id) {
      return publicLead(await (await ready()).lead.findUnique({ where: { id } }));
    },
    async create(raw, userId) {
      const db = await ready();
      return db.$transaction(async tx => {
        const row = await tx.lead.create({ data: { ...fields(raw), id: makeId('LEAD') } });
        await audit(tx, 'LEAD_CREATED', row.id, userId);
        return publicLead(row);
      });
    },
    async update(id, raw, userId) {
      const db = await ready();
      return db.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM "Lead" WHERE id = ${id} FOR UPDATE`;
        const row = await tx.lead.findUnique({ where: { id } });
        if (!row) return null;
        const existing = publicLead(row);
        const updates = {};
        for (const key of ['companyName', 'contactName', 'contactEmail', 'contactPhone', 'fleetSize', 'message', 'internalNotes', 'notes', 'demoDate']) {
          if (raw[key] !== undefined) updates[key] = raw[key];
        }
        if (raw.notes !== undefined && raw.internalNotes === undefined) updates.internalNotes = raw.notes;
        if (raw.status !== undefined || raw.stage !== undefined) updates.status = normalizeLeadStatus(raw.status || raw.stage);
        const payload = fields({ ...existing, ...updates });
        payload.details = { ...(row.details || {}), ...payload.details };
        const saved = await tx.lead.update({ where: { id }, data: payload });
        await audit(tx, 'LEAD_UPDATED', id, userId, row.orgId);
        return publicLead(saved);
      });
    },
    async convert(id, requestedStatus, userId) {
      const db = await ready();
      return db.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM "Lead" WHERE id = ${id} FOR UPDATE`;
        const row = await tx.lead.findUnique({ where: { id } });
        if (!row) return null;
        const email = normalizeEmail(row.email);
        // Serialize different leads for the same contact as well as repeated clicks.
        await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${`lead-convert:${email || id}`}))`;
        const owner = email ? await tx.user.findFirst({ where: {
          email: { equals: email, mode: 'insensitive' }, orgId: { not: null },
          OR: [{ kind: 'customer' }, { role: { startsWith: 'CUSTOMER' } }, { role: 'ORG_ADMIN' }]
        }, select: { orgId: true } }) : null;
        let org = owner?.orgId ? await tx.org.findUnique({ where: { id: owner.orgId } }) : null;
        if (!org && row.orgId) org = await tx.org.findUnique({ where: { id: row.orgId } });
        if (!org && email) org = await tx.org.findFirst({ where: {
          email: { equals: email, mode: 'insensitive' }, status: { not: 'DELETED' }
        }, orderBy: { createdAt: 'asc' } });
        if (org?.status === 'DELETED') {
          const error = new Error('The linked organization is archived. Restore it before converting this request.');
          error.status = 409;
          throw error;
        }
        const reused = Boolean(org);
        if (!org) org = await tx.org.create({ data: {
          id: makeId('ORG'), name: row.company || 'New Organization',
          status: normalizeOrgStatus(requestedStatus || 'PILOT'), email: email || null, phone: row.phone
        } });
        const saved = await tx.lead.update({ where: { id }, data: { status: 'CONVERTED', orgId: org.id } });
        await audit(tx, reused ? 'LEAD_CONVERSION_REUSED_ORG' : 'LEAD_CONVERTED_TO_ORG', id, userId, org.id);
        const lead = publicLead(saved);
        return { lead, reused, org: {
          ...org, orgId: org.id, primaryContactName: lead.contactName,
          primaryContactEmail: org.email || lead.contactEmail,
          fleetSizeEstimate: row.vehicleCount || 0, activeVehicles: 0,
          billingPlan: 'PILOT_CORE', notes: lead.message
        } };
      });
    }
  };
}

module.exports = { createLeadStore, publicLead };
