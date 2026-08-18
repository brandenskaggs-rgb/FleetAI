const IS_PROD = (process.env.NODE_ENV || "").toLowerCase() === "production";
const HIGH_VOLUME_PATHS = new Set(["/api/telemetry/ingest"]);
const lastHighVolumeLogAt = new Map();

// Simple structured request logger (replaces Morgan for Railway compatibility without extra deps).
// Development format: METHOD /path STATUS Xms. Production emits structured JSON.
function requestLogger(req, res, next) {
  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    const parts = [req.method, req.path, res.statusCode, `${ms}ms`];
    if (IS_PROD && res.statusCode < 400 && HIGH_VOLUME_PATHS.has(req.path)) {
      const previous = lastHighVolumeLogAt.get(req.path) || 0;
      if (Date.now() - previous < 60_000) return;
      lastHighVolumeLogAt.set(req.path, Date.now());
    }
    if (IS_PROD) {
      console.log(JSON.stringify({ method: req.method, path: req.path, status: res.statusCode, ms }));
    } else {
      console.log("[HTTP]", parts.join(" "));
    }
  });
  next();
}

module.exports = { requestLogger };
