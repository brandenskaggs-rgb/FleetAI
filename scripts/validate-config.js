const path = require("path");
const { createStorage } = require("../server/lib/storage");

const filePath = path.resolve(__dirname, "..", "server", "data.json");
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
  console.log(`PASS: data.json status=${status.status} note=${status.note || "--"}`);
}

run().catch((err) => {
  console.error(`FAIL: ${err.message || err}`);
  process.exit(1);
});
