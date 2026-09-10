// Prisma-backed auth data adapter.
// Replaces the JSON flat-file read/write pattern for the auth service.
// Provides loadData() / saveData() compatible with authService.createAuthService().
//
// The data shape returned mirrors the flat-file format so authService needs no changes:
// { users: [...], orgs: [...] }

const { getPrisma } = require("../db");
const { isDeepStrictEqual } = require("node:util");
const { randomUUID } = require("node:crypto");
const loadedSnapshots = new WeakMap();

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
  const data = {
    users: users.map(mapUserFromPrisma),
    orgs: orgs.map(mapOrgFromPrisma)
  };
  loadedSnapshots.set(data, structuredClone(data));
  return data;
}

async function saveData(data) {
  const prisma = getPrisma();
  const original = loadedSnapshots.get(data);
  if (original) {
    const versions = [];
    // A login must not rewrite other accounts from its pre-bcrypt snapshot.
    // Compare-and-swap also prevents a stale login/reset from undoing changes
    // to this account made while password verification was running.
    await prisma.$transaction(async (tx) => {
      for (const [collection, model] of [["orgs", "org"], ["users", "user"]]) {
        const beforeById = new Map(original[collection].map((row) => [row.id, row]));
        for (const row of data[collection] || []) {
          const before = beforeById.get(row.id);
          if (!before) throw new Error("Use explicit account provisioning to create records");
          const changes = {};
          for (const key of Object.keys(before)) {
            if (["id", "createdAt", "updatedAt"].includes(key)) continue;
            if (!isDeepStrictEqual(row[key], before[key])) changes[key] = row[key];
          }
          if (!Object.keys(changes).length) continue;
          if (Object.hasOwn(changes, "setupTokenExpiresAt")) {
            changes.setupTokenExpiresAt = changes.setupTokenExpiresAt == null ? null : BigInt(changes.setupTokenExpiresAt);
          }
          const result = await tx[model].updateMany({
            where: { id: row.id, updatedAt: new Date(before.updatedAt) },
            data: changes
          });
          if (result.count !== 1) {
            const error = new Error("Account changed during this request. Please try again.");
            error.code = "AUTH_WRITE_CONFLICT";
            throw error;
          }
          const saved = await tx[model].findUnique({ where: { id: row.id }, select: { updatedAt: true } });
          versions.push([row, toIso(saved.updatedAt)]);
        }
      }
    });
    for (const [row, version] of versions) row.updatedAt = version;
    loadedSnapshots.set(data, structuredClone(data));
    return;
  }
  return prisma.$transaction(async (transaction) => {
    const prisma = transaction;
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

      // An email collision during provisioning must fail, not overwrite the
      // password/tenant of an account created by another concurrent request.
      const userId = user.id || randomUUID();
      await prisma.user.upsert({
        where: { id: userId },
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
          id: userId,
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
  });
}

module.exports = { loadData, saveData };
