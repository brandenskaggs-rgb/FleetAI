const { getPrisma } = require("./db");
const crypto = require("node:crypto");

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

function oauthStateHash(state) {
  if (typeof state !== "string" || !/^[a-f0-9]{32}$/.test(state)) return null;
  return crypto.createHash("sha256").update(state).digest("hex");
}

async function setMotiveOAuthState(session, state) {
  const hash = oauthStateHash(state);
  if (!session?.id || !hash) throw new Error("Invalid OAuth state session");
  const now = new Date();
  const expiresAt = new Date(Math.min(now.getTime() + OAUTH_STATE_TTL_MS, Number(session.expiresAt)));
  if (!(expiresAt > now)) throw new Error("OAuth session expired");
  if (process.env.DATABASE_URL) {
    const result = await getPrisma().session.updateMany({
      where: { id: session.id, loginRole: "employee", expiresAt: { gt: now } },
      data: { motiveOAuthStateHash: hash, motiveOAuthStateExpiresAt: expiresAt }
    });
    if (result.count !== 1) throw new Error("OAuth session unavailable");
    return;
  }
  session.motiveOAuthStateHash = hash;
  session.motiveOAuthStateExpiresAt = expiresAt;
}

async function consumeMotiveOAuthState(session, state) {
  const hash = oauthStateHash(state);
  if (!session?.id || !hash) return false;
  const now = new Date();
  if (process.env.DATABASE_URL) {
    // Compare and clear in one statement so callbacks on different replicas cannot replay state.
    const result = await getPrisma().session.updateMany({
      where: {
        id: session.id, loginRole: "employee", expiresAt: { gt: now },
        motiveOAuthStateHash: hash, motiveOAuthStateExpiresAt: { gt: now }
      },
      data: { motiveOAuthStateHash: null, motiveOAuthStateExpiresAt: null }
    });
    return result.count === 1;
  }
  if (session.expiresAt <= now.getTime() || !(new Date(session.motiveOAuthStateExpiresAt) > now)) return false;
  const expected = Buffer.from(session.motiveOAuthStateHash || "", "hex");
  const received = Buffer.from(hash, "hex");
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) return false;
  delete session.motiveOAuthStateHash;
  delete session.motiveOAuthStateExpiresAt;
  return true;
}

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
  } catch (error) { if (error.code !== "P2025") throw error; }
}

async function getActiveSession(id) {
  if (!process.env.DATABASE_URL || !id) return null;
  const row = await getPrisma().session.findFirst({ where: { id, expiresAt: { gt: new Date() } } });
  if (!row) return null;
  return { ...row, createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.getTime() };
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

module.exports = { upsertSession, deleteSession, deleteSessionsForUser, getActiveSession, loadActiveSessions, pruneExpiredSessions, setMotiveOAuthState, consumeMotiveOAuthState };
