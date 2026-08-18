"use strict";

function mappedCharacterValue(character) {
  if (!character || !/[0-9A-Za-z]/.test(character)) return 0;
  return character.charCodeAt(0) - 48;
}

function mappedSum(value) {
  return Array.from(String(value ?? "")).reduce(
    (total, character) => total + mappedCharacterValue(character),
    0
  );
}

function rotateLeft8(value, count = 1) {
  let output = value & 0xff;
  for (let index = 0; index < count; index += 1) {
    output = ((output << 1) | (output >>> 7)) & 0xff;
  }
  return output;
}

function hex8(value) {
  return (value & 0xff).toString(16).toUpperCase().padStart(2, "0");
}

function eventDataCheck(fields) {
  const ordered = [
    fields.eventType,
    fields.eventCode,
    fields.eventDate,
    fields.eventTime,
    fields.vehicleMiles,
    fields.engineHours,
    fields.latitude,
    fields.longitude,
    fields.cmvPowerUnitNumber,
    fields.eldUsername
  ];
  const checksum = ordered.reduce((sum, value) => sum + mappedSum(value), 0) & 0xff;
  return hex8(rotateLeft8(checksum, 3) ^ 0xc3);
}

function lineDataCheck(lineWithoutCheck) {
  const checksum = mappedSum(lineWithoutCheck) & 0xff;
  return hex8(rotateLeft8(checksum, 3) ^ 0x96);
}

function appendLineDataCheck(lineWithoutCheck) {
  return `${lineWithoutCheck},${lineDataCheck(lineWithoutCheck)}`;
}

function fileDataCheck(lineChecks) {
  const checksum = lineChecks.reduce((sum, value) => {
    const parsed = Number.parseInt(String(value), 16);
    return sum + (Number.isFinite(parsed) ? parsed : 0);
  }, 0) & 0xffff;
  const high = rotateLeft8((checksum >>> 8) & 0xff, 3);
  const low = rotateLeft8(checksum & 0xff, 3);
  return ((((high << 8) | low) ^ 0x969c) & 0xffff).toString(16).toUpperCase().padStart(4, "0");
}

module.exports = {
  mappedCharacterValue,
  mappedSum,
  rotateLeft8,
  eventDataCheck,
  lineDataCheck,
  appendLineDataCheck,
  fileDataCheck
};
