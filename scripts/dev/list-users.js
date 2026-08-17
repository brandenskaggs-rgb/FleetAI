const { loadMaintenanceStores } = require("../../server/auth/authStoreMaintenance");

const DEV_SETUP_MODE = (process.env.DEV_SETUP_MODE || "").toLowerCase() === "true";
if (!DEV_SETUP_MODE || process.env.NODE_ENV === "production") {
  console.error("DEV_SETUP_MODE=true is required to run this script.");
  process.exit(1);
}

async function run() {
  const { primary } = await loadMaintenanceStores();
  const users = Array.isArray(primary.users) ? primary.users : [];
  if (!users.length) {
    console.log("No users found.");
    return;
  }
  console.log("Users:");
  users.forEach((u) => {
    const email = String(u.email || "").toLowerCase();
    const role = u.role || "unknown";
    const orgId = u.orgId || "none";
    const active = u.isActive === false || u.active === false ? "inactive" : "active";
    const needsPassword = !u.passwordHash ? "no-hash" : "hashed";
    console.log(`- ${email} | role=${role} | org=${orgId} | ${active} | ${needsPassword}`);
  });
}

run().catch((err) => {
  console.error("Unable to list users:", err.message);
  process.exit(1);
});
