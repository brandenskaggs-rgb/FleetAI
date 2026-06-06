function errorHandler(err, req, res, next) {
  const status = err.status || err.statusCode || 500;
  const message = err.expose !== false && err.message ? err.message : "Internal Server Error";
  const code = err.code || "SERVER_ERROR";

  if (status >= 500) {
    console.error("[ERROR]", req.method, req.path, err.message, err.stack);
  } else {
    console.warn("[WARN]", req.method, req.path, status, message);
  }

  return res.status(status).json({
    success: false,
    error: { code, message },
    timestamp: new Date().toISOString()
  });
}

module.exports = { errorHandler };
