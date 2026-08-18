"use strict";

const crypto = require("crypto");
const { EVENT_TYPE, RECORD_ORIGIN } = require("./constants");
const { appendLineDataCheck, fileDataCheck, lineDataCheck } = require("./checksums");
const {
  cleanField,
  formatCoordinate,
  formatEngineHours,
  formatSequenceId
} = require("./format");

function safe(value, maxLength = 120) {
  return cleanField(value, maxLength).replace(/,/g, ";");
}

function filenameDate(date) {
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const year = String(date.getUTCFullYear()).slice(-2);
  return `${month}${day}${year}`;
}

function buildOutputFilename(driver, createdAt = new Date(), suffix = "000000000") {
  const lastName = safe(driver.lastName, 30).replace(/[^A-Za-z]/g, "").slice(0, 5).padEnd(5, "_");
  const licenseDigits = String(driver.licenseNum || "").replace(/\D/g, "");
  const lastTwo = licenseDigits.slice(-2).padStart(2, "0");
  const digitSum = licenseDigits.split("").reduce((sum, value) => sum + Number(value), 0) % 100;
  const sumText = String(digitSum).padStart(2, "0");
  const unique = safe(suffix, 9).toUpperCase().replace(/[^A-Z0-9]/g, "0").padEnd(9, "0").slice(0, 9);
  return `${lastName}${lastTwo}${sumText}${filenameDate(createdAt)}-${unique}`;
}

function lineCollector() {
  const lines = [];
  const checks = [];
  return {
    title(value) {
      lines.push(value);
    },
    data(fields) {
      const base = fields.map((field) => safe(field, 240)).join(",");
      const check = lineDataCheck(base);
      checks.push(check);
      lines.push(appendLineDataCheck(base));
    },
    finish() {
      const fileCheck = fileDataCheck(checks);
      lines.push("End of File:");
      lines.push(fileCheck);
      return { content: `${lines.join("\r\n")}\r\n`, fileDataCheck: fileCheck };
    }
  };
}

function authenticationValue({ config, driver, events, privateKeyPem }) {
  if (!privateKeyPem) {
    const error = new Error("FMCSA ELD authentication private key is not configured");
    error.code = "ELD_AUTHENTICATION_KEY_MISSING";
    error.statusCode = 503;
    throw error;
  }
  const payload = [
    config.eldRegistrationId,
    config.eldIdentifier,
    config.usdotNumber,
    driver.eldUsername,
    ...events.map((event) => `${event.sequenceEpoch}:${event.sequenceId}:${event.eventDataCheck}`)
  ].join("|");
  return crypto.sign("sha256", Buffer.from(payload, "ascii"), privateKeyPem).toString("base64");
}

function coordinate(event) {
  return event.latitudeCode || formatCoordinate(event.latitude, false, "X");
}

function longitude(event) {
  return event.longitudeCode || formatCoordinate(event.longitude, false, "X");
}

