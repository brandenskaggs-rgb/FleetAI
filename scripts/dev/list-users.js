const fs = require("fs");
const path = require("path");

const DEV_SETUP_MODE = (process.env.DEV_SETUP_MODE || "").toLowerCase() === "true";
if (!DEV_SETUP_MODE || process.env.NODE_ENV === "production") {
  console.error("DEV_SETUP_MODE=true is required to run this script.");
  process.exit(1);
}

const dataPath = path.resolve(__dirname, "..", "..", "server", "data.json");
if (!fs.existsSync(dataPath)) {
  console.error(`Missing data file: ${dataPath}`);
  process.exit(1);
}

const raw = fs.readFileSync(dataPath, "utf8");
let data = {};
try {
  data = JSON.parse(raw);
} catch (err) {
  console.error("Failed to parse data.json:", err.message);
  process.exit(1);
}

const users = Array.isArray(data.users) ? data.users : [];
if (!users.length) {
  console.log("No users found.");
  process.exit(0);
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
