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
  if (String(process.env.NODE_ENV || "").toLowerCase() === "production") {
    const mlToken = String(process.env.FLEETAI_ML_INTERNAL_TOKEN || "").trim();
    if (mlToken.length < 32) {
      throw new Error("FLEETAI_ML_INTERNAL_TOKEN must be 32+ characters in production.");
    }
  }
  if (String(process.env.ELD_PRODUCTION_ENABLED || "").toLowerCase() === "true") {
    const requiredEldGates = [
      "ELD_OFFLINE_ENGINE_COMPLETE",
      "ELD_HOS_ENGINE_VALIDATED",
      "ELD_ROADSIDE_DISPLAY_COMPLETE",
      "ELD_TRANSFER_IMPLEMENTATION_COMPLETE",
      "ELD_INDEPENDENT_REVIEW_COMPLETE",
      "ELD_FIELD_VALIDATION_COMPLETE",
      "ELD_FMCSA_LISTING_CONFIRMED"
    ];
    const missing = requiredEldGates.filter((name) => String(process.env[name] || "").toLowerCase() !== "true");
    const secrets = [
      "FMCSA_ELD_AUTH_PRIVATE_KEY",
      "FMCSA_ELD_CLIENT_CERT",
      "FMCSA_ELD_CLIENT_KEY",
      "FMCSA_ELD_WEBSERVICE_URL",
      "FMCSA_ELD_EMAIL_ADDRESS"
    ];
    missing.push(...secrets.filter((name) => !String(process.env[name] || "").trim()));
    if (missing.length) {
      throw new Error(`ELD production is enabled but required release gates are incomplete: ${missing.join(", ")}`);
    }
  }
  console.log(`PASS: active auth index status=${status.status} note=${status.note || "--"}`);
}

run().catch((err) => {
  console.error(`FAIL: ${err.message || err}`);
  process.exit(1);
});
