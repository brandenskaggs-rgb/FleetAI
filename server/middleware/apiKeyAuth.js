const crypto = require("crypto");
const { getPrisma } = require("../db");
const streamTickets = new Map();
const STREAM_TICKET_TTL_MS = 60_000;

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
// Browser EventSource uses a short-lived one-time stream ticket instead of
// putting the long-lived API key in URLs, proxy logs, and browser history.
// On success, attaches req.apiKey = { id, orgId, partner, scopes }.
// Calls next() on success, 401/403 on failure.
async function requireApiKey(req, res, next) {
  const allowsStreamTicket = String(req.method || "GET").toUpperCase() === "GET"
    && req.path === "/api/partner/stream";
  const ticket = allowsStreamTicket && typeof req.query?.streamTicket === "string" ? req.query.streamTicket : "";
  if (ticket) {
    const ticketHash = hashApiKey(ticket);
    const entry = streamTickets.get(ticketHash);
    streamTickets.delete(ticketHash);
    if (!entry || entry.expiresAt <= Date.now()) {
      return res.status(403).json({ success: false, error: { code: "STREAM_TICKET_INVALID", message: "Stream ticket is invalid or expired." } });
    }
    req.apiKey = entry.apiKey;
    return next();
  }
  const raw = req.headers["x-api-key"] || "";
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

function issueStreamTicket(apiKey) {
  const raw = `fst_${crypto.randomBytes(32).toString("hex")}`;
  const expiresAt = Date.now() + STREAM_TICKET_TTL_MS;
  streamTickets.set(hashApiKey(raw), { apiKey: { ...apiKey }, expiresAt });
  if (streamTickets.size > 5000) {
    const now = Date.now();
    for (const [key, value] of streamTickets) if (value.expiresAt <= now) streamTickets.delete(key);
  }
  return { ticket: raw, expiresAt: new Date(expiresAt).toISOString() };
}

module.exports = { requireApiKey, generateApiKey, hashApiKey, issueStreamTicket };
