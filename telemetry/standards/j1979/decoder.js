const { PID_CATALOG } = require("./pidCatalog");

function bytesToInt(bytes) {
  let out = 0;
  for (const b of bytes) {
    out = (out << 8) + b;
  }
  return out;
}

function decodePid(pid, data) {
  const entry = PID_CATALOG[pid];
  if (!entry) return null;
  const bytes = data.slice(0, entry.bytes);
  switch (pid) {
    case "0C": {
      const v = bytesToInt(bytes);
      return { key: entry.name, value: v / 4, unit: entry.unit };
    }
    case "0D":
      return { key: entry.name, value: bytes[0], unit: entry.unit };
    case "05":
      return { key: entry.name, value: bytes[0] - 40, unit: entry.unit };
    case "2F":
      return { key: entry.name, value: (bytes[0] * 100) / 255, unit: entry.unit };
    case "11":
      return { key: entry.name, value: (bytes[0] * 100) / 255, unit: entry.unit };
    case "42": {
      const v = bytesToInt(bytes);
      return { key: entry.name, value: v / 1000, unit: entry.unit };
    }
    case "5C":
      return { key: entry.name, value: bytes[0] - 40, unit: entry.unit };
    case "1F":
      return { key: entry.name, value: bytesToInt(bytes), unit: entry.unit };
    case "31":
      return { key: entry.name, value: bytesToInt(bytes), unit: entry.unit };
    case "A6":
      return { key: entry.name, value: bytesToInt(bytes), unit: entry.unit };
    default:
      return null;
  }
}

function decodeDtcBytes(bytes) {
  const dtcs = [];
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const a = bytes[i];
    const b = bytes[i + 1];
    if (a === 0 && b === 0) continue;
    const type = ["P", "C", "B", "U"][(a & 0xC0) >> 6];
    const code = ((a & 0x3F) << 8) | b;
    dtcs.push(`${type}${code.toString(16).toUpperCase().padStart(4, "0")}`);
  }
  return dtcs;
}

function decodeVin(bytes) {
  const chars = bytes.map((b) => String.fromCharCode(b)).join("");
  return chars.replace(/\0/g, "").trim();
}

module.exports = {
  decodePid,
  decodeDtcBytes,
  decodeVin
};
