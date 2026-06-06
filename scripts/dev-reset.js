const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { loadAuthStore, saveAuthStore } = require("../server/authStore");

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function generatePassword() {
  const raw = crypto.randomBytes(18).toString("base64");
  const cleaned = raw.replace(/[^a-zA-Z0-9]/g, "");
  if (cleaned.length >= 14) return cleaned.slice(0, 14);
  return crypto.randomBytes(9).toString("hex");
}

async function seedUsers(data) {
  const usersToSeed = [
    { email: "admin@fleetai.local", role: "EMPLOYEE", kind: "employee", envKey: "ADMIN_PASSWORD" },
    { email: "superadmin@fleetai.local", role: "SUPER_ADMIN", kind: "employee", envKey: "EMPLOYEE_PASSWORD" },
    { email: "customer@fleetai.local", role: "CUSTOMER", kind: "customer", orgId: "ORG_DEFAULT", envKey: "CUSTOMER_PASSWORD" }
  ];

  const generated = {};
  for (const info of usersToSeed) {
    const email = normalizeEmail(info.email);
    let password = process.env[info.envKey] || "";
    if (!password) {
      password = generatePassword();
      generated[email] = password;
    }
    const hash = await bcrypt.hash(password, 12);
    const idx = data.users.findIndex((u) => normalizeEmail(u.email) === email);
    const record = Object.assign({}, idx >= 0 ? data.users[idx] : {}, {
      email,
      role: info.role,
      kind: info.kind,
      orgId: info.orgId || "ORG_DEFAULT",
      passwordHash: hash,
      passwordAlgo: "bcrypt",
      firstLoginRequired: false,
      firstLogin: false,
      mustSetPassword: false,
      requirePasswordReset: false,
      mustResetPassword: false,
      isTemporaryPassword: false,
      setupTokenHash: "",
      setupTokenExpiresAt: null
    });
    if (idx >= 0) {
      data.users[idx] = record;
    } else {
      data.users.push(record);
    }
  }
  return generated;
}

async function main() {
  if (process.env.NODE_ENV === "production" && String(process.env.DEV_SETUP || "").toLowerCase() !== "true") {
    console.error("[dev-reset] Refusing to run in production without DEV_SETUP=true.");
    process.exit(1);
  }
  const { filePath, data } = loadAuthStore({ allowEmpty: true, allowMissing: true });
  data.users = [];
  data.orgs = Array.isArray(data.orgs) ? data.orgs : [];
  const generated = await seedUsers(data);
  saveAuthStore(filePath, data);
  console.log(`[dev-reset] Reset auth store and seeded users in ${filePath}`);
  Object.keys(generated).forEach((email) => {
    console.warn(`[dev-reset] Generated password for ${email}: ${generated[email]}`);
  });
}

main().catch((err) => {
  console.error("[dev-reset] Failed:", err && err.message ? err.message : err);
  process.exit(1);
});
