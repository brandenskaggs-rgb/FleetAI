const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const legacy = fs.readFileSync(path.join(root, "backend", "app", "main.py"), "utf8");
const standalone = fs.readFileSync(path.join(root, "fleet_ai", "api", "ml_service.py"), "utf8");
const client = fs.readFileSync(path.join(root, "server", "services", "pythonMlClient.js"), "utf8");

for (const source of [legacy, standalone]) {
  assert(source.includes('@app.middleware("http")'));
  assert(source.includes("FLEETAI_ML_INTERNAL_TOKEN"));
  assert(source.includes("x-fleetai-ml-token"));
}
assert(client.includes('"X-FleetAI-ML-Token"'));
console.log("ML service auth contract tests: 7 passed, 0 failed");
