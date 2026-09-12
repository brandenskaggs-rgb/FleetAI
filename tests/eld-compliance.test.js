"use strict";

const assert = require("assert");
const crypto = require("crypto");
const {
  mappedCharacterValue,
  mappedSum,
  rotateLeft8,
  eventDataCheck,
  lineDataCheck,
  fileDataCheck
} = require("../server/eld/checksums");
const { buildOutputFilename, buildEldOutputFile } = require("../server/eld/outputFile");
const { AUTHENTICATION_SCHEME, verifyEldOutput } = require("../server/eld/outputAuthentication");
const { decimal, integer, formatEngineHours, formatCoordinate, outputDateFromStored } = require("../server/eld/format");
const { normalizeDutyCode, extractTelemetry, normalizeCoordinates } = require("../server/eld/eldService");
const { DUTY_CODE, VEHICLE_MOVING_KPH } = require("../server/eld/constants");

function check(name, fn) {
  try {
    fn();
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    process.stderr.write(`FAIL ${name}: ${error.message}\n`);
    process.exitCode = 1;
  }
}

check("Appendix A character mapping", () => {
  assert.strictEqual(mappedCharacterValue("0"), 0);
  assert.strictEqual(mappedCharacterValue("A"), 17);
  assert.strictEqual(mappedCharacterValue("a"), 49);
  assert.strictEqual(mappedCharacterValue("-"), 0);
  assert.strictEqual(mappedSum("1A-a"), 67);
});

check("8-bit rotate and federal line/file XOR values", () => {
  assert.strictEqual(rotateLeft8(0x81, 1), 0x03);
  assert.strictEqual(lineDataCheck("1"), "9E");
  assert.strictEqual(fileDataCheck(["00"]), "969C");
});

check("event data check is stable for the ten required fields", () => {
  assert.strictEqual(eventDataCheck({
    eventType: 1,
    eventCode: 3,
    eventDate: "260818",
    eventTime: "123456",
    vehicleMiles: "42",
    engineHours: "1.2",
    latitude: "38.89",
    longitude: "-77.03",
    cmvPowerUnitNumber: "TRK01",
    eldUsername: "driver01"
  }), "7A");
});

check("ELD output filename follows the 25-character standard", () => {
  const value = buildOutputFilename(
    { lastName: "Lee", licenseNum: "A12345" },
    new Date("2026-08-18T00:00:00.000Z")
  );
  assert.strictEqual(value, "Lee__4515081826-000000000");
  assert.strictEqual(value.length, 25);
});

check("export date conversion preserves internal dates and event check sums", () => {
  assert.equal(outputDateFromStored("260911"), "091126");
  assert.equal(outputDateFromStored("240229"), "022924");
  assert.equal(outputDateFromStored("261231"), "123126");
  assert.equal(outputDateFromStored(undefined), "");
  for (const value of ["230229", "261301", "260000", "invalid"]) {
    assert.throws(() => outputDateFromStored(value), /Invalid stored ELD date/);
  }
  const event = { eventType: 1, eventCode: 4, eventDate: "260911", eventTime: "120000" };
  assert.equal(eventDataCheck(event), eventDataCheck({ ...event, eventDate: outputDateFromStored(event.eventDate) }));
  assert.equal(event.eventDate, "260911");
});

check("duty aliases never invent a status", () => {
  assert.strictEqual(normalizeDutyCode("OFF"), DUTY_CODE.OFF_DUTY);
  assert.strictEqual(normalizeDutyCode("SB"), DUTY_CODE.SLEEPER);
  assert.strictEqual(normalizeDutyCode("DRIVING"), DUTY_CODE.DRIVING);
  assert.strictEqual(normalizeDutyCode("BREAK"), null);
});

check("telemetry extraction preserves the five-mph motion threshold inputs", () => {
  const telemetry = extractTelemetry({
    engine: { rpm: 725 },
    vehicle: { speedKph: VEHICLE_MOVING_KPH, odometerKm: 1000, engineHours: 21.4 },
    meta: { latitude: 41.88, longitude: -87.63 }
  });
  assert.strictEqual(telemetry.speedKph, VEHICLE_MOVING_KPH);
  assert.strictEqual(telemetry.totalVehicleMiles, 621);
  assert.strictEqual(telemetry.engineOn, true);
});

check("missing telemetry never becomes a false zero or 0/0 position", () => {
  const telemetry = extractTelemetry({
    engine: { rpm: null },
    vehicle: { speedKph: null, odometerKm: null, engineHours: null },
    meta: { latitude: null, longitude: null }
  });
  assert.strictEqual(telemetry.speedKph, null);
  assert.strictEqual(telemetry.totalVehicleMiles, null);
  assert.strictEqual(telemetry.totalEngineHours, null);
  assert.strictEqual(telemetry.engineOn, null);
  assert.strictEqual(telemetry.latitude, null);
  assert.strictEqual(telemetry.longitude, null);
});

check("personal-conveyance coordinates use reduced precision", () => {
  assert.deepStrictEqual(normalizeCoordinates({ latitude: 41.8781, longitude: -87.6298 }, true), {
    latitude: 41.9,
    longitude: -87.6,
    latitudeCode: "",
    longitudeCode: ""
  });
});

check("ELD numeric formatting preserves missingness and real zero readings", () => {
  for (const value of [null, undefined, "", "  ", false, true, [], {}, NaN, Infinity, "bad"]) {
    assert.strictEqual(decimal(value, 1), "");
    assert.strictEqual(integer(value), "");
    assert.strictEqual(formatEngineHours(value), "");
    assert.strictEqual(formatCoordinate(value), "X");
  }
  for (const value of [0, "0"]) {
    assert.strictEqual(formatEngineHours(value), "0.0");
    assert.strictEqual(formatCoordinate(value), "0.00");
    assert.strictEqual(integer(value), "0");
  }
  assert.strictEqual(decimal(" 12.34 ", 1), "12.3");
  assert.strictEqual(formatCoordinate(-87.6298, true), "-87.6");
});

