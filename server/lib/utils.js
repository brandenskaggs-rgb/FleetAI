const crypto = require("crypto");

function makeId(prefix) {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
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
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += Math.floor(Math.random() * 10);
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
  parseNumberField
};
