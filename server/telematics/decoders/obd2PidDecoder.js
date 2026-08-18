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
  const word = bytes.length >= 2 ? (A * 256) + B : null;
  const dword = bytes.length >= 4
    ? (((bytes[0] * 0x1000000) + (bytes[1] << 16) + (bytes[2] << 8) + bytes[3]) >>> 0)
    : null;
  const percent = () => (A * 100) / 255;
  const trim = () => ((A - 128) * 100) / 128;
  const temperature = () => A - 40;
  const catalystTemperature = () => (word / 10) - 40;
  switch (pid) {
    case 0x04:
      return { engineLoadPct: percent() };
    case 0x05:
      return { coolantTempC: temperature() };
    case 0x06:
      return { shortTermFuelTrimBank1Pct: trim() };
    case 0x07:
      return { longTermFuelTrimBank1Pct: trim() };
    case 0x08:
      return { shortTermFuelTrimBank2Pct: trim() };
    case 0x09:
      return { longTermFuelTrimBank2Pct: trim() };
    case 0x0a:
      return { fuelPressureKpa: A * 3 };
    case 0x0b:
      return { mapKpa: A };
    case 0x0c:
      return { rpm: word / 4 };
    case 0x0d:
      return { speedKph: A };
    case 0x0e:
      return { ignitionTimingAdvanceDeg: (A / 2) - 64 };
    case 0x0f:
      return { intakeAirTempC: temperature() };
    case 0x10:
      return { mafGramsPerSec: word / 100 };
    case 0x11:
      return { throttlePosPct: percent() };
    case 0x14:
      return { o2B1S1VoltageV: A / 200 };
    case 0x15:
      return { o2B1S2VoltageV: A / 200 };
    case 0x18:
      return { o2B2S1VoltageV: A / 200 };
    case 0x19:
      return { o2B2S2VoltageV: A / 200 };
    case 0x1f:
      return { engineRunTimeSec: word };
    case 0x21:
      return { distanceWithMilOnKm: word };
    case 0x22:
      return { fuelRailPressureRelativeKpa: word * 0.079 };
    case 0x23:
      return { fuelRailGaugePressureKpa: word * 10 };
    case 0x2c:
      return { commandedEgrPct: percent() };
    case 0x2d:
      return { egrErrorPct: trim() };
    case 0x2e:
      return { commandedEvapPurgePct: percent() };
    case 0x2f:
      return { fuelLevelPct: percent() };
    case 0x30:
      return { warmupsSinceClear: A };
    case 0x31:
      return { distanceSinceClearKm: word };
    case 0x32:
      return { evapSystemVaporPressurePa: (word / 4) - 8192 };
    case 0x33:
      return { barometricPressureKpa: A };
    case 0x3c:
      return { catalystTempB1S1C: catalystTemperature() };
    case 0x3d:
      return { catalystTempB2S1C: catalystTemperature() };
    case 0x3e:
      return { catalystTempB1S2C: catalystTemperature() };
    case 0x3f:
      return { catalystTempB2S2C: catalystTemperature() };
    case 0x42:
      return { batteryVoltageV: word / 1000 };
    case 0x43:
      return { absoluteLoadPct: (word * 100) / 255 };
    case 0x44:
      return { commandedEquivalenceRatio: (word * 2) / 65536 };
    case 0x45:
      return { relativeThrottlePosPct: percent() };
    case 0x46:
      return { ambientTempC: temperature() };
    case 0x47:
      return { absoluteThrottleBPosPct: percent() };
    case 0x48:
      return { absoluteThrottleCPosPct: percent() };
    case 0x49:
      return { acceleratorPedalDPosPct: percent() };
    case 0x4a:
      return { acceleratorPedalEPosPct: percent() };
    case 0x4b:
      return { acceleratorPedalFPosPct: percent() };
    case 0x4c:
      return { commandedThrottleActuatorPct: percent() };
    case 0x4d:
      return { milRunTimeMin: word };
    case 0x4e:
      return { timeSinceClearMin: word };
    case 0x52:
      return { ethanolFuelPct: percent() };
    case 0x53:
      return { absoluteEvapVaporPressureKpa: word / 200 };
    case 0x54:
      return { evapSystemVaporPressureWidePa: word - 32767 };
    case 0x59:
      return { fuelRailAbsolutePressureKpa: word * 10 };
    case 0x5a:
      return { relativeAcceleratorPedalPct: percent() };
    case 0x5b:
      return { hybridBatteryRemainingPct: percent() };
    case 0x5c:
      return { oilTempC: temperature() };
    case 0x5d:
      return { fuelInjectionTimingDeg: (word / 128) - 210 };
    case 0x5e:
      return { fuelRateLph: word * 0.05 };
    case 0x61:
      return { driverDemandTorquePct: A - 125 };
    case 0x62:
      return { actualTorquePct: A - 125 };
    case 0x63:
      return { referenceTorqueNm: word };
    case 0xa6:
      return { odometerKm: dword / 10 };
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
