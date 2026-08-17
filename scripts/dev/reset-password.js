const bcrypt = require("bcryptjs");
const {
  findOrgAcrossStores,
  findUserAcrossStores,
  loadMaintenanceStores,
  persistMaintenanceChanges
} = require("../../server/auth/authStoreMaintenance");

const DEV_SETUP_MODE = (process.env.DEV_SETUP_MODE || "").toLowerCase() === "true";
if (!DEV_SETUP_MODE || process.env.NODE_ENV === "production") {
  console.error("DEV_SETUP_MODE=true is required to run this script.");
  process.exit(1);
}

const emailArg = (process.argv[2] || "").toLowerCase().trim();
const newPassword = process.argv[3] || "";
if (!emailArg || !newPassword) {
  console.error("Usage: node scripts/dev/reset-password.js <email> <newPassword>");
  process.exit(1);
}
if (newPassword.length < 10) {
  console.error("Password too short. Use at least 10 characters.");
  process.exit(1);
}

async function run() {
  const stores = await loadMaintenanceStores();
  const user = findUserAcrossStores(stores.data, stores.primary, emailArg);
  if (!user) {
    console.error(`User not found: ${emailArg}`);
    process.exit(1);
  }
  user.passwordHash = await bcrypt.hash(newPassword, 12);
  user.passwordAlgo = "bcrypt";
  user.firstLogin = false;
  user.mustSetPassword = false;
  user.requirePasswordReset = false;
  user.mustResetPassword = false;
  user.isTemporaryPassword = false;
  user.passwordLastSetAt = new Date().toISOString();
  user.lastPasswordChangeAt = user.passwordLastSetAt;
  const org = findOrgAcrossStores(stores.data, stores.primary, user.orgId);
  await persistMaintenanceChanges({ ...stores, users: [user], orgs: org ? [org] : [] });
  console.log(`Password updated for ${emailArg}`);
}

run().catch((err) => {
  console.error("Reset failed:", err.message);
  process.exit(1);
});
