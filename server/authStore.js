const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const { resolveAuthStorePath, assertAuthStoreReadable } = require("./config/authStorePath");

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
  if (!Array.isArray(data.orgs)) data.orgs = [];
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

function validateAuthSchema(data) {
  if (!data || typeof data !== "object") {
    throw new Error("[AUTH STORE] invalid schema: root must be an object");
  }
  if (!Array.isArray(data.users)) {
    throw new Error("[AUTH STORE] invalid schema: users must be an array");
  }
  if (!Array.isArray(data.orgs)) {
    throw new Error("[AUTH STORE] invalid schema: orgs must be an array");
  }
  data.users.forEach((user, idx) => {
    if (!user || typeof user !== "object") {
      throw new Error(`[AUTH STORE] invalid user at index ${idx}`);
    }
    const email = normalizeEmail(user.email);
    if (!email) {
      throw new Error(`[AUTH STORE] invalid user email at index ${idx}`);
    }
    if (!user.role || typeof user.role !== "string") {
      throw new Error(`[AUTH STORE] invalid user role for ${email}`);
    }
  });
  data.orgs.forEach((org, idx) => {
    if (!org || typeof org !== "object") {
      throw new Error(`[AUTH STORE] invalid org at index ${idx}`);
    }
    if (!org.id || typeof org.id !== "string") {
      throw new Error(`[AUTH STORE] invalid org id at index ${idx}`);
    }
  });
}

function readJsonStrict(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`[AUTH STORE] JSON parse failed for ${filePath}: ${err.message}`);
  }
}

function writeJsonAtomic(filePath, obj) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, filePath);
}

function loadAuthStore({ allowEmpty = false, allowMissing = false } = {}) {
  const filePath = resolveAuthStorePath();
  assertAuthStoreReadable(filePath, { allowMissing });
  const stat = fs.existsSync(filePath) ? fs.statSync(filePath) : null;
  const data = fs.existsSync(filePath) ? readJsonStrict(filePath) : { users: [], orgs: [] };
  const normalized = normalizeAuthData(data);
  validateAuthSchema(normalized);
  const users = Array.isArray(normalized.users) ? normalized.users : [];
  const orgs = Array.isArray(normalized.orgs) ? normalized.orgs : [];

  if (stat) {
    console.log(`[AUTH STORE] path=${filePath}`);
    console.log(`[AUTH STORE] size=${stat.size} modified=${stat.mtime.toISOString()}`);
  }
  console.log(`[AUTH STORE] loaded users=${users.length} orgs=${orgs.length}`);

  if (!allowEmpty && users.length === 0) {
    throw new Error("[AUTH STORE] users=0 while DEV_SETUP=false. Refusing to start.");
  }

  return { filePath, data: normalized };
}

function saveAuthStore(filePath, data) {
  if (!filePath) throw new Error("[AUTH STORE] saveAuthStore missing filePath");
  const normalized = normalizeAuthData(data);
  validateAuthSchema(normalized);
  writeJsonAtomic(filePath, normalized);
}

function findUserByEmail(data, email) {
  const emailNormalized = normalizeEmail(email);
  if (!emailNormalized) return { user: null, emailNormalized };
  const user = (data.users || []).find((u) => normalizeEmail(u.email) === emailNormalized) || null;
  return { user, emailNormalized };
}

function findEmployeeByEmail(data, email) {
  const result = findUserByEmail(data, email);
  if (!result.user || !isEmployeeRole(result.user)) {
    return { user: null, emailNormalized: result.emailNormalized };
  }
  return result;
}

function findCustomerByEmail(data, email) {
  const result = findUserByEmail(data, email);
  if (!result.user || !isCustomerRole(result.user)) {
    return { user: null, emailNormalized: result.emailNormalized };
  }
  return result;
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

async function verifyPasswordHash(hash, password) {
  if (!hash || !password) return false;
  return bcrypt.compare(password, hash);
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

function createUser({ email, role, kind, orgId }) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) throw new Error("[AUTH STORE] createUser missing email");
  if (!role) throw new Error("[AUTH STORE] createUser missing role");
  const resolvedKind = kind || (String(role).toUpperCase().startsWith("CUSTOMER") ? "customer" : "employee");
  return normalizeUser({
    email: normalizedEmail,
    role,
    kind: resolvedKind,
    orgId: orgId || "ORG_DEFAULT",
    isActive: true,
    active: true
  });
}

function createOrg({ id, name }) {
  if (!id) throw new Error("[AUTH STORE] createOrg missing id");
  return {
    id,
    name: name || "Fleet AI Org",
    status: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

module.exports = {
  createAuthStore,
  loadAuthStore,
  saveAuthStore,
  normalizeEmail,
  normalizeAuthData,
  validateAuthSchema,
  findUserByEmail,
  findEmployeeByEmail,
  findCustomerByEmail,
  isActiveUser,
  isCustomerRole,
  isEmployeeRole,
  needsPasswordReset,
  hasPasswordHash,
  verifyPassword,
  verifyPasswordHash,
  setPassword,
  devAutoRepairPasswordOnMismatch,
  createUser,
  createOrg
};
