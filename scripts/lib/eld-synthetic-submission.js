"use strict";

const { buildEldOutputFile } = require("../../server/eld/outputFile");
const { eventLocalParts, formatEngineHours } = require("../../server/eld/format");
const { eventDataCheck } = require("../../server/eld/checksums");

// Fictional records only. This helper has no database, account or telemetry access.
function syntheticSubmission(identity, privateKeyPem, now = new Date()) {
  const events = [[6, 1, 30], [5, 1, 29], [1, 4, 28]].map(([eventType, eventCode, ago], index) => {
    const occurredAt = new Date(now.getTime() - ago * 60000);
    const event = { sequenceId: index + 1, sequenceEpoch: 0, recordStatus: 1, recordOrigin: 1,
      eventType, eventCode, occurredAt, ...eventLocalParts(occurredAt, -300), timezoneOffsetMinutes: -300,
      accumulatedVehicleMiles: 0, elapsedEngineHours: 0, totalVehicleMiles: 1000, totalEngineHours: 100,
      latitude: 38.89, longitude: -77.03, distanceSinceCoordinatesKm: 0,
      cmvPowerUnitNumber: "TEST001", cmvVin: "1M8GDM9AXKP042788", eldUsername: "test.driver",
      trailerNumbers: "", shippingDocumentNumber: "SYNTHETIC", metadata: {} };
    event.eventDataCheck = eventDataCheck({ ...event, vehicleMiles: eventType === 6 ? "1000" : "0",
      engineHours: formatEngineHours(eventType === 6 ? 100 : 0) });
    return event;
  });
  const outputFileComment = "Fleet AI synthetic development test - no real driver data";
  const output = buildEldOutputFile({ config: { ...identity, usdotNumber: "1234567",
    carrierName: "SYNTHETIC TEST ONLY", multidayBasis: "US_70_8", dayStartMinutes: 0 },
  driver: { firstName: "Test", lastName: "Driver", eldUsername: "test.driver",
    licenseState: "MO", licenseNum: "T123456789", eldExempt: false },
  vehicle: { unitName: "TEST001", vehicleId: "synthetic-unit", vin: "1M8GDM9AXKP042788" },
  events, privateKeyPem, createdAt: now, outputFileComment });
  return { test: true, filename: output.filename, content: output.content, comment: outputFileComment };
}

module.exports = { syntheticSubmission };
