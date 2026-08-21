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

const speedFactorMatch = html.match(/const KPH_TO_MPH\s*=\s*([0-9.]+)\s*;/);
const speedFactor = speedFactorMatch ? Number(speedFactorMatch[1]) : NaN;
const speedUiRequirements = [
  "Speed (mph)",
  "function telemetrySpeedMph(frame)",
  "liveSpeedText(d)",
  "historyMetricDisplay(metric,r.value??r[metric])"
];
const missingSpeedUi = speedUiRequirements.filter((snippet) => !html.includes(snippet));
if (!Number.isFinite(speedFactor) || Math.abs((100 * speedFactor) - 62.1371) > 0.001 || missingSpeedUi.length) {
  console.error("UI smoke failed. Dashboard road speed must convert canonical km/h telemetry to mph.");
  missingSpeedUi.forEach((snippet) => console.error(`  Missing: ${snippet}`));
  process.exit(1);
}

console.log("UI smoke OK: dashboard structure present.");
