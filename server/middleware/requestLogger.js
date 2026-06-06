const IS_PROD = (process.env.NODE_ENV || "").toLowerCase() === "production";

// Simple structured request logger (replaces Morgan for Railway compatibility without extra deps).
// Format: METHOD /path STATUS Xms [apiKey?]
function requestLogger(req, res, next) {
  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    const apiKey = req.headers["x-api-key"] ? req.headers["x-api-key"].slice(0, 8) + "…" : "";
    const parts = [req.method, req.path, res.statusCode, `${ms}ms`];
    if (apiKey) parts.push(`key=${apiKey}`);
    if (IS_PROD) {
      console.log(JSON.stringify({ method: req.method, path: req.path, status: res.statusCode, ms, apiKey: apiKey || undefined }));
    } else {
      console.log("[HTTP]", parts.join(" "));
    }
  });
  next();
}

module.exports = { requestLogger };
