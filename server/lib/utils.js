const crypto = require("crypto");

function makeId(prefix) {
  // Matches server.js's own makeId exactly (48 bits of randomness via crypto,
  // not Date.now()+a 1-in-10,000 draw) — adminRoutes.js/orgManagementRoutes.js
  // require() this file directly rather than server.js's deps-injected version,
  // so a mismatch here silently reintroduces a real ID-collision risk for
  // org/user/lead/invite creation.
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

function nowIso() {
  return new Date().toISOString();
}

function sanitizeString(value, max = 500) {
  if (!value) return "";
  const clean = String(value).replace(/[<>]/g, "").trim();
  return clean.slice(0, max);
}

function generateDigits(length) {
  // crypto.randomInt, not Math.random: these digits become pairing codes and
  // driver PINs — security tokens that gate a device onto a real vehicle.
  // Math.random is a non-cryptographic PRNG whose output is predictable from
  // prior values, which would let an attacker anticipate the next issued code
  // rather than having to brute force it against the rate limiter.
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += crypto.randomInt(0, 10);
  }
  return out;
}

function generateTempPassword() {
  return crypto.randomBytes(8).toString("hex");
}

function generateDriverPin() {
  return generateDigits(6);
}

function generatePairingCode() {
  return generateDigits(6);
}

function isExpired(expiresAt) {
  const ts = new Date(expiresAt).getTime();
  return Number.isFinite(ts) && ts <= Date.now();
}

function safeParseJson(text) {
  if (!text) return null;
  const cleaned = String(text).trim().replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    return null;
  }
}

function addAudit(data, event, detail) {
  data.audit = Array.isArray(data.audit) ? data.audit : [];
  data.audit.unshift({
    id: `AUD_${Date.now()}`,
    event,
    detail: detail || "",
    createdAt: nowIso()
  });
  if (data.audit.length > 500) {
    data.audit = data.audit.slice(0, 500);
  }
}

function normalizeEmail(value) {
  const email = sanitizeString(value, 200).toLowerCase();
  if (!email) return "";
  return /^[^@]+@[^@]+\.[^@]+$/.test(email) ? email : "";
}

function parseNumberField(value, fallback = null) {
  if (value === undefined || value === null || value === "") return fallback;
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function publicUserView(user) {
  if (!user || typeof user !== "object") return null;
  const fields = [
    "id", "email", "role", "kind", "orgId", "displayName", "status",
    "isActive", "active", "verified", "mustSetPassword", "requirePasswordReset",
    "mustResetPassword", "isTemporaryPassword", "passwordLastSetAt",
    "lastPasswordChangeAt", "lastLoginAt", "createdAt", "updatedAt"
  ];
  return fields.reduce((view, field) => {
    if (user[field] !== undefined) view[field] = user[field];
    return view;
  }, {});
}

module.exports = {
  makeId,
  nowIso,
  sanitizeString,
  generateDigits,
  generateTempPassword,
  generateDriverPin,
  generatePairingCode,
  isExpired,
  safeParseJson,
  addAudit,
  normalizeEmail,
  parseNumberField,
  publicUserView
};
