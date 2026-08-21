const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
const { RedisStore } = require("rate-limit-redis");
const { createClient } = require("redis");

let _redisClient = null;
let _redisReady = false;

async function initRedis() {
  const url = process.env.REDIS_URL || process.env.REDIS_PRIVATE_URL;
  if (!url) return;
  try {
    _redisClient = createClient({ url });
    _redisClient.on("error", (err) => {
      if (_redisReady) console.warn("[redis] rate-limit client error:", err.message);
    });
    await _redisClient.connect();
    _redisReady = true;
    console.log("[redis] rate-limit store connected");
  } catch (err) {
    console.warn("[redis] rate-limit store unavailable, falling back to in-memory:", err.message);
    _redisClient = null;
    _redisReady = false;
  }
}

// Exported so startServer() can await it before accepting traffic
const redisReady = initRedis().catch(() => {});

function createRateLimiter({ windowMs = 60000, max = 100, keyPrefix = "rl" } = {}) {
  let limiterPromise = null;
  const getLimiter = () => {
    if (!limiterPromise) {
      limiterPromise = redisReady.then(() => {
        const store = (_redisReady && _redisClient)
          ? new RedisStore({ sendCommand: (...args) => _redisClient.sendCommand(args), prefix: keyPrefix })
          : undefined;
        return rateLimit({
          windowMs,
          max,
          standardHeaders: true,
          legacyHeaders: false,
          keyGenerator: (req) => `${keyPrefix}:${req.headers["x-api-key"] || ipKeyGenerator(req.ip)}`,
          store,
          handler: (req, res) => {
            res.status(429).json({
              success: false,
              error: { code: "RATE_LIMITED", message: "Too many requests. Please slow down." },
              timestamp: new Date().toISOString()
            });
          }
        });
      });
    }
    return limiterPromise;
  };

  return async function initializedRateLimiter(req, res, next) {
    try {
      const limiter = await getLimiter();
      return limiter(req, res, next);
    } catch (err) {
      return next(err);
    }
  };
}

const defaultLimiter = createRateLimiter({ windowMs: 60000, max: 100, keyPrefix: "api" });
const predictionLimiter = createRateLimiter({ windowMs: 60000, max: 30, keyPrefix: "pred" });
const loginLimiter = createRateLimiter({ windowMs: 15 * 60000, max: 10, keyPrefix: "auth-login" });

module.exports = { createRateLimiter, defaultLimiter, predictionLimiter, loginLimiter, redisReady };
