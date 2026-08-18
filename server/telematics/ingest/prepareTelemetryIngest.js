const { detectAdapter } = require("../protocolRegistry");
const { normalizeMetrics } = require("../normalize/normalizeMetrics");

const MAX_FRAMES_PER_BATCH = 512;
const MAX_CAN_ID = 0x1fffffff;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_OFFLINE_AGE_MS = 8 * 24 * 60 * 60 * 1000;

class TelemetryPayloadError extends Error {
  constructor(message) {
    super(message);
    this.name = "TelemetryPayloadError";
    this.statusCode = 400;
  }
}

function parseCanId(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = /^0x/i.test(trimmed) ? Number.parseInt(trimmed.slice(2), 16) : Number(trimmed);
    return Number.isInteger(parsed) ? parsed : null;
  }
  return Number.isInteger(value) ? value : null;
}

function parseDataBytes(value) {
  if (Array.isArray(value)) {
    if (value.length > 8) return null;
    const bytes = value.map(Number);
    return bytes.every((item) => Number.isInteger(item) && item >= 0 && item <= 255) ? bytes : null;
  }
  if (typeof value === "string") {
    const compact = value.replace(/[^a-fA-F0-9]/g, "");
    if (compact.length > 16 || compact.length % 2 !== 0) return null;
    const bytes = [];
    for (let index = 0; index < compact.length; index += 2) bytes.push(Number.parseInt(compact.slice(index, index + 2), 16));
    return bytes;
  }
  return null;
}

function deriveJ1939Identity(id) {
  const priority = (id >>> 26) & 0x07;
  const dataPage = (id >>> 24) & 0x01;
  const pduFormat = (id >>> 16) & 0xff;
  const pduSpecific = (id >>> 8) & 0xff;
  return {
    priority,
    pgn: pduFormat < 240
      ? (dataPage << 16) | (pduFormat << 8)
      : (dataPage << 16) | (pduFormat << 8) | pduSpecific,
    sourceAddress: id & 0xff,
    destinationAddress: pduFormat < 240 ? pduSpecific : 0xff
  };
}

function boundedText(value, maxLength) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, maxLength) : "";
}

function sanitizeCaptureMetadata(adapter) {
  if (adapter == null) return {};
  if (!adapter || typeof adapter !== "object" || Array.isArray(adapter)) {
    throw new TelemetryPayloadError("adapter must be an object");
  }
  const bitrate = Number(adapter.bitrate);
  if (Number.isFinite(bitrate) && ![250000, 500000].includes(bitrate)) {
    throw new TelemetryPayloadError("adapter.bitrate must be 250000 or 500000");
  }
  const connectorProfiles = new Set(["UNKNOWN", "BLACK_9_PIN", "GREEN_9_PIN", "RP1226", "BENCH_HARNESS"]);
  const connectorProfile = boundedText(adapter.connectorProfile, 40) || "UNKNOWN";
  if (!connectorProfiles.has(connectorProfile)) {
    throw new TelemetryPayloadError("adapter.connectorProfile is not supported");
  }
  return {
    transport: boundedText(adapter.transport, 40),
    protocol: boundedText(adapter.protocol, 20),
    manufacturer: boundedText(adapter.manufacturer, 80),
    product: boundedText(adapter.product, 80),
    serialNumber: boundedText(adapter.serialNumber, 120),
    listenOnly: adapter.listenOnly !== false,
    bitrate: Number.isFinite(bitrate) ? bitrate : null,
    connectorProfile
  };
}

function sanitizeTelemetryMeta(meta) {
  if (meta == null) return {};
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    throw new TelemetryPayloadError("meta must be an object");
  }
  const output = {};
  if (Array.isArray(meta.supportedPids)) {
    output.supportedPids = [...new Set(meta.supportedPids
      .map((value) => boundedText(value, 4).toUpperCase())
      .filter((value) => /^01[0-9A-F]{2}$/.test(value)))]
      .slice(0, 256);
  }
  if (Array.isArray(meta.supportedSpns)) {
    output.supportedSpns = [...new Set(meta.supportedSpns
      .map(Number)
      .filter((value) => Number.isInteger(value) && value > 0 && value <= 524287))]
      .slice(0, 1024);
  }
  if (meta.metricAgesMs && typeof meta.metricAgesMs === "object" && !Array.isArray(meta.metricAgesMs)) {
    output.metricAgesMs = Object.fromEntries(
      Object.entries(meta.metricAgesMs)
        .filter(([key, value]) => /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)
          && Number.isFinite(Number(value))
          && Number(value) >= 0)
        .slice(0, 256)
        .map(([key, value]) => [key, Math.min(Math.round(Number(value)), MAX_OFFLINE_AGE_MS)])
    );
  }
  const vin = boundedText(meta.vin, 17).toUpperCase();
  if (vin && /^[A-HJ-NPR-Z0-9]{11,17}$/.test(vin)) output.vin = vin;
  const connector = boundedText(meta.connectorProfile, 40);
  if (connector) output.connectorProfile = connector;
  for (const [key, maxLength] of Object.entries({
    appVersion: 24,
    obdTransport: 20,
    ecuState: 32,
    adapterIdentity: 80,
    adapterVoltage: 30,
    detectedProtocol: 80,
    obdLastCommand: 20,
    obdLastResponse: 120,
    obdFailureReason: 180
  })) {
    const value = boundedText(meta[key], maxLength);
    if (value) output[key] = value;
  }
  for (const key of ["adapterResponding", "ecuResponding"]) {
    if (typeof meta[key] === "boolean") output[key] = meta[key];
  }
  for (const key of [
    "appVersionCode",
    "lastPgn",
    "captureBitrate",
    "captureBytes",
    "captureRejectedRecords",
    "captureReconnectCount",
    "captureBusSilenceMs"
  ]) {
    const value = Number(meta[key]);
    if (Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER) output[key] = value;
  }
  return output;
}

