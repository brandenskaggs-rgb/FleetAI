"use strict";

function cleanField(value, maxLength = 60) {
  return String(value ?? "")
    .replace(/[\r\n,]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function decimal(value, digits, fallback = "") {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(digits) : fallback;
}

function integer(value, fallback = "") {
  const number = Number(value);
  return Number.isFinite(number) ? String(Math.max(0, Math.round(number))) : fallback;
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
  const number = Number(value);
  if (!Number.isFinite(number)) return missingCode;
  return number.toFixed(reducedPrecision ? 1 : 2);
}

function formatEngineHours(value) {
  return decimal(value, 1);
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
  formatSequenceId
};
