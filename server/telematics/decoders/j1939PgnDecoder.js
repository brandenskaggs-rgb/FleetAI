const spnMap = require("./j1939_spn_map.json");
const {
  decodeFrame,
  decodeSpns,
  decodeDmDtc,
  J1939Reassembler
} = require("../../../telemetry/standards/j1939/decoder");

// PGN 65260 (0xFEEC) — Vehicle Identification (VIN), 17-byte ASCII
const PGN_VIN = 65260;

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function decodeSpnValue(spn, rawValue) {
  const entry = spnMap[String(spn)];
  if (!entry || rawValue == null) return null;
  if (entry.metric === "regenActive") {
    return { [entry.metric]: Boolean(rawValue) };
  }
  const scaled = rawValue * entry.scale + entry.offset;
  return { [entry.metric]: scaled };
}

function normalizeMetricName(name) {
  if (!name) return null;
  const map = {
    engine_speed: "rpm",
    vehicle_speed: "speedKph",
    coolant_temp: "coolantTempC",
    oil_temp: "oilTempC",
    battery_voltage: "batteryVoltageV",
    actual_engine_torque: "engineLoadPct",
    fuel_rate: "fuelRateLph",
    engine_hours: "engineHours",
    vehicle_distance: "odometerKm",
    ambient_temp: "ambientTempC",
    barometric_pressure: "baroKpa",
    exhaust_temp: "egtC",
    boost_pressure: "boostPressureKpa",
    transmission_temp: "transmissionTempC",
    oil_pressure: "engineOilPressureKpa",
    engine_oil_level: "engineOilLevelPct",
    fuel_level: "fuelLevelPct",
    trip_distance: "tripDistanceKm",
    fuel_delivery_pressure: "fuelDeliveryPressureKpa",
    accelerator_pedal_position: "acceleratorPedalPosPct"
  };
  return map[name] || null;
}

function parseDataBytes(input) {
  if (Array.isArray(input)) return input.map((v) => Number(v)).filter((v) => Number.isFinite(v));
  if (typeof input !== "string") return [];
  const cleaned = input.replace(/[^a-fA-F0-9]/g, "");
  const out = [];
  for (let i = 0; i + 1 < cleaned.length; i += 2) {
    out.push(parseInt(cleaned.slice(i, i + 2), 16));
  }
  return out;
}

function normalizeFrameForDecode(frame) {
  if (!frame) return null;
  const id = toNumber(frame.id ?? frame.canId ?? frame.arbitrationId);
  const pgn = toNumber(frame.pgn ?? frame.pgnId);
  const source = toNumber(frame.sa ?? frame.source ?? frame.srcAddr);
  const data = parseDataBytes(frame.data ?? frame.payload ?? frame.bytes ?? []);
  if (id == null && pgn == null && !data.length) return null;
  return { id, pgn, source, data };
}

// Extract VIN from PGN 65260 data bytes (17-char ASCII, padded with 0xFF)
function decodeVinFromBytes(bytes) {
  if (!bytes || bytes.length < 17) return null;
  let vin = "";
  for (let i = 0; i < 17; i++) {
    const b = bytes[i];
    if (b == null || b === 0xff) break;
    const c = String.fromCharCode(b);
    if (/[A-HJ-NPR-Z0-9]/i.test(c)) vin += c.toUpperCase();
  }
  return vin.length === 17 ? vin : null;
}

function decodeJ1939Frames(frames) {
  const metrics = {};
  const dtc = { active: [], pending: [] };
  const meta = { supportedSpns: [], vin: null };
  const reassembler = new J1939Reassembler();

  (frames || []).forEach((frame) => {
    if (!frame) return;
    if (frame.supportedSpns && Array.isArray(frame.supportedSpns)) {
      meta.supportedSpns = frame.supportedSpns;
    }

    // Path 0: VIN provided directly in frame object (from device firmware)
    if (frame.vin && typeof frame.vin === "string" && frame.vin.length === 17) {
      meta.vin = frame.vin.toUpperCase();
      return;
    }

    if (frame.dtcCodes && Array.isArray(frame.dtcCodes)) {
      dtc.active.push(...frame.dtcCodes);
      return;
    }

    // Path 1: already extracted SPN/value by upstream device.
    const spn = frame.spn || frame.spnId;
    if (spn != null) {
      // SPN 237 = VIN character data (text, not numeric)
      if (String(spn) === "237" && frame.vinString) {
        const vin = String(frame.vinString).trim().toUpperCase();
        if (vin.length === 17) meta.vin = vin;
        return;
      }
      const rawValue = frame.value != null ? Number(frame.value) : null;
      const decoded = decodeSpnValue(spn, rawValue);
      if (decoded) Object.assign(metrics, decoded);
      return;
    }

    // Path 2: raw CAN/J1939 frame decode.
    const normalized = normalizeFrameForDecode(frame);
    if (!normalized) return;
    const resolved = decodeFrame(normalized, reassembler);
    if (!resolved || !resolved.pgn || !Array.isArray(resolved.data)) return;

    // PGN 65260 — VIN (SPN 237)
    if (resolved.pgn === PGN_VIN) {
      const vin = decodeVinFromBytes(resolved.data);
      if (vin) meta.vin = vin;
      return;
    }

    if (resolved.pgn === 65226 || resolved.pgn === 65227) {
      const dmCodes = decodeDmDtc(resolved.data).map((item) => `SPN${item.spn}-FMI${item.fmi}`);
      dtc.active.push(...dmCodes);
      return;
    }

    const decodedSpns = decodeSpns(resolved.pgn, resolved.data);
    decodedSpns.forEach((item) => {
      const metricKey = normalizeMetricName(item.name);
      if (!metricKey || item.value == null || Number.isNaN(item.value)) return;
      metrics[metricKey] = item.value;
    });
  });

  return { metrics, dtc, meta };
}

module.exports = {
  decodeJ1939Frames,
  decodeVinFromBytes
};
