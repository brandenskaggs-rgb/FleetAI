/**
 * Motive OAuth 2.0 token persistence.
 *
 * Tokens are stored in MlBaselineProfile (profileKey = "_motive_oauth") so they
 * survive Railway container restarts without a schema migration.
 *
 * Call tryRestoreToken() once after the Prisma pool is ready to re-arm the
 * in-memory token that motiveClient uses for API calls.
 */

const https = require("https");
const motiveClient = require("./motiveClient");

const MOTIVE_TOKEN_HOST = "app.gomotive.com";
const PROFILE_KEY = "_motive_oauth";

// ─── Prisma helpers ─────────────────────────────────────────────────────────

function _prisma() {
  return require("../db").getPrisma();
}

async function loadTokens() {
  try {
    const row = await _prisma().mlBaselineProfile.findUnique({
      where: { profileKey: PROFILE_KEY }
    });
    return row ? row.profileJson : null;
  } catch (err) {
    console.warn("[MOTIVE-OAUTH] loadTokens error:", err.message);
    return null;
  }
}

async function saveTokens(tokens) {
  await _prisma().mlBaselineProfile.upsert({
    where: { profileKey: PROFILE_KEY },
    create: { profileKey: PROFILE_KEY, profileJson: tokens },
    update: { profileJson: tokens }
  });
}

async function clearTokens() {
  try {
    await _prisma().mlBaselineProfile.delete({ where: { profileKey: PROFILE_KEY } });
  } catch (_) {}
}

// ─── Token exchange ──────────────────────────────────────────────────────────

function _post(path, body) {
  return new Promise((resolve, reject) => {
    const payload = new URLSearchParams(body).toString();
    const req = https.request(
      {
        hostname: MOTIVE_TOKEN_HOST,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(payload),
          Accept: "application/json"
        }
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => { raw += c; });
        res.on("end", () => {
          let parsed;
          try { parsed = JSON.parse(raw); } catch (e) { return reject(new Error("Motive token response parse error")); }
          if (res.statusCode >= 400) {
            const msg = parsed?.error_description || parsed?.error || JSON.stringify(parsed);
            return reject(new Error(`Motive token ${res.statusCode}: ${msg}`));
          }
          resolve(parsed);
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("Motive token request timeout")); });
    req.write(payload);
    req.end();
  });
}

function _normalize(raw) {
  const expiresIn = raw.expires_in ? Number(raw.expires_in) : 3600;
  return {
    access_token: raw.access_token,
    refresh_token: raw.refresh_token || null,
    token_type: raw.token_type || "Bearer",
    scope: raw.scope || null,
    expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
    obtained_at: new Date().toISOString()
  };
}

async function exchangeCode(code, redirectUri) {
  const clientId = (process.env.MOTIVE_CLIENT_ID || "").trim();
  const clientSecret = (process.env.MOTIVE_CLIENT_SECRET || "").trim();
  if (!clientId || !clientSecret) throw new Error("MOTIVE_CLIENT_ID / MOTIVE_CLIENT_SECRET not configured");

  const raw = await _post("/oauth/token", {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret
  });
  return _normalize(raw);
}

async function refreshAccessToken(refreshToken) {
  const clientId = (process.env.MOTIVE_CLIENT_ID || "").trim();
  const clientSecret = (process.env.MOTIVE_CLIENT_SECRET || "").trim();
  if (!clientId || !clientSecret) throw new Error("MOTIVE_CLIENT_ID / MOTIVE_CLIENT_SECRET not configured");

  const raw = await _post("/oauth/token", {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret
  });
  return _normalize(raw);
}

// ─── Startup restore ─────────────────────────────────────────────────────────

/**
 * Load persisted tokens from Postgres and arm motiveClient's in-memory token.
 * If the access token is expired but a refresh token exists, refresh first.
 * Safe to call even when DATABASE_URL is not set — no-ops gracefully.
 */
async function tryRestoreToken() {
  if (!process.env.DATABASE_URL) return;
  try {
    const tokens = await loadTokens();
    if (!tokens?.access_token) return;

    const expiresAt = tokens.expires_at ? new Date(tokens.expires_at) : null;
    const isExpired = expiresAt && expiresAt < new Date(Date.now() + 60_000);

    if (isExpired && tokens.refresh_token) {
      console.log("[MOTIVE-OAUTH] access token expired — refreshing on startup");
      try {
        const fresh = await refreshAccessToken(tokens.refresh_token);
        const merged = { ...tokens, ...fresh };
        await saveTokens(merged);
        motiveClient.setAccessToken(fresh.access_token);
        console.log("[MOTIVE-OAUTH] token refreshed on startup, expires", fresh.expires_at);
        return;
      } catch (err) {
        console.warn("[MOTIVE-OAUTH] startup refresh failed:", err.message);
        return;
      }
    }

    if (!isExpired) {
      motiveClient.setAccessToken(tokens.access_token);
      console.log("[MOTIVE-OAUTH] restored access token from DB, expires", tokens.expires_at);
    }
  } catch (err) {
    console.warn("[MOTIVE-OAUTH] tryRestoreToken error:", err.message);
  }
}

module.exports = { loadTokens, saveTokens, clearTokens, exchangeCode, refreshAccessToken, tryRestoreToken };
