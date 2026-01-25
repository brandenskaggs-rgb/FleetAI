const fs = require("fs");
const path = require("path");

const filePath = path.resolve(__dirname, "..", "ui", "fleetai-dashboard.html");
if (!fs.existsSync(filePath)) {
  console.error("Missing ui/fleetai-dashboard.html");
  process.exit(1);
}

const html = fs.readFileSync(filePath, "utf8");
const requiredIds = [
  "btnGeneratePairCode",
  "pairPing",
  "pairVehicleSelect",
  "pairDriverSelect",
  "pairingDebugEndpoint",
  "pairingDebugStatus",
  "pairingDebugError",
  "pairingDebugResponse",
  "view-dashboard",
  "view-pairing"
];

const missing = requiredIds.filter((id) => !html.includes(`id="${id}"`));
if (missing.length) {
  console.error("UI smoke failed. Missing ids:");
  missing.forEach((id) => console.error(`  ${id}`));
  process.exit(1);
}

const routeCount = (html.match(/data-route="/g) || []).length;
if (routeCount < 10) {
  console.error(`UI smoke failed. Expected >=10 nav routes, found ${routeCount}.`);
  process.exit(1);
}

console.log("UI smoke OK: dashboard structure present.");
