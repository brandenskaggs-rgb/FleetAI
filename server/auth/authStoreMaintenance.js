const path = require("path");

require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env"), override: false });

const { loadAuthStore, saveAuthStore, normalizeEmail } = require("../authStore");
const prismaAuthAdapter = require("./prismaAuthAdapter");

function hasPrimaryDatabase() {
  return Boolean(String(process.env.DATABASE_URL || "").trim());
}

function orgRecord(org) {
  return {
    id: org.id || org.orgId,
    name: org.name || "Fleet AI Org",
    status: org.status || "ACTIVE",
    email: org.primaryContactEmail || org.email || null,
    phone: org.phone || null,
    address: org.address || null,
    industry: org.industry || null
  };
}

function upsertLocalUser(data, user) {
  data.users = Array.isArray(data.users) ? data.users : [];
  const email = normalizeEmail(user.email);
  const index = data.users.findIndex((item) => normalizeEmail(item.email) === email);
  if (index >= 0) data.users[index] = Object.assign({}, data.users[index], user, { email });
  else data.users.push(Object.assign({}, user, { email }));
  return data.users[index >= 0 ? index : data.users.length - 1];
}

function upsertLocalOrg(data, org) {
  data.orgs = Array.isArray(data.orgs) ? data.orgs : [];
  const id = org.id || org.orgId;
  const index = data.orgs.findIndex((item) => (item.id || item.orgId) === id);
  if (index >= 0) data.orgs[index] = Object.assign({}, data.orgs[index], org, { id });
  else data.orgs.push(Object.assign({}, org, { id }));
  return data.orgs[index >= 0 ? index : data.orgs.length - 1];
}

async function loadMaintenanceStores({ allowEmpty = true, allowMissing = true } = {}) {
  const { filePath, data } = loadAuthStore({ allowEmpty, allowMissing });
  const primary = hasPrimaryDatabase()
    ? await prismaAuthAdapter.loadData()
    : { users: data.users || [], orgs: data.orgs || [] };
  return { filePath, data, primary };
}

async function persistMaintenanceChanges({ filePath, data, users = [], orgs = [] }) {
  const normalizedOrgs = orgs.filter(Boolean).map(orgRecord);
  if (hasPrimaryDatabase()) {
    await prismaAuthAdapter.saveData({ users, orgs: normalizedOrgs });
  }
  for (const org of orgs) upsertLocalOrg(data, org);
  for (const user of users) upsertLocalUser(data, user);
  saveAuthStore(filePath, data);
}

function findUserAcrossStores(data, primary, email) {
  const normalized = normalizeEmail(email);
  return (primary.users || []).find((user) => normalizeEmail(user.email) === normalized)
    || (data.users || []).find((user) => normalizeEmail(user.email) === normalized)
    || null;
}

function findOrgAcrossStores(data, primary, orgId) {
  if (!orgId) return null;
  return (primary.orgs || []).find((org) => (org.id || org.orgId) === orgId)
    || (data.orgs || []).find((org) => (org.id || org.orgId) === orgId)
    || null;
}

module.exports = {
  findOrgAcrossStores,
  findUserAcrossStores,
  hasPrimaryDatabase,
  loadMaintenanceStores,
  persistMaintenanceChanges,
  upsertLocalOrg,
  upsertLocalUser
};
