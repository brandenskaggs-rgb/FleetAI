const { getPrisma } = require("./db");

async function upsertSession(session) {
  if (!process.env.DATABASE_URL) return;
  await getPrisma().session.upsert({
    where: { id: session.id },
    create: {
      id: session.id,
      userId: session.userId || null,
      email: session.email,
      role: session.role,
      loginRole: session.loginRole,
      orgId: session.orgId || null,
      displayName: session.displayName || "",
      expiresAt: new Date(session.expiresAt),
    },
    update: {
      userId: session.userId || null,
      email: session.email,
      role: session.role,
      loginRole: session.loginRole,
      orgId: session.orgId || null,
      displayName: session.displayName || "",
      expiresAt: new Date(session.expiresAt),
    }
  });
}

async function deleteSession(id) {
  if (!process.env.DATABASE_URL) return;
  try {
    await getPrisma().session.delete({ where: { id } });
  } catch (_) {}
}

async function deleteSessionsForUser(userId, exceptId = null) {
  if (!process.env.DATABASE_URL || !userId) return;
  const where = { userId };
  if (exceptId) where.id = { not: exceptId };
  await getPrisma().session.deleteMany({ where });
}

async function loadActiveSessions() {
  if (!process.env.DATABASE_URL) return [];
  try {
    const rows = await getPrisma().session.findMany({
      where: { expiresAt: { gt: new Date() } }
    });
    return rows.map(row => ({
      id: row.id,
      userId: row.userId,
      email: row.email,
      role: row.role,
      loginRole: row.loginRole,
      orgId: row.orgId,
      displayName: row.displayName,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.getTime(),
    }));
  } catch (err) {
    console.warn("[AUTH] pgSessionStore.loadActiveSessions failed:", err.message);
    return [];
  }
}

async function pruneExpiredSessions() {
  if (!process.env.DATABASE_URL) return;
  try {
    await getPrisma().session.deleteMany({
      where: { expiresAt: { lt: new Date() } }
    });
  } catch (_) {}
}

module.exports = { upsertSession, deleteSession, deleteSessionsForUser, loadActiveSessions, pruneExpiredSessions };
