const fs = require("fs");
const path = require("path");
const { resolveAuthStorePath, assertAuthStoreReadable } = require("../config/authStorePath");

function readJsonStrict(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`[AUTH STORE] JSON parse failed for ${filePath}: ${err.message}`);
  }
}

function writeJsonAtomic(filePath, obj) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, filePath);
}

function loadAuthStore({ allowEmpty = false, allowMissing = false } = {}) {
  const filePath = resolveAuthStorePath();
  assertAuthStoreReadable(filePath, { allowMissing });
  const stat = fs.existsSync(filePath) ? fs.statSync(filePath) : null;
  const data = fs.existsSync(filePath) ? readJsonStrict(filePath) : { users: [], orgs: [] };
  const users = Array.isArray(data.users) ? data.users : [];
  const orgs = Array.isArray(data.orgs) ? data.orgs : [];

  if (stat) {
    console.log(`[AUTH STORE] path=${filePath}`);
    console.log(`[AUTH STORE] size=${stat.size} modified=${stat.mtime.toISOString()}`);
  }
  console.log(`[AUTH STORE] loaded users=${users.length} orgs=${orgs.length}`);

  if (!allowEmpty && users.length === 0) {
    throw new Error("[AUTH STORE] users=0 while DEV_SETUP=false. Refusing to start.");
  }

  return { filePath, data: Object.assign({}, data, { users, orgs }) };
}

function saveAuthStore(filePath, data) {
  if (!filePath) throw new Error("[AUTH STORE] saveAuthStore missing filePath");
  writeJsonAtomic(filePath, data);
}

module.exports = { loadAuthStore, saveAuthStore };
