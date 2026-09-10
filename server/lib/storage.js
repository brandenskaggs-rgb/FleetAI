const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("node:crypto");
const STORAGE_REVISION = Symbol("storageRevision");
const revisionOf = (raw) => crypto.createHash("sha256").update(raw).digest("hex");

const DEFAULT_SCHEMA_VERSION = 1;
const DEFAULT_BACKUP_LIMIT = 10;
const FILE_MODE = 0o600;

function stripBom(raw) {
  if (!raw) return "";
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function attemptJsonRecovery(raw) {
  const cleaned = stripBom(raw).trim();
  try {
    return { recovered: false, data: JSON.parse(cleaned), note: "trimmed" };
  } catch (err) {
    const lastBrace = cleaned.lastIndexOf("}");
    const lastBracket = cleaned.lastIndexOf("]");
    const cut = Math.max(lastBrace, lastBracket);
    if (cut < 0) return null;
    const slice = cleaned.slice(0, cut + 1).trim();
    try {
      return { recovered: true, data: JSON.parse(slice), note: "truncated" };
    } catch (err2) {
      return null;
    }
  }
}

function listBackups(filePath) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.startsWith(`${base}.bak-`))
      .sort();
  } catch (err) {
    return [];
  }
}

function normalizeSchema(data, defaultData) {
  const out = typeof data === "object" && data ? { ...data } : {};
  const defaults = defaultData || {};
  out.schemaVersion = Number(out.schemaVersion || defaults.schemaVersion || DEFAULT_SCHEMA_VERSION);
  out.tenantSettings = Object.assign({}, defaults.tenantSettings || {}, out.tenantSettings || {});
  out.vehicles = Array.isArray(out.vehicles) ? out.vehicles : [];
  out.drivers = Array.isArray(out.drivers) ? out.drivers : [];
  out.pairings = Array.isArray(out.pairings) ? out.pairings : [];
  out.users = Array.isArray(out.users) ? out.users : [];
  out.orgs = Array.isArray(out.orgs) ? out.orgs : [];
  out.leads = Array.isArray(out.leads) ? out.leads : [];
  out.audit = Array.isArray(out.audit) ? out.audit : [];
  return Object.assign({}, defaults, out);
}

