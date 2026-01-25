const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const bcrypt = require("bcryptjs");

const DEV_SETUP_MODE = (process.env.DEV_SETUP_MODE || "").toLowerCase() === "true";
if (!DEV_SETUP_MODE) {
  console.error("DEV_SETUP_MODE=true is required to run this script.");
  process.exit(1);
}

const emailArg = (process.argv[2] || "").toLowerCase().trim();
const newPassword = process.argv[3] || "";
if (!emailArg || !newPassword) {
  console.error("Usage: node scripts/repair-password.js <email> <newPassword>");
  process.exit(1);
}

const dataPath = path.resolve(__dirname, "..", "server", "data.json");
if (!fs.existsSync(dataPath)) {
  console.error(`Missing data file: ${dataPath}`);
  process.exit(1);
}

function writeAtomic(filePath, contents) {
  const tmpPath = `${filePath}.tmp`;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${filePath}.bak-${stamp}`;
  return fsp
    .writeFile(tmpPath, contents, "utf8")
    .then(() => {
      if (fs.existsSync(filePath)) {
        try {
          fs.renameSync(filePath, backupPath);
        } catch (err) {
          fs.copyFileSync(filePath, backupPath);
          fs.unlinkSync(filePath);
        }
      }
      fs.renameSync(tmpPath, filePath);
    });
}

async function run() {
  const raw = await fsp.readFile(dataPath, "utf8");
  let data = {};
  try {
    data = JSON.parse(raw);
  } catch (err) {
    console.error("Failed to parse data.json:", err.message);
    process.exit(1);
  }
  if (!Array.isArray(data.users)) data.users = [];
  const user = data.users.find((u) => String(u.email || "").toLowerCase() === emailArg);
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
  await writeAtomic(dataPath, JSON.stringify(data, null, 2) + "\n");
  console.log(`Password repaired for ${emailArg}`);
}

run().catch((err) => {
  console.error("Repair failed:", err.message);
  process.exit(1);
});
