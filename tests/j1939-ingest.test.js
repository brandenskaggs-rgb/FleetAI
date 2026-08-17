const assert = require("assert");
const {
  prepareTelemetryIngest,
  sanitizeCanFrames,
  sanitizeCaptureMetadata,
  TelemetryPayloadError
} = require("../server/telematics/ingest/prepareTelemetryIngest");

const context = {
  timestamp: "2026-08-14T12:00:00.000Z",
  nowEpochMs: Date.parse("2026-08-14T12:00:01.000Z"),
  orgId: "ORG_A",
  vehicleId: "TRUCK_2701"
};

const prepared = prepareTelemetryIngest({
  protocol: "J1939",
  adapter: {
    transport: "USB_SLCAN",
    protocol: "J1939",
    manufacturer: "Bench Adapter",
    product: "Isolated CAN",
    listenOnly: true,
    bitrate: 500000,
    connectorProfile: "GREEN_9_PIN"
  },
  meta: {
    captureBytes: 1200,
    captureRejectedRecords: 2,
    appVersion: "1.4",
    appVersionCode: 5,
    adapterResponding: true,
    ecuResponding: false,
    ecuState: "no_ecu_response",
    adapterIdentity: "ELM327 v1.5",
    detectedProtocol: "AUTO, ISO 15765-4 CAN",
    obdFailureReason: "ECU returned NO DATA; verify ignition and diagnostic connection",
    ignoredField: "not persisted"
  },
  metrics: { coolantTempC: 10 }, // raw frame must win over client-derived value
  frames: [
    { id: 0x0cf00400, data: [0, 0, 0, 0xe0, 0x2e, 0xff, 0xff, 0xff] },
    { id: 0x18feee00, data: [130, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff] },
    { id: 0x18fef200, data: [0xf4, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff] }
  ]
}, context);

assert.strictEqual(prepared.adapter.protocol, "J1939");
assert.strictEqual(prepared.normalized.engine.rpm, 1500);
assert.strictEqual(prepared.normalized.engine.coolantTempC, 90);
assert.strictEqual(prepared.normalized.engine.fuelRateLph, 25);
assert.strictEqual(prepared.normalized.orgId, "ORG_A");
assert.strictEqual(prepared.frames.length, 3);
assert.strictEqual(prepared.frames[0].pgn, 61444);
assert.strictEqual(prepared.frames[0].sourceAddress, 0);
assert.strictEqual(prepared.frames[0].priority, 3);
assert.strictEqual(prepared.capture.bitrate, 500000);
assert.strictEqual(prepared.capture.connectorProfile, "GREEN_9_PIN");
assert.strictEqual(prepared.quality.uniquePgnCount, 3);
assert.strictEqual(prepared.decoded.meta.captureBytes, 1200);
assert.strictEqual(prepared.decoded.meta.appVersion, "1.4");
assert.strictEqual(prepared.decoded.meta.appVersionCode, 5);
assert.strictEqual(prepared.decoded.meta.adapterResponding, true);
assert.strictEqual(prepared.decoded.meta.ecuResponding, false);
assert.strictEqual(prepared.decoded.meta.detectedProtocol, "AUTO, ISO 15765-4 CAN");
assert.strictEqual(Object.hasOwn(prepared.decoded.meta, "ignoredField"), false);

assert.throws(
  () => sanitizeCanFrames([{ id: 0x20000000, data: [] }], context.timestamp),
  TelemetryPayloadError
);
assert.throws(
  () => sanitizeCanFrames([{ id: 1, data: [256] }], context.timestamp),
  TelemetryPayloadError
);
assert.throws(
  () => sanitizeCanFrames([{ id: 0x1000, data: [], extended: false }], context.timestamp),
  TelemetryPayloadError
);
assert.throws(
  () => sanitizeCaptureMetadata({ bitrate: 125000 }),
  TelemetryPayloadError
);
assert.throws(
  () => sanitizeCanFrames([{ id: 1, data: [], timestamp: "2026-08-15T12:00:00.000Z" }], context.timestamp, context.nowEpochMs),
  TelemetryPayloadError
);
assert.throws(
  () => prepareTelemetryIngest({ protocol: "J1939", frames: [{ id: 0x123, data: [], extended: false }] }, context),
  TelemetryPayloadError
);

console.log("J1939 ingest tests passed");
