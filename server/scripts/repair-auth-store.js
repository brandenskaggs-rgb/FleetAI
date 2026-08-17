const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env"), override: false });
const { createDataStore } = require("../storage/dataStore");
const { applyAuthStoreRepair } = require("../auth/repairAuthStore");
const { resolveAuthStorePath } = require("../config/authStorePath");
const prismaAuthAdapter = require("../auth/prismaAuthAdapter");

const IS_PROD = process.env.NODE_ENV === "production";
const DEV_SETUP = (process.env.DEV_SETUP || "").toLowerCase() === "true";
const RESET_PASSWORDS = (process.env.DEV_SETUP_RESET_PASSWORDS || "").toLowerCase() === "true";
const generatePassword = () => {
  const raw = require("crypto").randomBytes(18).toString("base64");
  const cleaned = raw.replace(/[^a-zA-Z0-9]/g, "");
  if (cleaned.length >= 14) return cleaned.slice(0, 14);
  return require("crypto").randomBytes(9).toString("hex");
};

function buildDemoUsers() {
  const specs = [
    { email: "admin@fleetai.local", role: "SUPER_ADMIN", kind: "employee", envKey: "ADMIN_PASSWORD" },
    { email: "superadmin@fleetai.local", role: "SUPER_ADMIN", kind: "employee", envKey: "EMPLOYEE_PASSWORD" },
    { email: "customer@fleetai.local", role: "CUSTOMER", kind: "customer", orgId: "ORG_DEFAULT", envKey: "CUSTOMER_PASSWORD" }
  ];
  const generatedPasswords = {};
  const demoUsers = specs.map((spec) => {
    let passwordPlain = process.env[spec.envKey] || "";
    if (!passwordPlain) {
      passwordPlain = generatePassword();
      generatedPasswords[spec.email] = passwordPlain;
    }
    return Object.assign({}, spec, { passwordPlain });
  });
  return { demoUsers, generatedPasswords };
}

if (IS_PROD && !DEV_SETUP) {
  console.error("[repair-auth-store] Refusing to run in production without DEV_SETUP=true.");
  process.exit(1);
}

const dataPath = resolveAuthStorePath();
const defaultData = { schemaVersion: 2, users: [], orgs: [] };

const dataStore = createDataStore({
  dataPath,
  defaultData
});

const { demoUsers, generatedPasswords } = buildDemoUsers();

async function run() {
  const data = await dataStore.loadData();
  const result = await applyAuthStoreRepair(data, {
    demoUsers,
    resetPasswords: RESET_PASSWORDS,
    defaultOrgId: "ORG_DEFAULT"
  });

  if (!result.changed) {
    console.log("[repair-auth-store] No changes needed.");
    return;
  }

  const backupPath = await dataStore.createBackup();
  if (String(process.env.DATABASE_URL || "").trim()) {
    await prismaAuthAdapter.saveData({ users: result.data.users || [], orgs: result.data.orgs || [] });
  }
  await dataStore.safeWriteData(result.data);
  console.log("[repair-auth-store] Updated auth store.");
  if (backupPath) console.log(`[repair-auth-store] Backup: ${backupPath}`);
  console.log("[repair-auth-store] Report:", JSON.stringify(result.report, null, 2));
  const changed = new Set([...(result.report.passwordSet || []), ...(result.report.passwordReset || [])]);
  Object.keys(generatedPasswords).forEach((email) => {
    if (!changed.has(email)) return;
    console.warn(`[repair-auth-store] Generated password for ${email}: ${generatedPasswords[email]}`);
  });
}

run().catch((err) => {
  console.error("[repair-auth-store] Failed:", err);
  process.exit(1);
});
