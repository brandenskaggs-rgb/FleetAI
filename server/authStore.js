const bcrypt = require("bcryptjs");

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function normalizeUser(user) {
  if (!user) return user;
  const email = normalizeEmail(user.email);
  const role = user.role || "customer";
  const upperRole = String(role).toUpperCase();
  const kind = user.kind || (upperRole.startsWith("CUSTOMER") || upperRole === "ORG_ADMIN" ? "customer" : "employee");
  return Object.assign({}, user, {
    email,
    orgId: user.orgId || "ORG_DEFAULT",
    isActive: user.isActive !== false,
    active: user.active !== false,
    role,
    kind
  });
}

function normalizeAuthData(data) {
  if (!data || typeof data !== "object") data = {};
  if (!Array.isArray(data.users)) data.users = [];
  const seen = new Map();
  data.users = data.users.map(normalizeUser).filter((u) => {
    if (!u || !u.email) return false;
    const key = normalizeEmail(u.email);
    if (!seen.has(key)) {
      seen.set(key, u);
      return true;
    }
    const existing = seen.get(key);
    const merged = Object.assign({}, existing, u, {
      email: key,
      passwordHash: existing.passwordHash || u.passwordHash || "",
      kind: existing.kind || u.kind
    });
    seen.set(key, merged);
    return false;
  });
  data.users = Array.from(seen.values());
  const legacyCandidates = [];
  if (Array.isArray(data.customers)) legacyCandidates.push(...data.customers);
  if (data.auth && Array.isArray(data.auth.users)) legacyCandidates.push(...data.auth.users);
  legacyCandidates.forEach((u) => {
    if (!u || !u.email) return;
    const email = normalizeEmail(u.email);
    if (!email) return;
    const exists = data.users.find((x) => normalizeEmail(x.email) === email);
    if (exists) return;
    data.users.push(normalizeUser(Object.assign({}, u, { email })));
  });
  return data;
}

function findUserByEmail(data, email) {
  const emailNormalized = normalizeEmail(email);
  if (!emailNormalized) return { user: null, emailNormalized };
  const user = (data.users || []).find((u) => normalizeEmail(u.email) === emailNormalized) || null;
  return { user, emailNormalized };
}

function isActiveUser(user) {
  if (!user) return false;
  const status = String(user.status || "").toUpperCase();
  if (status === "INACTIVE" || status === "DISABLED") return false;
  return user.isActive !== false && user.active !== false;
}

function isCustomerRole(user) {
  const role = String(user?.role || "").toUpperCase();
  return role.startsWith("CUSTOMER") || role === "ORG_ADMIN";
}

function isEmployeeRole(user) {
  if (!user) return false;
  return !isCustomerRole(user);
}

function hasPasswordHash(user) {
  return typeof user?.passwordHash === "string" && user.passwordHash.trim() !== "";
}

function needsPasswordReset(user) {
  return !hasPasswordHash(user)
    || user.firstLogin === true
    || user.mustSetPassword
    || user.requirePasswordReset
    || user.mustResetPassword
    || user.isTemporaryPassword;
}

async function verifyPassword(user, password) {
  if (!hasPasswordHash(user)) return false;
  return bcrypt.compare(password, user.passwordHash);
}

async function setPassword(user, password) {
  user.passwordHash = await bcrypt.hash(password, 12);
  user.passwordAlgo = "bcrypt";
  user.firstLogin = false;
  user.mustSetPassword = false;
  user.requirePasswordReset = false;
  user.mustResetPassword = false;
  user.isTemporaryPassword = false;
  user.passwordLastSetAt = new Date().toISOString();
  user.lastPasswordChangeAt = user.passwordLastSetAt;
  return user;
}

async function devAutoRepairPasswordOnMismatch(user, password, enabled) {
  if (!enabled) return false;
  await setPassword(user, password);
  return true;
}

function createAuthStore({ readData, writeData, autoRepairEnabled }) {
  return {
    loadAuthStore: async () => readData(),
    saveAuthStore: async (data) => writeData(data),
    normalizeEmail,
    normalizeAuthData,
    findUserByEmail,
    isActiveUser,
    isCustomerRole,
    isEmployeeRole,
    needsPasswordReset,
    verifyPassword,
    setPassword,
    devAutoRepairPasswordOnMismatch: async (user, password) =>
      devAutoRepairPasswordOnMismatch(user, password, autoRepairEnabled)
  };
}

module.exports = {
  createAuthStore,
  normalizeEmail,
  normalizeAuthData,
  findUserByEmail,
  isActiveUser,
  isCustomerRole,
  isEmployeeRole,
  needsPasswordReset,
  hasPasswordHash,
  verifyPassword,
  setPassword,
  devAutoRepairPasswordOnMismatch
};