function buildEldOutputFile(input) {
  const { config, driver, vehicle, events, createdAt = new Date(), outputFileComment = "" } = input;
  if (!config?.eldIdentifier || !config?.eldRegistrationId) {
    const error = new Error("FMCSA ELD identifier and registration ID are required before output generation");
    error.code = "ELD_NOT_REGISTERED";
    error.statusCode = 409;
    throw error;
  }
  if (!driver?.eldUsername || !driver?.licenseNum || !driver?.licenseState) {
    const error = new Error("Driver ELD profile is incomplete");
    error.statusCode = 409;
    throw error;
  }
  const ordered = [...events].sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt));
  const current = ordered[0] || {};
  const authentication = authenticationValue({
    config,
    driver,
    events: ordered,
    privateKeyPem: input.privateKeyPem
  });
  const output = lineCollector();
  const timezoneHours = String(Math.abs(Math.round((current.timezoneOffsetMinutes || 0) / 60))).padStart(2, "0");
  const dayStartHours = String(Math.floor((config.dayStartMinutes || 0) / 60)).padStart(2, "0");
  const dayStartMinutes = String((config.dayStartMinutes || 0) % 60).padStart(2, "0");
  const currentDate = current.eventDate || "";
  const currentTime = current.eventTime || "";

  output.title("ELD File Header Segment:");
  output.data([driver.lastName, driver.firstName, driver.eldUsername, driver.licenseState, driver.licenseNum]);
  output.data(["", "", ""]);
  output.data([vehicle.unitName || vehicle.vehicleId, vehicle.vin || "", current.trailerNumbers || ""]);
  output.data([
    config.usdotNumber,
    config.carrierName,
    config.multidayBasis === "US_60_7" ? "7" : "8",
    `${dayStartHours}${dayStartMinutes}00`,
    timezoneHours
  ]);
  output.data([current.shippingDocumentNumber || "", driver.eldExempt ? "E" : "0"]);
  output.data([
    currentDate,
    currentTime,
    coordinate(current),
    longitude(current),
    current.totalVehicleMiles ?? "",
    formatEngineHours(current.totalEngineHours)
  ]);
  output.data([config.eldRegistrationId, config.eldIdentifier, authentication, outputFileComment]);

  output.title("User List:");
  output.data([1, "D", driver.lastName, driver.firstName]);
  output.data([2, "D", "Unidentified", "Driver"]);

  output.title("CMV List:");
  output.data([1, vehicle.unitName || vehicle.vehicleId, vehicle.vin || ""]);

  output.title("ELD Event List:");
  ordered.filter((event) => [EVENT_TYPE.DUTY_STATUS, EVENT_TYPE.INTERMEDIATE_LOG, EVENT_TYPE.SPECIAL_DRIVING].includes(event.eventType))
    .forEach((event) => output.data([
      formatSequenceId(event.sequenceId),
      event.recordStatus,
      event.recordOrigin,
      event.eventType,
      event.eventCode,
      event.eventDate,
      event.eventTime,
      event.accumulatedVehicleMiles ?? "",
      formatEngineHours(event.elapsedEngineHours),
      coordinate(event),
      longitude(event),
      event.distanceSinceCoordinatesKm ?? "",
      1,
      event.recordOrigin === RECORD_ORIGIN.UNIDENTIFIED ? 2 : 1,
      event.malfunctionIndicator ? 1 : 0,
      event.diagnosticIndicator ? 1 : 0,
      event.eventDataCheck
    ]));

  output.title("ELD Event Annotations or Comments:");
  ordered.filter((event) => event.annotation || event.locationDescription).forEach((event) => output.data([
    formatSequenceId(event.sequenceId),
    event.eldUsername,
    event.annotation,
    event.eventDate,
    event.eventTime,
    event.locationDescription
  ]));

  output.title("Driver's Certification/Recertification Actions:");
  ordered.filter((event) => event.eventType === EVENT_TYPE.CERTIFICATION).forEach((event) => output.data([
    formatSequenceId(event.sequenceId),
    event.eventCode,
    event.eventDate,
    event.eventTime,
    event.metadata?.certifiedRecordDate || "",
    1
  ]));

  output.title("Malfunctions and Data Diagnostic Events:");
  ordered.filter((event) => event.eventType === EVENT_TYPE.MALFUNCTION_DIAGNOSTIC).forEach((event) => output.data([
    formatSequenceId(event.sequenceId),
    event.eventCode,
    event.malfunctionDiagnosticCode,
    event.eventDate,
    event.eventTime,
    event.totalVehicleMiles ?? "",
    formatEngineHours(event.totalEngineHours),
    1
  ]));

  output.title("ELD Login/Logout Report:");
  ordered.filter((event) => event.eventType === EVENT_TYPE.LOGIN_LOGOUT).forEach((event) => output.data([
    formatSequenceId(event.sequenceId),
    event.eventCode,
    event.eldUsername,
    event.eventDate,
    event.eventTime,
    event.totalVehicleMiles ?? "",
    formatEngineHours(event.totalEngineHours)
  ]));

  output.title("CMV Engine Power-Up and Shut Down Activity:");
  ordered.filter((event) => event.eventType === EVENT_TYPE.ENGINE_POWER).forEach((event) => output.data([
    formatSequenceId(event.sequenceId),
    event.eventCode,
    event.eventDate,
    event.eventTime,
    event.totalVehicleMiles ?? "",
    formatEngineHours(event.totalEngineHours),
    coordinate(event),
    longitude(event),
    event.cmvPowerUnitNumber,
    event.cmvVin,
    event.trailerNumbers,
    event.shippingDocumentNumber
  ]));

  output.title("Unidentified Driver Profile Records:");
  ordered.filter((event) => event.recordOrigin === RECORD_ORIGIN.UNIDENTIFIED).forEach((event) => output.data([
    formatSequenceId(event.sequenceId),
    event.recordStatus,
    event.recordOrigin,
    event.eventType,
    event.eventCode,
    event.eventDate,
    event.eventTime,
    event.accumulatedVehicleMiles ?? "",
    formatEngineHours(event.elapsedEngineHours),
    coordinate(event),
    longitude(event),
    event.distanceSinceCoordinatesKm ?? "",
    1,
    event.malfunctionIndicator ? 1 : 0,
    event.eventDataCheck
  ]));

  const result = output.finish();
  return {
    ...result,
    filename: buildOutputFilename(driver, createdAt, input.filenameSuffix),
    authenticationValue: authentication
  };
}

module.exports = {
  buildOutputFilename,
  buildEldOutputFile,
  authenticationValue
};
