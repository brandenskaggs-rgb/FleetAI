const assert = require("assert");
const {
  DRIVE_SESSION_GAP_MS,
  buildRiskOverview,
  splitDriveSessions,
  summarizeDriveSessions
} = require("../server/services/advisorContextService");

const start = Date.parse("2026-08-18T12:00:00.000Z");
const sample = (offsetMs, metrics, vehicleId = "Car-01") => ({ vehicleId, ts: new Date(start + offsetMs), metrics });
const samples = [
  sample(0, { rpm: 900, vehicleSpeed: 0, coolantTemp: 80, batteryVoltage: 14.1 }),
  sample(3_000, { rpm: 1600, vehicleSpeed: 60, coolantTemp: 90, batteryVoltage: 14.2 }),
  sample(6_000, { rpm: 1700, vehicleSpeed: 70, coolantTemp: 94, batteryVoltage: 14.3 }),
  sample(DRIVE_SESSION_GAP_MS + 10_000, { rpm: 850, vehicleSpeed: 0, coolantTemp: 88, batteryVoltage: 14.1 })
];

assert.strictEqual(splitDriveSessions(samples).length, 2);
const drives = summarizeDriveSessions(samples);
assert.strictEqual(drives.length, 1);
assert.strictEqual(drives[0].vehicleId, "Car-01");
assert.strictEqual(drives[0].maximumSpeedKph, 70);
assert.strictEqual(drives[0].maximumCoolantTempC, 94);
assert.strictEqual(drives[0].typicalRunningVoltage, 14.2);

const risks = buildRiskOverview({
  alerts: [
    { severity: "critical", resolved: false },
    { severity: "warning", resolved: true }
  ],
  modelStates: [{ healthScore: 64 }, { healthScore: 91 }],
  workOrders: [{ status: "open", dueDate: "2026-01-01T00:00:00Z" }],
  dvirRecords: [{ status: "failed" }],
  eldDiagnostics: [{ status: "DETECTED" }],
  diagnosticScans: [{ severity: "warning" }]
});
assert.deepStrictEqual(risks, {
  activeCriticalAlerts: 1,
  activeWarningAlerts: 0,
  vehiclesBelow70Health: 1,
  lowestVehicleHealthScore: 64,
  openWorkOrders: 1,
  overdueWorkOrders: 1,
  failedInspections: 1,
  activeEldDiagnostics: 1,
  recentDiagnosticScansRequiringAttention: 1
});

console.log("Advisor context tests passed.");
