const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env"), override: false });
const { createStorage } = require("../server/lib/storage");
const { resolveAuthStorePath } = require("../server/config/authStorePath");
const prismaAuthAdapter = require("../server/auth/prismaAuthAdapter");

const filePath = resolveAuthStorePath();
const defaultData = {
  schemaVersion: 2,
  tenantSettings: {},
  vehicles: [],
  drivers: [],
  pairings: [],
  users: [],
  orgs: [],
  leads: [],
  audit: []
};

async function run() {
  const storage = createStorage({ dataPath: filePath, defaultData });
  const result = await storage.validateConfig();
  const status = storage.getStatus();
  if (!result || !result.ok) {
    console.error("FAIL: config validation failed");
    process.exit(1);
  }
  const databaseConfigured = Boolean(String(process.env.DATABASE_URL || "").trim());
  if (databaseConfigured) {
    const primary = await prismaAuthAdapter.loadData();
    if (!Array.isArray(primary.users) || !Array.isArray(primary.orgs)) {
      throw new Error("Primary account database returned an invalid auth shape.");
    }
    console.log(`PASS: primary account database users=${primary.users.length} orgs=${primary.orgs.length}`);
  }
  console.log(`PASS: active auth index status=${status.status} note=${status.note || "--"}`);
}

run().catch((err) => {
  console.error(`FAIL: ${err.message || err}`);
  process.exit(1);
});
