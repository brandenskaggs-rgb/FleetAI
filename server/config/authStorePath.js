const path = require("path");
const fs = require("fs");

function resolveAuthStorePath() {
  const fromEnv = process.env.AUTH_STORE_PATH && process.env.AUTH_STORE_PATH.trim();
  const resolved = fromEnv
    ? path.resolve(fromEnv)
    : path.resolve(__dirname, "..", "data.json");
  return resolved;
}

function assertAuthStoreReadable(filePath, { allowMissing = false } = {}) {
  if (!fs.existsSync(filePath)) {
    if (allowMissing) return;
    throw new Error(`[AUTH STORE] Missing file: ${filePath}`);
  }
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    throw new Error(`[AUTH STORE] Not a file: ${filePath}`);
  }
  if (stat.size < 5 && !allowMissing) {
    throw new Error(`[AUTH STORE] File looks empty (size=${stat.size}): ${filePath}`);
  }
}

module.exports = { resolveAuthStorePath, assertAuthStoreReadable };
