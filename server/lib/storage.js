const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const DEFAULT_SCHEMA_VERSION = 1;
const DEFAULT_BACKUP_LIMIT = 10;

function stripBom(raw) {
  if (!raw) return "";
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
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

function latestBackup(filePath) {
  const list = listBackups(filePath);
  if (!list.length) return null;
  return path.join(path.dirname(filePath), list[list.length - 1]);
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

  const status = {
    state: "unknown",
    lastError: null,
    note: null,
    lastWriteAt: null,
    lastBackup: null
  };

  async function ensureFile() {
    try {
      await fsp.access(dataPath);
    } catch (err) {
      await saveData(defaultData);
    }
  }

  async function writeAtomic(contents) {
    const tmpPath = `${dataPath}.tmp`;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = `${dataPath}.bak-${stamp}`;

    const handle = await fsp.open(tmpPath, "w");
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();

    if (fs.existsSync(dataPath)) {
      try {
        await fsp.copyFile(dataPath, backupPath);
        status.lastBackup = backupPath;
      } catch (backupErr) {
        console.warn(`[STORAGE] backup failed: ${backupPath}`);
      }
    }

    try {
      await fsp.copyFile(tmpPath, dataPath);
    } finally {
      try {
        await fsp.unlink(tmpPath);
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
    const payload = normalize(data);
    const json = `${JSON.stringify(payload, null, 2)}\n`;
    writeChain = writeChain
      .catch(() => null)
      .then(() => writeAtomic(json));
    await writeChain;
    return payload;
  }

  async function loadData() {
    await writeChain.catch(() => null);
    await ensureFile();
    const raw = await fsp.readFile(dataPath, "utf8");
    const cleaned = stripBom(raw);
    try {
      const parsed = JSON.parse(cleaned);
      status.state = "OK";
      status.lastError = null;
      status.note = null;
      return normalize(parsed);
    } catch (err) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const badPath = `${dataPath}.bad-${stamp}.json`;
      try {
        await fsp.writeFile(badPath, raw, "utf8");
      } catch (writeErr) {
        console.warn(`[STORAGE] failed to write bad snapshot: ${badPath}`);
      }
      try {
        const corruptPath = `${dataPath}.corrupt-${stamp}`;
        await fsp.rename(dataPath, corruptPath);
        status.lastBackup = corruptPath;
      } catch (renameErr) {
        // ignore
      }
      const recovered = attemptJsonRecovery(raw);
      if (recovered && recovered.data) {
        const payload = normalize(recovered.data);
        await saveData(payload);
        status.state = "RECOVERED";
        status.lastError = err.message;
        status.note = recovered.note || "recovered";
        return payload;
      }
      const backupPath = latestBackup(dataPath);
      if (backupPath) {
        try {
          const backupRaw = await fsp.readFile(backupPath, "utf8");
          const backupData = JSON.parse(stripBom(backupRaw));
          const payload = normalize(backupData);
          await saveData(payload);
          status.state = "RECOVERED";
          status.lastError = err.message;
          status.note = `backup:${path.basename(backupPath)}`;
          return payload;
        } catch (backupErr) {
          console.warn(`[STORAGE] backup restore failed: ${backupPath}`);
        }
      }
      const payload = normalize(defaultData);
      await saveData(payload);
      status.state = "RESET";
      status.lastError = err.message;
      status.note = "reset_to_default";
      return payload;
    }
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