function createStorage(options) {
  const dataPath = options.dataPath;
  const defaultData = options.defaultData || {};
  const normalize = options.normalize || ((data) => normalizeSchema(data, defaultData));
  const backupLimit = options.backupLimit || DEFAULT_BACKUP_LIMIT;
  let writeChain = Promise.resolve();
  let lastDamagedHash = null;

  function enqueue(work) {
    const result = writeChain.catch(() => null).then(work);
    writeChain = result;
    return result;
  }

  function validateShape(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("Data snapshot must be a JSON object.");
    }
    const collections = new Set([
      "users", "orgs", "vehicles", "drivers", "pairings", "leads", "audit",
      ...Object.keys(defaultData).filter((key) => Array.isArray(defaultData[key]))
    ]);
    for (const key of collections) {
      if (Object.hasOwn(data, key) && !Array.isArray(data[key])) {
        throw new Error(`Data collection ${key} must be an array.`);
      }
    }
    return data;
  }

  function versioned(data, raw) {
    const payload = normalize(validateShape(data));
    payload[STORAGE_REVISION] = { hash: revisionOf(raw) };
    return payload;
  }

  const status = {
    state: "unknown",
    lastError: null,
    note: null,
    lastWriteAt: null,
    lastBackup: null
  };

  async function ensureFile() {
    ensureParentDir(dataPath);
    try {
      await fsp.access(dataPath);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      await writeAtomic(`${JSON.stringify(normalize(validateShape(defaultData)), null, 2)}\n`);
    }
  }

  async function setFilePermissions(filePath) {
    try {
      await fsp.chmod(filePath, FILE_MODE);
    } catch (err) {
      // Windows and some deploy targets may not support chmod the same way.
    }
  }

  async function writeAtomic(contents) {
    ensureParentDir(dataPath);
    const tmpPath = `${dataPath}.tmp`;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = `${dataPath}.bak-${stamp}`;

    const handle = await fsp.open(tmpPath, "w", FILE_MODE);
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await setFilePermissions(tmpPath);

    if (fs.existsSync(dataPath)) {
      try {
        await fsp.copyFile(dataPath, backupPath);
        await setFilePermissions(backupPath);
        status.lastBackup = backupPath;
      } catch (backupErr) {
        console.warn(`[STORAGE] backup failed: ${backupPath}`);
      }
    }

    try {
      // Temp file lives in the same directory, so rename is an atomic replace
      // on the Linux production filesystem. Readers see either the complete
      // old snapshot or the complete new snapshot, never a partial copy.
      await fsp.rename(tmpPath, dataPath);
      await setFilePermissions(dataPath);
      let dirHandle = null;
      try {
        dirHandle = await fsp.open(path.dirname(dataPath), "r");
        await dirHandle.sync();
      } catch (_) {
        // Directory fsync is unavailable on some Windows/filesystem targets.
      } finally {
        if (dirHandle) await dirHandle.close().catch(() => {});
      }
    } finally {
      try {
        if (fs.existsSync(tmpPath)) await fsp.unlink(tmpPath);
      } catch (_) {
        // ignore temp cleanup failure
      }
    }

    pruneBackups();
    status.lastWriteAt = new Date().toISOString();
  }

  function pruneBackups() {
    const backups = listBackups(dataPath);
    if (backups.length <= backupLimit) return;
    const toRemove = backups.slice(0, backups.length - backupLimit);
    toRemove.forEach((name) => {
      try {
        fs.unlinkSync(path.join(path.dirname(dataPath), name));
      } catch (err) {
        console.warn(`[STORAGE] failed to prune backup ${name}`);
      }
    });
  }

  async function saveData(data) {
    const payload = normalize(validateShape(data));
    const json = `${JSON.stringify(payload, null, 2)}\n`;
    const revision = data[STORAGE_REVISION];
    const expected = revision?.hash;
    await enqueue(async () => {
        if (expected) {
          const current = await fsp.readFile(dataPath, "utf8");
          if (revisionOf(current) !== expected) {
            const error = new Error("Records changed while this request was running. Refresh and try again.");
            error.code = "DATA_WRITE_CONFLICT";
            throw error;
          }
        }
        await writeAtomic(json);
        if (revision) revision.hash = revisionOf(json);
      });
    return payload;
  }

  async function loadSnapshot() {
    await ensureFile();
    const raw = await fsp.readFile(dataPath, "utf8");
    const cleaned = stripBom(raw);
    try {
      const data = versioned(JSON.parse(cleaned), raw);
      status.state = "OK";
      status.lastError = null;
      status.note = null;
      lastDamagedHash = null;
      return data;
    } catch (err) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const badPath = `${dataPath}.bad-${stamp}.json`;
      try {
        if (lastDamagedHash !== revisionOf(raw)) {
          await fsp.writeFile(badPath, raw, { encoding: "utf8", mode: FILE_MODE });
          await setFilePermissions(badPath);
          lastDamagedHash = revisionOf(raw);
        }
      } catch (writeErr) {
        console.warn(`[STORAGE] failed to write bad snapshot: ${badPath}`);
      }
      // Leave the damaged primary in place until a recovery succeeds. Removing
      // it lets the next read mistake corruption for a brand-new installation.
      const recovered = attemptJsonRecovery(raw);
      if (recovered && recovered.data) {
        let candidate;
        try { candidate = normalize(validateShape(recovered.data)); } catch (_) { /* Try a validated backup next. */ }
        if (candidate) return restore(candidate, recovered.note || "recovered", err);
      }
      for (const backupName of listBackups(dataPath).reverse()) {
        const backupPath = path.join(path.dirname(dataPath), backupName);
        let candidate;
        try {
          const backupRaw = await fsp.readFile(backupPath, "utf8");
          candidate = normalize(validateShape(JSON.parse(stripBom(backupRaw))));
        } catch (backupErr) {
          console.warn(`[STORAGE] backup restore failed: ${backupPath}`);
        }
        if (candidate) return restore(candidate, `backup:${backupName}`, err);
      }
      status.state = "CORRUPT";
      status.lastError = err.message;
      status.note = "manual_recovery_required";
      const failure = new Error("Data store is corrupt and no valid backup could be restored. Manual recovery required.");
      failure.code = "DATA_STORE_CORRUPT";
      throw failure;
    }
  }

  async function restore(payload, note, error) {
    const json = `${JSON.stringify(payload, null, 2)}\n`;
    await writeAtomic(json);
    status.state = "RECOVERED";
    status.lastError = error.message;
    status.note = note;
    console.warn(`[STORAGE] recovered snapshot (${note}); review data recovery diagnostics.`);
    return versioned(payload, json);
  }

  // Reads, initialization, recovery and writes share one queue: a recovery can
  // never overwrite a successful request that ran while it was reading a backup.
  function loadData() {
    return enqueue(loadSnapshot);
  }

  async function validateConfig() {
    const data = await loadData();
    return { ok: true, status: status.state, note: status.note, data };
  }

  function getStatus() {
    return {
      status: status.state,
      lastError: status.lastError,
      note: status.note,
      lastWriteAt: status.lastWriteAt,
      lastBackup: status.lastBackup
    };
  }

  return { loadData, saveData, validateConfig, getStatus };
}

module.exports = { createStorage };
