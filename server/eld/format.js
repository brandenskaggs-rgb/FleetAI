"use strict";

function cleanField(value, maxLength = 60) {
  return String(value ?? "")
    .replace(/[\r\n,]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function decimal(value, digits, fallback = "") {
  const number = finiteNumeric(value);
  return number !== null ? number.toFixed(digits) : fallback;
}

function integer(value, fallback = "") {
  const number = finiteNumeric(value);
  return number !== null ? String(Math.max(0, Math.round(number))) : fallback;
}

function finiteNumeric(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function eventLocalParts(occurredAt, timezoneOffsetMinutes) {
  const date = new Date(occurredAt);
  if (!Number.isFinite(date.getTime())) throw new TypeError("occurredAt must be a valid date");
  const offset = Number.isFinite(Number(timezoneOffsetMinutes)) ? Number(timezoneOffsetMinutes) : 0;
  const local = new Date(date.getTime() + offset * 60_000);
  const year = String(local.getUTCFullYear()).slice(-2);
  const month = String(local.getUTCMonth() + 1).padStart(2, "0");
  const day = String(local.getUTCDate()).padStart(2, "0");
  const hour = String(local.getUTCHours()).padStart(2, "0");
  const minute = String(local.getUTCMinutes()).padStart(2, "0");
  const second = String(local.getUTCSeconds()).padStart(2, "0");
  return { eventDate: `${year}${month}${day}`, eventTime: `${hour}${minute}${second}` };
}

function formatCoordinate(value, reducedPrecision = false, missingCode = "X") {
  const number = finiteNumeric(value);
  if (number === null) return missingCode;
  return number.toFixed(reducedPrecision ? 1 : 2);
}

function formatEngineHours(value) {
  return decimal(value, 1);
}

function outputDateFromStored(value) {
  if (value === null || value === undefined || value === "") return "";
  // Stored events/certifications use YYMMDD. FMCSA exports require MMDDYY.
  if (!/^\d{6}$/.test(value)) throw new TypeError("Invalid stored ELD date");
  const year = Number(value.slice(0, 2)) + 2000;
  const month = Number(value.slice(2, 4));
  const day = Number(value.slice(4, 6));
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new TypeError("Invalid stored ELD date");
  }
  return value.slice(2) + value.slice(0, 2);
}

function formatSequenceId(value) {
  return (Number(value) & 0xffff).toString(16).toUpperCase();
}

module.exports = {
  cleanField,
  decimal,
  integer,
  eventLocalParts,
  formatCoordinate,
  formatEngineHours,
  outputDateFromStored,
  formatSequenceId
};
