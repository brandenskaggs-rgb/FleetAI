const fs = require("fs");
const path = require("path");

const filePath = path.resolve(__dirname, "..", "ui", "fleetai-dashboard.html");
if (!fs.existsSync(filePath)) {
  console.error("Missing ui/fleetai-dashboard.html");
  process.exit(1);
}

const html = fs.readFileSync(filePath, "utf8");
const required = [
  'id="btnGeneratePairCode"',
  'id="pairingDebugEndpoint"',
  'id="pairingDebugStatus"',
  'id="pairingDebugError"',
  'id="pairingDebugResponse"',
  'id="view-pairing"',
  'id="pairPing"'
];

const missing = required.filter((token) => !html.includes(token));
if (missing.length) {
  console.error("Dashboard pairing checks failed. Missing:");
  missing.forEach((token) => console.error(`  ${token}`));
  process.exit(1);
}

console.log("OK: dashboard pairing elements present.");