function sanitizeCanFrames(frames, fallbackTimestamp, nowEpochMs = Date.now()) {
  if (frames == null) return [];
  if (!Array.isArray(frames)) throw new TelemetryPayloadError("frames must be an array");
  if (frames.length > MAX_FRAMES_PER_BATCH) {
    throw new TelemetryPayloadError(`frames cannot exceed ${MAX_FRAMES_PER_BATCH} per batch`);
  }
  return frames.map((frame, index) => {
    if (!frame || typeof frame !== "object") throw new TelemetryPayloadError(`frames[${index}] must be an object`);
    const id = parseCanId(frame.id ?? frame.canId ?? frame.arbitrationId);
    const data = parseDataBytes(frame.data ?? frame.payload ?? frame.bytes);
    if (id == null || id < 0 || id > MAX_CAN_ID) throw new TelemetryPayloadError(`frames[${index}].id is not a valid CAN identifier`);
    if (!data) throw new TelemetryPayloadError(`frames[${index}].data must contain 0-8 bytes`);
    const extended = frame.extended !== false;
    if (!extended && id > 0x7ff) throw new TelemetryPayloadError(`frames[${index}].id exceeds the 11-bit standard CAN range`);
    const frameTimestamp = validateTimestamp(frame.timestamp || frame.ts || fallbackTimestamp, nowEpochMs);
    const sanitized = {
      id,
      data,
      extended,
      timestamp: frameTimestamp
    };
    return extended ? Object.assign(sanitized, deriveJ1939Identity(id)) : sanitized;
  });
}

function mergeUnique(first, second) {
  return [...new Set([...(Array.isArray(first) ? first : []), ...(Array.isArray(second) ? second : [])])];
}

function mergeDefined(first, second) {
  const merged = Object.assign({}, first || {});
  for (const [key, value] of Object.entries(second || {})) {
    if (value !== null && value !== undefined && value !== "") merged[key] = value;
  }
  return merged;
}

function validateTimestamp(value, now = Date.now()) {
  const parsed = new Date(value);
  const time = parsed.getTime();
  if (!Number.isFinite(time)) throw new TelemetryPayloadError("timestamp must be a valid ISO date");
  if (time > now + MAX_CLOCK_SKEW_MS) throw new TelemetryPayloadError("timestamp is too far in the future");
  if (time < now - MAX_OFFLINE_AGE_MS) throw new TelemetryPayloadError("timestamp is older than the offline retention window");
  return parsed.toISOString();
}

function prepareTelemetryIngest(payload, context) {
  const timestamp = validateTimestamp(context.timestamp, context.nowEpochMs || Date.now());
  const frames = sanitizeCanFrames(payload.frames, timestamp, context.nowEpochMs || Date.now());
  const adapter = detectAdapter({ protocol: payload.protocol, frames, metrics: payload.metrics });
  const capture = sanitizeCaptureMetadata(payload.adapter);
  if (adapter.protocol === "J1939" && frames.some((frame) => !frame.extended)) {
    throw new TelemetryPayloadError("J1939 batches may contain only extended 29-bit CAN frames");
  }
  if (adapter.protocol === "J1939" && capture.listenOnly === false) {
    throw new TelemetryPayloadError("Fleet AI accepts J1939 capture only from a listen-only adapter");
  }
  const decodedFrames = frames.length ? adapter.decodeFrames(frames) : { metrics: {}, dtc: {}, meta: {} };
  const suppliedMetrics = payload.metrics && typeof payload.metrics === "object" && !Array.isArray(payload.metrics)
    ? payload.metrics
    : {};
  const decoded = {
    // Raw frames are the server-verifiable source of truth when both are sent.
    metrics: Object.assign({}, suppliedMetrics, decodedFrames.metrics || {}),
    dtc: {
      active: mergeUnique(payload.dtc?.active, decodedFrames.dtc?.active),
      pending: mergeUnique(payload.dtc?.pending, decodedFrames.dtc?.pending)
    },
    meta: mergeDefined(sanitizeTelemetryMeta(payload.meta), decodedFrames.meta)
  };
  const normalized = normalizeMetrics({
    decoded,
    protocol: adapter.protocol,
    timestamp,
    orgId: context.orgId,
    vehicleId: context.vehicleId
  });
  const frameTimes = frames.map((frame) => frame.timestamp).sort();
  const quality = {
    frameCount: frames.length,
    uniquePgnCount: new Set(frames.map((frame) => frame.pgn).filter(Number.isInteger)).size,
    uniqueSourceCount: new Set(frames.map((frame) => frame.sourceAddress).filter(Number.isInteger)).size,
    firstFrameAt: frameTimes[0] || null,
    lastFrameAt: frameTimes[frameTimes.length - 1] || null
  };
  return { adapter, capture, decoded, normalized, frames, quality };
}

module.exports = {
  MAX_FRAMES_PER_BATCH,
  TelemetryPayloadError,
  sanitizeCanFrames,
  sanitizeCaptureMetadata,
  sanitizeTelemetryMeta,
  deriveJ1939Identity,
  validateTimestamp,
  prepareTelemetryIngest
};
