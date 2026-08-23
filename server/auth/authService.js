const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { AUTH_ERRORS } = require("./authErrors");
const { normalizeEmail, isCustomerRole, isEmployeeRole, isActiveUser } = require("../authStore");

// Comparing against a real bcrypt hash for unknown/ineligible users keeps the
// observable login cost close to a valid-account login and avoids an email
// enumeration timing oracle.
const INVALID_USER_PASSWORD_HASH = "$2a$12$ZqWDooq8ngFDG0aG9s0fYevFhadqZcBRFvaej1V7mzCBhnmoyIG/y";

function needsPasswordSetup(user) {
  if (!user) return false;
  const hashMissing = !user.passwordHash || String(user.passwordHash).trim() === "";
  return hashMissing
    || user.firstLoginRequired === true
    || user.firstLogin === true
    || user.mustSetPassword
    || user.requirePasswordReset
    || user.mustResetPassword
    || user.isTemporaryPassword;
}

function shouldAutoRepair(email, password, devSetupMode, whitelist) {
  const envDevSetup = String(process.env.DEV_SETUP || "").toLowerCase() === "true";
  const enabled = devSetupMode || envDevSetup;
  if (!enabled) return false;
  if (!Array.isArray(whitelist) || whitelist.length === 0) return false;
  const expectedDevPassword = String(process.env.DEV_SETUP_PASSWORD || "");
  if (!expectedDevPassword || String(password || "") !== expectedDevPassword) return false;
  const normalized = normalizeEmail(email);
  return whitelist.includes(normalized);
}

async function setPassword(user, password) {
  user.passwordHash = await bcrypt.hash(password, 12);
  user.passwordAlgo = "bcrypt";
  user.firstLogin = false;
  user.firstLoginRequired = false;
  user.mustSetPassword = false;
  user.requirePasswordReset = false;
  user.mustResetPassword = false;
  user.isTemporaryPassword = false;
  user.setupTokenHash = "";
  user.setupTokenExpiresAt = null;
  user.passwordLastSetAt = new Date().toISOString();
  user.lastPasswordChangeAt = user.passwordLastSetAt;
  return user;
}

function issueSetupToken(user) {
  const token = crypto.randomBytes(24).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const expiresAt = Date.now() + 15 * 60 * 1000;
  user.setupTokenHash = tokenHash;
  user.setupTokenExpiresAt = expiresAt;
  return { token, expiresAt };
}

function validateSetupToken(user, token) {
  if (!user || !token) return false;
  if (!user.setupTokenHash || !user.setupTokenExpiresAt) return false;
  if (Date.now() > Number(user.setupTokenExpiresAt)) return false;
  const tokenHash = crypto.createHash("sha256").update(token).digest();
  const expectedHash = Buffer.from(String(user.setupTokenHash), "hex");
  return expectedHash.length === tokenHash.length && crypto.timingSafeEqual(tokenHash, expectedHash);
}

function createAuthService(options) {
  const {
    loadData,
    saveData,
    issueSession,
    devSetupMode,
    demoWhitelist = [],
    debugLogger = null,
    storePath = ""
  } = options;

  function logAuth(message, meta) {
    if (!debugLogger) return;
    const detail = meta ? ` ${JSON.stringify(meta)}` : "";
    debugLogger(`[AUTH] ${message}${detail}`);
  }

  async function getUserByEmail(scope, email) {
    const emailNormalized = normalizeEmail(email);
    if (!emailNormalized) return { user: null, emailNormalized };
    const data = await loadData();
    const user = (data.users || []).find((u) => normalizeEmail(u.email) === emailNormalized) || null;
    if (!user) return { user: null, emailNormalized, data };
    if (scope === "customer" && !isCustomerRole(user) && user.kind !== "customer") return { user: null, emailNormalized, data };
    if (scope === "employee" && !isEmployeeRole(user) && user.kind !== "employee") return { user: null, emailNormalized, data };
    return { user, emailNormalized, data };
  }

  async function authenticate(scope, email, password) {
    const emailNormalized = normalizeEmail(email);
    if (!emailNormalized || !password) {
      logAuth("missing credentials", { scope, email: emailNormalized, storePath });
      return { ok: false, error: AUTH_ERRORS.INVALID_CREDENTIALS };
    }
    const result = await getUserByEmail(scope, emailNormalized);
    const user = result.user;
    const data = result.data;
    if (!user) {
      try {
        await bcrypt.compare(password, INVALID_USER_PASSWORD_HASH);
      } catch (_) {
        // Authentication still fails closed if bcrypt itself fails.
      }
      logAuth("user lookup", { scope, email: emailNormalized, found: false, storePath });
      return { ok: false, error: AUTH_ERRORS.INVALID_CREDENTIALS };
    }
    logAuth("user lookup", { scope, email: emailNormalized, found: true, userId: user.id || null, role: user.role, storePath });
    if (!isActiveUser(user)) {
      logAuth("inactive user", { scope, email: emailNormalized, userId: user.id || null });
      return { ok: false, error: AUTH_ERRORS.INVALID_CREDENTIALS };
    }
    let ok = false;
    try {
      ok = await bcrypt.compare(password, user.passwordHash);
    } catch (_) {
      ok = false;
    }
    logAuth("password compare", { scope, email: emailNormalized, userId: user.id || null, method: "bcrypt", result: ok });
    if (!ok && shouldAutoRepair(emailNormalized, password, devSetupMode, demoWhitelist)) {
      await setPassword(user, password);
      await saveData(data);
      ok = true;
    }
    if (!ok) {
      return { ok: false, error: AUTH_ERRORS.INVALID_CREDENTIALS };
    }
    // A first-login token is credential-equivalent: it can replace the
    // account password. Verify the issued temporary password before creating
    // that token, otherwise knowing only an email address is enough to take
    // over any account marked for password setup.
    if (needsPasswordSetup(user)) {
      const tokenInfo = issueSetupToken(user);
      await saveData(data);
      logAuth("password setup required", { scope, email: emailNormalized, userId: user.id || null });
      return { ok: false, error: AUTH_ERRORS.PASSWORD_SETUP_REQUIRED, next: tokenInfo };
    }
    user.lastLoginAt = new Date().toISOString();
    await saveData(data);
    const session = issueSession(scope, user);
    return { ok: true, user, session };
  }

  async function setPasswordWithToken(token, newPassword) {
    if (!token || !newPassword) {
      return { ok: false, error: AUTH_ERRORS.INVALID_CREDENTIALS };
    }
    const data = await loadData();
    const user = (data.users || []).find((u) => validateSetupToken(u, token)) || null;
    if (!user) {
      return { ok: false, error: AUTH_ERRORS.INVALID_CREDENTIALS };
    }
    await setPassword(user, newPassword);
    await saveData(data);
    return { ok: true, user };
  }

  return {
    normalizeEmail,
    authenticate,
    getUserByEmail,
    setPasswordWithToken,
    needsPasswordSetup,
    isCustomerRole,
    isEmployeeRole,
    issueSetupToken
  };
}

module.exports = { createAuthService, normalizeEmail, needsPasswordSetup, isCustomerRole, isEmployeeRole };
