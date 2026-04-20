const bcrypt = require("bcryptjs");
const { normalizeAuthData, normalizeEmail, hasPasswordHash } = require("../authStore");

function ensureOrg(data, orgId, nowIso) {
  if (!orgId) return false;
  if (!Array.isArray(data.orgs)) data.orgs = [];
  const existing = data.orgs.find((org) => String(org.id || "") === orgId);
  if (existing) return false;
  data.orgs.push({
    id: orgId,
    name: "Default Org",
    status: "active",
    createdAt: nowIso,
    updatedAt: nowIso
  });
  return true;
}

function clearPasswordFlags(user) {
  user.firstLoginRequired = false;
  user.firstLogin = false;
  user.mustSetPassword = false;
  user.requirePasswordReset = false;
  user.mustResetPassword = false;
  user.isTemporaryPassword = false;
  user.setupTokenHash = "";
  user.setupTokenExpiresAt = null;
}

async function applyAuthStoreRepair(data, options) {
  const {
    demoUsers = [],
    resetPasswords = false,
    passwordPlain = "",
    defaultOrgId = "ORG_DEFAULT",
    nowIso = new Date().toISOString()
  } = options || {};

  let changed = false;
  const report = {
    normalized: false,
    orgCreated: false,
    added: [],
    updated: [],
    passwordSet: [],
    passwordReset: []
  };

  const beforeUsers = JSON.stringify(Array.isArray(data.users) ? data.users : []);
  normalizeAuthData(data);
  const afterUsers = JSON.stringify(Array.isArray(data.users) ? data.users : []);
  if (beforeUsers !== afterUsers) {
    report.normalized = true;
    changed = true;
  }

  if (ensureOrg(data, defaultOrgId, nowIso)) {
    report.orgCreated = true;
    changed = true;
  }

  for (const info of demoUsers) {
    const email = normalizeEmail(info.email);
    if (!email) continue;
    let user = (data.users || []).find((u) => normalizeEmail(u.email) === email);
    if (!user) {
      user = {
        id: info.id || `USR_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
        email,
        role: info.role,
        kind: info.kind,
        orgId: info.orgId || defaultOrgId,
        isActive: true,
        active: true,
        createdAt: nowIso
      };
      data.users.push(user);
      report.added.push(email);
      changed = true;
    } else {
      const before = JSON.stringify({
        email: user.email,
        role: user.role,
        kind: user.kind,
        orgId: user.orgId,
        isActive: user.isActive,
        active: user.active
      });
      user.email = email;
      user.role = info.role || user.role;
      user.kind = info.kind || user.kind;
      user.orgId = user.orgId || info.orgId || defaultOrgId;
      user.isActive = user.isActive !== false;
      user.active = user.active !== false;
      const after = JSON.stringify({
        email: user.email,
        role: user.role,
        kind: user.kind,
        orgId: user.orgId,
        isActive: user.isActive,
        active: user.active
      });
      if (before !== after) {
        report.updated.push(email);
        changed = true;
      }
    }

    const needsHash = !hasPasswordHash(user);
    const passwordForUser = info.passwordPlain || passwordPlain;
    if ((resetPasswords || needsHash) && passwordForUser) {
      user.passwordHash = await bcrypt.hash(passwordForUser, 12);
      user.passwordAlgo = "bcrypt";
      clearPasswordFlags(user);
      user.passwordLastSetAt = nowIso;
      user.lastPasswordChangeAt = nowIso;
      if (resetPasswords && !needsHash) {
        report.passwordReset.push(email);
      } else {
        report.passwordSet.push(email);
      }
      changed = true;
    }
  }

  return { data, changed, report };
}

module.exports = { applyAuthStoreRepair };
