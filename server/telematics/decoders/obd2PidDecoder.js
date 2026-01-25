function parseHexBytes(text) {
  if (!text) return [];
  const cleaned = text.replace(/[^a-fA-F0-9]/g, "");
  const bytes = [];
  for (let i = 0; i < cleaned.length; i += 2) {
    const chunk = cleaned.slice(i, i + 2);
    if (chunk.length === 2) bytes.push(parseInt(chunk, 16));
  }
  return bytes;
}

function parseDtcBytes(bytes) {
  const dtcs = [];
  for (let i = 0; i < bytes.length; i += 2) {
    const a = bytes[i];
    const b = bytes[i + 1];
    if (a === 0 && b === 0) continue;
    const first = (a & 0xc0) >> 6;
    const system = ["P", "C", "B", "U"][first] || "P";
    const code = `${system}${((a & 0x3f) << 8 | b).toString(16).padStart(4, "0").toUpperCase()}`;
    dtcs.push(code);
  }
  return dtcs;
}

function decodePid(pid, bytes) {
  if (!bytes || bytes.length === 0) return null;
  const A = bytes[0];
  const B = bytes[1];
  switch (pid) {
    case 0x0c:
      return { rpm: ((A * 256) + B) / 4 };
    case 0x0d:
      return { speedKph: A };
    case 0x05:
      return { coolantTempC: A - 40 };
    case 0x0f:
      return { intakeAirTempC: A - 40 };
    case 0x10:
      return { mafGramsPerSec: ((A * 256) + B) / 100 };
    case 0x04:
      return { engineLoadPct: (A * 100) / 255 };
    case 0x11:
      return { throttlePosPct: (A * 100) / 255 };
    case 0x2f:
      return { fuelLevelPct: (A * 100) / 255 };
    case 0x5c:
      return { oilTempC: A - 40 };
    case 0x42:
      return { batteryVoltageV: ((A * 256) + B) / 1000 };
    case 0x31:
      return { distanceSinceDtcClearKm: (A * 256) + B };
    case 0x1f:
      return { runTimeSinceEngineStartSec: (A * 256) + B };
    default:
      return null;
  }
}

function decodeObd2Frames(frames) {
  const metrics = {};
  const dtc = { active: [], pending: [] };
  const meta = { supportedPids: [] };

  frames.forEach((frame) => {
    if (!frame) return;
    const mode = Number(frame.mode || frame.service || frame.modeId);
    const pid = frame.pid != null ? Number(frame.pid) : null;
    const bytes = Array.isArray(frame.data) ? frame.data : parseHexBytes(frame.payload);

    if (frame.supportedPids && Array.isArray(frame.supportedPids)) {
      meta.supportedPids = frame.supportedPids;
    }

    if (mode === 3 || mode === 7) {
      const codes = frame.dtcCodes || parseDtcBytes(bytes);
      if (mode === 3) dtc.active.push(...codes);
      if (mode === 7) dtc.pending.push(...codes);
      return;
    }

    if (!pid) return;
    const decoded = decodePid(pid, bytes);
    if (decoded) Object.assign(metrics, decoded);
  });

  return { metrics, dtc, meta };
}

module.exports = {
  decodeObd2Frames
};
