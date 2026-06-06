const crypto = require("crypto");
const { getPrisma } = require("../db");

// Hash a raw API key for storage (SHA-256, hex).
function hashApiKey(raw) {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

// Generate a new API key: returns { raw, hash }
// raw is shown once to the partner; hash is stored in DB.
function generateApiKey(prefix = "fai") {
  const raw = `${prefix}_${crypto.randomBytes(24).toString("hex")}`;
  return { raw, hash: hashApiKey(raw) };
}

// Express middleware: validates X-API-Key header against the ApiKey table.
// On success, attaches req.apiKey = { id, orgId, partner, scopes }.
// Calls next() on success, 401/403 on failure.
async function requireApiKey(req, res, next) {
  const raw = req.headers["x-api-key"];
  if (!raw) {
    return res.status(401).json({
      success: false,
      error: { code: "API_KEY_MISSING", message: "X-API-Key header required." },
      timestamp: new Date().toISOString()
    });
  }
  try {
    const keyHash = hashApiKey(raw);
    const prisma = getPrisma();
    const record = await prisma.apiKey.findUnique({ where: { keyHash } });
    if (!record || !record.enabled) {
      return res.status(403).json({
        success: false,
        error: { code: "API_KEY_INVALID", message: "Invalid or revoked API key." },
        timestamp: new Date().toISOString()
      });
    }
    // Update last used timestamp (fire and forget)
    prisma.apiKey.update({ where: { id: record.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
    req.apiKey = {
      id: record.id,
      orgId: record.orgId,
      partner: record.partnerName,
      tier: record.tier
    };
    return next();
  } catch (err) {
    console.error("[API-KEY] lookup failed:", err.message);
    return res.status(500).json({
      success: false,
      error: { code: "SERVER_ERROR", message: "API key validation failed." },
      timestamp: new Date().toISOString()
    });
  }
}

module.exports = { requireApiKey, generateApiKey, hashApiKey };
