/**
 * Motive OAuth 2.0 routes
 *
 *   GET  /api/auth/motive/connect   — superadmin only, redirects browser to Motive auth page
 *   GET  /api/auth/motive/callback  — public (Motive browser redirect), exchanges code for tokens
 *   GET  /api/auth/motive/status    — superadmin only, returns connection state
 *   POST /api/auth/motive/refresh   — superadmin only, force-refreshes the stored access token
 *   POST /api/auth/motive/disconnect — superadmin only, clears stored tokens
 *
 * Flow:
 *   1. Admin visits /api/auth/motive/connect (logs in first)
 *   2. Fleet AI stores a CSRF state in the session and redirects to Motive
 *   3. User authorizes, Motive redirects to /api/auth/motive/callback?code=...&state=...
 *   4. Fleet AI verifies state, exchanges code, saves tokens to Postgres, arms motiveClient
 *   5. Admin is redirected to the employee console with ?motive_connected=1
 */

const crypto = require("crypto");
const motiveClient = require("../services/motiveClient");
const motiveOAuth = require("../services/motiveOAuth");

const MOTIVE_AUTH_HOST = "app.gomotive.com";

// Scopes requested — covers fleet sync, fault codes, driver events
const OAUTH_SCOPES = [
  "vehicles.read",
  "eld_devices.read",
  "fault_codes.read",
  "driver_performance_events.read",
  "hos_logs.read",
  "inspections.read",
  "speed_violations.read"
].join(" ");

function _redirectUri(req) {
  const proto = (req.headers["x-forwarded-proto"] || "").split(",")[0].trim() || (req.secure ? "https" : "http");
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}/api/auth/motive/callback`;
}

function _authUrl(clientId, redirectUri, state) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: OAUTH_SCOPES,
    state
  });
  return `https://${MOTIVE_AUTH_HOST}/oauth/authorize?${params}`;
}

function registerMotiveOAuthRoutes(app, { requireSuperAdmin, sessionStore, getSession }) {
  // ── Step 1: Initiate OAuth ─────────────────────────────────────────────────
  app.get("/api/auth/motive/connect", (req, res, next) => requireSuperAdmin(req, res, next), (req, res) => {
    const clientId = (process.env.MOTIVE_CLIENT_ID || "").trim();
    if (!clientId) {
      return res.status(503).json({ ok: false, error: "MOTIVE_CLIENT_ID not configured — add it to Railway environment variables" });
    }

    const state = crypto.randomBytes(16).toString("hex");
    const redirectUri = _redirectUri(req);
    const authUrl = _authUrl(clientId, redirectUri, state);

    // Store state in the session cookie for CSRF validation on callback
    const session = getSession(req);
    if (session) {
      session.motiveOAuthState = state;
      sessionStore.set(session.id, session);
    }

    console.log("[MOTIVE-OAUTH] initiating connect, redirect_uri:", redirectUri);
    res.redirect(authUrl);
  });

  // ── Step 2: OAuth callback — Motive redirects here ────────────────────────
  // This route is NOT auth-gated because Motive redirects the user's browser here.
  // State parameter provides CSRF protection.
  app.get("/api/auth/motive/callback", (req, res) => {
    (async () => {
      const { code, state, error, error_description } = req.query;

      if (error) {
        console.warn("[MOTIVE-OAUTH] callback error from Motive:", error, error_description);
        return res.redirect(`/admin/employee-console.html?motive_error=${encodeURIComponent(error)}`);
      }

      if (!code) {
        return res.status(400).json({ ok: false, error: "missing_code" });
      }

      // CSRF state validation — only enforce when session is readable
      const session = getSession(req);
      if (session?.motiveOAuthState) {
        if (!state || session.motiveOAuthState !== state) {
          console.error("[MOTIVE-OAUTH] state mismatch — possible CSRF");
          return res.status(403).json({ ok: false, error: "state_mismatch" });
        }
        delete session.motiveOAuthState;
        sessionStore.set(session.id, session);
      }

      const redirectUri = _redirectUri(req);
      const tokens = await motiveOAuth.exchangeCode(code, redirectUri);
      await motiveOAuth.saveTokens(tokens);
      motiveClient.setAccessToken(tokens.access_token);

      console.log("[MOTIVE-OAUTH] connected, access token stored, expires", tokens.expires_at);
      res.redirect("/admin/employee-console.html?motive_connected=1");
    })().catch((err) => {
      console.error("[MOTIVE-OAUTH] callback exception:", err.message);
      res.redirect(`/admin/employee-console.html?motive_error=${encodeURIComponent(err.message)}`);
    });
  });

  // ── Status ─────────────────────────────────────────────────────────────────
  app.get("/api/auth/motive/status", (req, res, next) => requireSuperAdmin(req, res, next), (req, res) => {
    (async () => {
      const tokens = await motiveOAuth.loadTokens();
      const envConfigured = Boolean(
        (process.env.MOTIVE_ACCESS_TOKEN || "").trim() ||
        (process.env.MOTIVE_API_KEY || "").trim()
      );
      const oauthConnected = Boolean(tokens?.access_token);
      const expiresAt = tokens?.expires_at || null;
      const isExpired = expiresAt ? new Date(expiresAt) < new Date() : false;

      res.json({
        ok: true,
        connected: oauthConnected || envConfigured,
        oauthConnected,
        envConfigured,
        expiresAt,
        isExpired,
        hasRefreshToken: Boolean(tokens?.refresh_token),
        scope: tokens?.scope || null,
        obtainedAt: tokens?.obtained_at || null
      });
    })().catch((err) => res.status(500).json({ ok: false, error: err.message }));
  });

  // ── Force refresh ──────────────────────────────────────────────────────────
  app.post("/api/auth/motive/refresh", (req, res, next) => requireSuperAdmin(req, res, next), (req, res) => {
    (async () => {
      const tokens = await motiveOAuth.loadTokens();
      if (!tokens?.refresh_token) {
        return res.status(400).json({ ok: false, error: "No refresh token stored — reconnect via /api/auth/motive/connect" });
      }
      const fresh = await motiveOAuth.refreshAccessToken(tokens.refresh_token);
      const merged = { ...tokens, ...fresh };
      await motiveOAuth.saveTokens(merged);
      motiveClient.setAccessToken(fresh.access_token);
      console.log("[MOTIVE-OAUTH] token refreshed, expires", fresh.expires_at);
      res.json({ ok: true, expiresAt: fresh.expires_at });
    })().catch((err) => res.status(500).json({ ok: false, error: err.message }));
  });

  // ── Disconnect ─────────────────────────────────────────────────────────────
  app.post("/api/auth/motive/disconnect", (req, res, next) => requireSuperAdmin(req, res, next), (req, res) => {
    (async () => {
      await motiveOAuth.clearTokens();
      motiveClient.setAccessToken(null);
      console.log("[MOTIVE-OAUTH] disconnected — tokens cleared");
      res.json({ ok: true });
    })().catch((err) => res.status(500).json({ ok: false, error: err.message }));
  });
}

module.exports = { registerMotiveOAuthRoutes };
