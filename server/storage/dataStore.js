const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { createStorage } = require("../lib/storage");

function normalizeReport(data) {
  const safe = data && typeof data === "object" ? data : {};
  return {
    users: Array.isArray(safe.users) ? safe.users.length : 0,
    orgs: Array.isArray(safe.orgs) ? safe.orgs.length : 0
  };
}

function ensureSchema(data) {
  if (!data || typeof data !== "object") return { users: [], orgs: [] };
  if (!Array.isArray(data.users)) data.users = [];
  if (!Array.isArray(data.orgs)) data.orgs = [];
  return data;
}

function createDataStore({ dataPath, defaultData, normalize }) {
  const storage = createStorage({
    dataPath,
    defaultData,
    normalize: (data) => {
      const normalized = normalize ? normalize(data) : data;
      return ensureSchema(normalized);
    }
  });

  async function loadData() {
    const data = await storage.loadData();
    return ensureSchema(data);
  }

  async function safeWriteData(data) {
    return storage.saveData(ensureSchema(data));
  }

  async function createBackup() {
    if (!fs.existsSync(dataPath)) return null;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = `${dataPath}.bak-${stamp}`;
    await fsp.copyFile(dataPath, backupPath);
    return backupPath;
  }

  function getStatus() {
    return storage.getStatus();
  }

  async function validate() {
    return storage.validateConfig();
  }

  return { loadData, safeWriteData, createBackup, getStatus, validate, normalizeReport };
}

module.exports = { createDataStore };
