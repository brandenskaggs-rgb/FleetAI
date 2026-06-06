// In-memory sliding window rate limiter.
// No external dep required; replace with express-rate-limit + Redis for multi-instance prod.
// Window: 60s, default limit: 100 requests per API key or IP.

const windows = new Map();

function cleanup() {
  const now = Date.now();
  for (const [key, { resetAt }] of windows) {
    if (now > resetAt) windows.delete(key);
  }
}

setInterval(cleanup, 60000).unref();

function createRateLimiter({ windowMs = 60000, max = 100, keyPrefix = "rl" } = {}) {
  return function rateLimiter(req, res, next) {
    const apiKey = req.headers["x-api-key"];
    const identity = apiKey ? `${keyPrefix}:key:${apiKey}` : `${keyPrefix}:ip:${req.ip}`;
    const now = Date.now();
    const entry = windows.get(identity);

    if (!entry || now > entry.resetAt) {
      windows.set(identity, { count: 1, resetAt: now + windowMs });
      return next();
    }

    entry.count += 1;
    if (entry.count > max) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.set("Retry-After", String(retryAfter));
      return res.status(429).json({
        success: false,
        error: { code: "RATE_LIMITED", message: "Too many requests. Please slow down." },
        timestamp: new Date().toISOString()
      });
    }
    return next();
  };
}

// Default limiter for general API endpoints
const defaultLimiter = createRateLimiter({ windowMs: 60000, max: 100, keyPrefix: "api" });

// Tighter limiter for prediction endpoints (external partner usage)
const predictionLimiter = createRateLimiter({ windowMs: 60000, max: 100, keyPrefix: "pred" });

module.exports = { createRateLimiter, defaultLimiter, predictionLimiter };
