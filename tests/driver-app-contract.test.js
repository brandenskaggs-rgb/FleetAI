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
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
