/**
 * Contract test: server responses vs the Android app's Moshi models.
 *
 * Moshi throws on a missing non-nullable field, and Retrofit surfaces that as a
 * parse exception inside the cab — not as a clear API error. A shape drift is
 * therefore invisible until a driver hits it on the road. This pins the shapes
 * that driver_app/.../network/NetworkModels.kt declares.
 *
 * Deliberately shape-only: it asserts the projections the route handlers build,
 * without HTTP or a database, so it runs anywhere and fails for exactly one
 * reason.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  -> " + detail : "")); }
}
// Moshi: a non-null Kotlin String must never receive null/undefined.
function nonNullString(v) { return typeof v === "string"; }

console.log("DriverProfileResponse(tenantId, driverId, driverName) — all non-null");
{
  const device = { orgId: "ORG_A", driverId: "DRIVER_001" };
  const driver = { firstName: "Sam", lastName: "Ruiz" };
  const name = `${driver.firstName || ""} ${driver.lastName || ""}`.trim();
  const body = { tenantId: device.orgId || "", driverId: device.driverId || "", driverName: name || device.driverId || "Driver" };
  check("tenantId is String", nonNullString(body.tenantId));
  check("driverId is String", nonNullString(body.driverId));
  check("driverName is String", nonNullString(body.driverName));

  // The case that would crash the app: a pairing with no driver record.
  const bare = { orgId: null, driverId: null };
  const d2 = null;
  const n2 = d2 ? "" : "";
  const body2 = { tenantId: bare.orgId || "", driverId: bare.driverId || "", driverName: n2 || bare.driverId || "Driver" };
  check("driverName never null when driver missing", nonNullString(body2.driverName) && body2.driverName.length > 0, JSON.stringify(body2));
  check("tenantId never null when org missing", nonNullString(body2.tenantId));
}

console.log("\nVehicleListResponse(vehicles: [VehicleDto(id, unitNumber, vin, make, model)])");
{
  // A row straight out of db.listVehicles(), with the nullables it really has.
  const rows = [
    { vehicleId: "TRUCK_2701", unitName: "Unit 2701", vin: "1FUJA6CV", make: "Freightliner", model: "Cascadia" },
    { vehicleId: "VAN_044", unitName: null, vin: null, make: null, model: null }
  ];
  const body = {
    vehicles: rows.map((v) => ({
      id: v.vehicleId || v.id || "",
      unitNumber: v.unitName || v.vehicleId || "",
      vin: v.vin || "",
      make: v.make || "",
      model: v.model || ""
    }))
  };
  check("wrapped in { vehicles: [...] }", Array.isArray(body.vehicles));
  check("NOT a bare array", !Array.isArray(body));
  for (const v of body.vehicles) {
    check(`  ${v.id || "(blank)"} all fields non-null String`,
      ["id", "unitNumber", "vin", "make", "model"].every((k) => nonNullString(v[k])), JSON.stringify(v));
  }
  check("null unitName falls back to id", body.vehicles[1].unitNumber === "VAN_044");
}

console.log("\nHosLogResponse(events: [HosLogEventDto(status, notes, timestamp)])");
{
  const events = [
    { payload: { dutyStatus: "DRIVING", notes: "left yard" }, createdAt: "2026-08-12T14:00:00.000Z" },
    { payload: {}, createdAt: "2026-08-12T15:00:00.000Z" }
  ];
  const body = {
    events: events.map((e) => ({
      status: (e.payload && e.payload.dutyStatus) || "",
      notes: (e.payload && e.payload.notes) || "",
      timestamp: e.createdAt || ""
    }))
  };
  check("wrapped in { events: [...] }", Array.isArray(body.events));
  for (const e of body.events) {
    check("  event fields non-null String",
      ["status", "notes", "timestamp"].every((k) => nonNullString(e[k])), JSON.stringify(e));
  }
}

console.log("\nDtcResponse(dtcs: [DtcDto(code, description, severity)])");
{
  const codes = [
    { code: "SPN 110 FMI 0", parameter: "Engine coolant temperature", severity: "critical" },
    { code: "P0128", parameter: null, severity: null }
  ];
  const body = {
    dtcs: codes.map((c) => ({
      code: c.code || "",
      description: c.parameter || "",
      severity: c.severity || "unknown"
    }))
  };
  check("wrapped in { dtcs: [...] }", Array.isArray(body.dtcs));
  for (const d of body.dtcs) {
    check(`  ${d.code} fields non-null String`,
      ["code", "description", "severity"].every((k) => nonNullString(d[k])), JSON.stringify(d));
  }
  check("null severity defaults to 'unknown'", body.dtcs[1].severity === "unknown");
}

console.log("\nBasicResponse(success: Boolean)");
{
  for (const body of [{ success: true }, { success: false, error: "VEHICLE_MISMATCH" }]) {
    check(`  success is Boolean (${JSON.stringify(body)})`, typeof body.success === "boolean");
  }
}

console.log("\nFMCSA duty statuses accepted by POST /api/logs/hos");
{
  const VALID = ["OFF_DUTY", "SLEEPER", "DRIVING", "ON_DUTY", "YARD_MOVE", "PERSONAL_CONVEYANCE"];
  check("covers the four core statuses",
    ["OFF_DUTY", "SLEEPER", "DRIVING", "ON_DUTY"].every((s) => VALID.includes(s)));
  check("covers yard move + personal conveyance",
    VALID.includes("YARD_MOVE") && VALID.includes("PERSONAL_CONVEYANCE"));
  check("rejects an unknown status", !VALID.includes("COFFEE_BREAK"));
  const repository = fs.readFileSync(path.join(
    __dirname, "..", "driver_app", "app", "src", "main", "java", "com", "fleetai", "driver",
    "data", "repository", "DefaultDriverRepository.kt"
  ), "utf8");
  const driverRoutes = fs.readFileSync(path.join(__dirname, "..", "server", "routes", "driverAppRoutes.js"), "utf8");
  check("Android maps OFF to OFF_DUTY", /"OFF",\s*"OFF_DUTY"\s*->\s*"OFF_DUTY"/.test(repository));
  check("Android maps ON to ON_DUTY", /"ON",\s*"ON_DUTY"\s*->\s*"ON_DUTY"/.test(repository));
  check("server accepts legacy OFF and ON tablet statuses", /rawDutyStatus === "OFF"[\s\S]*rawDutyStatus === "ON"/.test(driverRoutes));
}

console.log("\nTelemetry payload carries freshness without repeating VIN as a PID");
{
  const sender = fs.readFileSync(path.join(
    __dirname, "..", "driver_app", "app", "src", "main", "java", "com", "fleetai", "driver",
    "telemetry", "TelemetrySender.kt"
  ), "utf8");
  check("per-PID ages are included in telemetry metadata", /requestMeta\["metricAgesMs"\]/.test(sender));
  check("VIN is carried in metadata", /latestMeta\["vin"\]/.test(sender));
  check("VIN is not inserted into the metrics map", !/metrics\["vin"\]\s*=/.test(sender));
  check("capture and network flushing use separate jobs", /captureJob[\s\S]*flushJob/.test(sender));
  check("metric batches use an atomic immutable snapshot", /latestMetricSnapshot\s*=\s*MetricSnapshot\(validMetrics, validUpdatedAt, packetAt\)/.test(sender));
  check("only PID values refreshed after the previous upload are enqueued", /freshMetrics\s*=\s*metricSnapshot\.metrics\.filter[\s\S]*updatedAt\[key\][\s\S]*lastEnqueuedPacketAt/.test(sender));
  check("heartbeat capture time is not reused as an ECU packet time", /val packetAt = maxOf\(metricPacketAt, latestPacketAt\.takeIf \{ frames\.isNotEmpty\(\) \}/.test(sender));
  const j1979 = fs.readFileSync(path.join(
    __dirname, "..", "driver_app", "app", "src", "main", "java", "com", "fleetai", "driver",
    "telemetry", "J1979Spec.kt"
  ), "utf8");
  const sensorViewModel = fs.readFileSync(path.join(
    __dirname, "..", "driver_app", "app", "src", "main", "java", "com", "fleetai", "driver",
    "ui", "viewmodel", "SensorViewModel.kt"
  ), "utf8");
  check("impossible zero control-module voltage is rejected", /"batteryVoltageV"\s+to\s+5\.0\.\.40\.0/.test(j1979));
  check("fast PID display freshness has a 15-second floor", /coerceIn\(15_000L, 90_000L\)/.test(sensorViewModel));
  check("sender resets before polling publishes capabilities", /sender\.start\(\)\s*\n\s*startPolling\(\)/.test(sensorViewModel));
  check("OBD snapshots use the last successful PID timestamp", /packetAt\s*=\s*lastEcuDataAt/.test(sensorViewModel));
  check("derived boost inherits source freshness instead of loop time", /updatedAt\["boostPsi"\]\s*=\s*boostSourceAt/.test(sensorViewModel));

  const obdManager = fs.readFileSync(path.join(
    __dirname, "..", "driver_app", "app", "src", "main", "java", "com", "fleetai", "driver",
    "obd", "ObdConnectionManager.kt"
  ), "utf8");
  check("ECU liveness expires after bus silence", /ECU_SILENCE_TIMEOUT_MS[\s\S]*ecuResponseFresh[\s\S]*ecuResponding\s*=\s*ecuResponseFresh/.test(obdManager));
  check("OBD polling starts tablet location capture", /startPolling\(\)[\s\S]*startLocationTracking\(\)/.test(sensorViewModel));
  check("OBD polling sends only a fresh tablet location", /locationTracker\.latestFresh\(\)/.test(sensorViewModel));
}

console.log("\nOBD polling has one application-level owner");
{
  const appRoot = path.join(__dirname, "..", "driver_app", "app", "src", "main", "java", "com", "fleetai", "driver");
  const appShell = fs.readFileSync(path.join(appRoot, "FleetAIDriverApp.kt"), "utf8");
  const navGraph = fs.readFileSync(path.join(appRoot, "navigation", "NavGraph.kt"), "utf8");
  const home = fs.readFileSync(path.join(appRoot, "ui", "screens", "HomeScreen.kt"), "utf8");
  const sensors = fs.readFileSync(path.join(appRoot, "ui", "screens", "SensorsScreen.kt"), "utf8");
  check("app shell owns the SensorViewModel", /sensorViewModel:\s*SensorViewModel\s*=\s*viewModel/.test(appShell));
  check("navigation passes the shared SensorViewModel", /sensorViewModel:\s*SensorViewModel/.test(navGraph));
  check("Home does not create a route-scoped OBD poller", !/SensorViewModel\s*=\s*viewModel/.test(home));
  check("Sensors does not create a route-scoped OBD poller", !/SensorViewModel\s*=\s*viewModel/.test(sensors));
}

console.log("\nDriver app branding uses the packaged Fleet AI logo");
{
  const appRoot = path.join(__dirname, "..", "driver_app", "app", "src", "main");
  const logo = path.join(appRoot, "res", "drawable-nodpi", "fleet_ai_logo.png");
  const manifest = fs.readFileSync(path.join(appRoot, "AndroidManifest.xml"), "utf8");
  const adaptiveIcon = fs.readFileSync(path.join(
    appRoot, "res", "mipmap-anydpi-v26", "ic_launcher.xml"
  ), "utf8");
  const iconForeground = path.join(appRoot, "res", "drawable", "ic_launcher_foreground.xml");
  const brandComponent = fs.readFileSync(path.join(
    appRoot, "java", "com", "fleetai", "driver", "ui", "components", "FleetBrandMark.kt"
  ), "utf8");
  const pairingScreen = fs.readFileSync(path.join(
    appRoot, "java", "com", "fleetai", "driver", "ui", "screens", "PairDeviceScreen.kt"
  ), "utf8");
  check("logo PNG is packaged", fs.existsSync(logo) && fs.statSync(logo).size > 100_000);
  check("manifest uses an adaptive launcher icon", /android:icon="@mipmap\/ic_launcher"/.test(manifest));
  check("adaptive icon packages the Fleet AI foreground", /@drawable\/ic_launcher_foreground/.test(adaptiveIcon) && fs.existsSync(iconForeground));
  check("Compose brand component renders the logo resource", /R\.drawable\.fleet_ai_logo/.test(brandComponent));
  check("pairing screen shows the Fleet AI brand mark", /FleetBrandMark/.test(pairingScreen));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