check("output generator emits all mandatory segment names and a valid final check", () => {
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const event = {
    sequenceId: 1,
    sequenceEpoch: 0,
    recordStatus: 1,
    recordOrigin: 1,
    eventType: 1,
    eventCode: 3,
    eventDate: "260818",
    eventTime: "123456",
    timezoneOffsetMinutes: -300,
    occurredAt: new Date("2026-08-18T17:34:56.000Z"),
    accumulatedVehicleMiles: 1,
    elapsedEngineHours: 0.1,
    totalVehicleMiles: 1000,
    totalEngineHours: 50.1,
    latitude: 41.88,
    longitude: -87.63,
    latitudeCode: "",
    longitudeCode: "",
    distanceSinceCoordinatesKm: 0,
    malfunctionIndicator: false,
    diagnosticIndicator: false,
    eventDataCheck: "7A",
    annotation: "",
    locationDescription: "",
    eldUsername: "driver01",
    cmvPowerUnitNumber: "TRK01",
    cmvVin: "1FUJGHDV0CLBP8834",
    trailerNumbers: "T100",
    shippingDocumentNumber: "LOAD100",
    metadata: {}
  };
  const result = buildEldOutputFile({
    config: {
      eldIdentifier: "FLT001",
      eldRegistrationId: "REG001",
      usdotNumber: "1234567",
      carrierName: "Fleet AI Test Carrier",
      multidayBasis: "US_70_8",
      dayStartMinutes: 0
    },
    driver: {
      firstName: "Test",
      lastName: "Driver",
      eldUsername: "driver01",
      licenseState: "IL",
      licenseNum: "D1234567",
      eldExempt: false
    },
    vehicle: { vehicleId: "TRK01", unitName: "TRK01", vin: "1FUJGHDV0CLBP8834" },
    events: [event],
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" })
  });
  [
    "ELD File Header Segment:",
    "User List:",
    "CMV List:",
    "ELD Event List:",
    "ELD Event Annotations or Comments:",
    "Driver's Certification/Recertification Actions:",
    "Malfunctions and Data Diagnostic Events:",
    "ELD Login/Logout Report:",
    "CMV Engine Power-Up and Shut Down Activity:",
    "Unidentified Driver Profile Records:",
    "End of File:"
  ].forEach((segment) => assert.ok(result.content.includes(segment), segment));
  assert.match(result.content, /End of File:\r[0-9A-F]{4}\r$/);
  assert.equal(result.content.includes("\n"), false);
  assert.equal(result.content.split("\r")[6].split(",")[0], "081826");
  assert.equal(event.eventDate, "260818");
  assert.strictEqual(result.fileDataCheck.length, 4);
});

check("authentication signatures survive export and verify at both RSA key sizes", () => {
  for (const modulusLength of [2048, 3072]) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength });
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
    const config = { eldIdentifier: "FLT001", eldRegistrationId: "TEST", usdotNumber: "1234567",
      carrierName: "Synthetic Test", multidayBasis: "US_70_8" };
    const driver = { eldUsername: "synthetic", licenseNum: "TEST123", licenseState: "MO",
      firstName: "Test", lastName: "Driver" };
    const result = buildEldOutputFile({ config, driver, vehicle: { unitName: "TEST", vin: "" },
      events: [], outputFileComment: "A".repeat(80),
      privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }) });
    const lines = result.content.trimEnd().split("\r");
    const identity = lines[7].split(",");
    const signature = identity[2];
    assert.match(signature, /^[0-9A-F]+$/);
    assert.strictEqual(signature.length, 2 + modulusLength / 4, "version prefix plus complete signature");
    assert.ok(signature.startsWith("F1"));
    assert.strictEqual(result.authenticationScheme, AUTHENTICATION_SCHEME);
    // Independent reconstruction uses the file alone, not model inputs or database state.
    const canonical = lines.slice(0, -1);
    canonical[7] = [identity[0], identity[1], "", identity[3]].join(",");
    const payload = Buffer.from(`FLEETAI-ELD-RSA-SHA256-V1\r${canonical.join("\r")}\r`, "ascii");
    assert.ok(crypto.verify("sha256", payload, publicKey, Buffer.from(signature.slice(2), "hex")));
    assert.ok(verifyEldOutput(result.content, publicKeyPem));
    assert.deepStrictEqual(lines[6].split(",").slice(2, 6), ["X", "X", "", ""],
      "empty history cannot fabricate coordinates or engine hours");
    assert.strictEqual(identity[3].length, 60, "output-file comment is at most 60 characters");
    assert.strictEqual(identity[4], lineDataCheck(identity.slice(0, -1).join(",")));
    const dataLines = lines.slice(0, -2).filter(line => !line.endsWith(":"));
    const checks = dataLines.map(line => line.split(",").pop());
    assert.strictEqual(lines.at(-1), fileDataCheck(checks), "signature change must be covered by checksums");
    const corrupted = Buffer.from(signature.slice(2), "hex");
    corrupted[0] ^= 1;
    assert.strictEqual(crypto.verify("sha256", payload, publicKey, corrupted), false);
  }
});

if (process.exitCode) process.exit(process.exitCode);
process.stdout.write("\nELD compliance primitives passed. This is not FMCSA self-certification.\n");
