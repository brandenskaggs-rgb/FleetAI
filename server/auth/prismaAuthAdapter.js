// Prisma-backed auth data adapter.
// Replaces the JSON flat-file read/write pattern for the auth service.
// Provides loadData() / saveData() compatible with authService.createAuthService().
//
// The data shape returned mirrors the flat-file format so authService needs no changes:
// { users: [...], orgs: [...] }

const { getPrisma } = require("../db");

function toIso(d) {
  if (!d) return null;
  if (d instanceof Date) return d.toISOString();
  return d;
}

function mapUserFromPrisma(row) {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    kind: row.kind,
    orgId: row.orgId || null,
    passwordHash: row.passwordHash || "",
    passwordAlgo: row.passwordAlgo || "bcrypt",
    isActive: row.isActive,
    active: row.active,
    verified: row.verified,
    mustSetPassword: row.mustSetPassword,
    requirePasswordReset: row.requirePasswordReset,
    firstLogin: row.firstLogin,
    firstLoginRequired: row.firstLoginRequired,
    mustResetPassword: row.mustResetPassword,
    isTemporaryPassword: row.isTemporaryPassword,
    setupTokenHash: row.setupTokenHash || null,
    setupTokenExpiresAt: row.setupTokenExpiresAt ? Number(row.setupTokenExpiresAt) : null,
    passwordLastSetAt: toIso(row.passwordLastSetAt),
    lastPasswordChangeAt: toIso(row.lastPasswordChangeAt),
    displayName: row.displayName || "",
    lastLoginAt: toIso(row.lastLoginAt),
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt)
  };
}

function mapOrgFromPrisma(row) {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    email: row.email || null,
    phone: row.phone || null,
    address: row.address || null,
    industry: row.industry || null,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt)
  };
}

async function loadData() {
  const prisma = getPrisma();
  const [users, orgs] = await Promise.all([
    prisma.user.findMany(),
    prisma.org.findMany()
  ]);
  return {
    users: users.map(mapUserFromPrisma),
    orgs: orgs.map(mapOrgFromPrisma)
  };
}

async function saveData(data) {
  const prisma = getPrisma();
  const users = Array.isArray(data.users) ? data.users : [];
  const orgs = Array.isArray(data.orgs) ? data.orgs : [];

  // Upsert all orgs first (users may reference orgId)
  for (const org of orgs) {
    if (!org.id) continue;
    await prisma.org.upsert({
      where: { id: org.id },
      update: {
        name: org.name || "Fleet AI Org",
        status: org.status || "LEAD",
        email: org.email || null,
        phone: org.phone || null,
        address: org.address || null,
        industry: org.industry || null
      },
      create: {
        id: org.id,
        name: org.name || "Fleet AI Org",
        status: org.status || "LEAD",
        email: org.email || null,
        phone: org.phone || null,
        address: org.address || null,
        industry: org.industry || null
      }
    });
  }

  // Upsert all users
  for (const user of users) {
    if (!user.email) continue;

    // Ensure the orgId references an existing org; create a stub if needed
    if (user.orgId) {
      await prisma.org.upsert({
        where: { id: user.orgId },
        update: {},
        create: { id: user.orgId, name: user.orgId }
      });
    }

    await prisma.user.upsert({
      where: { email: user.email },
      update: {
        role: user.role || "customer",
        kind: user.kind || "customer",
        orgId: user.orgId || null,
        passwordHash: user.passwordHash || "",
        passwordAlgo: user.passwordAlgo || "bcrypt",
        isActive: user.isActive !== false,
        active: user.active !== false,
        verified: Boolean(user.verified),
        mustSetPassword: Boolean(user.mustSetPassword),
        requirePasswordReset: Boolean(user.requirePasswordReset),
        firstLogin: Boolean(user.firstLogin),
        firstLoginRequired: Boolean(user.firstLoginRequired),
        mustResetPassword: Boolean(user.mustResetPassword),
        isTemporaryPassword: Boolean(user.isTemporaryPassword),
        setupTokenHash: user.setupTokenHash || null,
        setupTokenExpiresAt: user.setupTokenExpiresAt ? BigInt(user.setupTokenExpiresAt) : null,
        passwordLastSetAt: user.passwordLastSetAt ? new Date(user.passwordLastSetAt) : null,
        lastPasswordChangeAt: user.lastPasswordChangeAt ? new Date(user.lastPasswordChangeAt) : null,
        displayName: user.displayName || "",
        lastLoginAt: user.lastLoginAt ? new Date(user.lastLoginAt) : null
      },
      create: {
        id: user.id || undefined,
        email: user.email,
        role: user.role || "customer",
        kind: user.kind || "customer",
        orgId: user.orgId || null,
        passwordHash: user.passwordHash || "",
        passwordAlgo: user.passwordAlgo || "bcrypt",
        isActive: user.isActive !== false,
        active: user.active !== false,
        verified: Boolean(user.verified),
        mustSetPassword: Boolean(user.mustSetPassword),
        requirePasswordReset: Boolean(user.requirePasswordReset),
        firstLogin: Boolean(user.firstLogin),
        firstLoginRequired: Boolean(user.firstLoginRequired),
        mustResetPassword: Boolean(user.mustResetPassword),
        isTemporaryPassword: Boolean(user.isTemporaryPassword),
        setupTokenHash: user.setupTokenHash || null,
        setupTokenExpiresAt: user.setupTokenExpiresAt ? BigInt(user.setupTokenExpiresAt) : null,
        passwordLastSetAt: user.passwordLastSetAt ? new Date(user.passwordLastSetAt) : null,
        lastPasswordChangeAt: user.lastPasswordChangeAt ? new Date(user.lastPasswordChangeAt) : null,
        displayName: user.displayName || "",
        lastLoginAt: user.lastLoginAt ? new Date(user.lastLoginAt) : null
      }
    });
  }
}

module.exports = { loadData, saveData };
