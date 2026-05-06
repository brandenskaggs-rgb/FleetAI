const path = require("path");
const fs = require("fs");

const STATE_DIR = path.resolve(__dirname, "..", "state");
const DEFAULT_AUTH_STORE_PATH = path.join(STATE_DIR, "auth-store.json");

function ensureParentDir(filePath) {
  const parent = path.dirname(filePath);
  fs.mkdirSync(parent, { recursive: true });
}

function resolveAuthStorePath() {
  const fromEnv = process.env.AUTH_STORE_PATH && process.env.AUTH_STORE_PATH.trim();
  const resolved = fromEnv
    ? path.resolve(fromEnv)
    : DEFAULT_AUTH_STORE_PATH;

  ensureParentDir(resolved);
  return resolved;
}

function assertAuthStoreReadable(filePath, { allowMissing = false } = {}) {
  ensureParentDir(filePath);

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

module.exports = {
  STATE_DIR,
  DEFAULT_AUTH_STORE_PATH,
  resolveAuthStorePath,
  assertAuthStoreReadable
};
