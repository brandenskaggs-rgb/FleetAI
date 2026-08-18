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
  if (bytes.length < entry.bytes) return null;
  const A = bytes[0];
  const word = bytes.length >= 2 ? bytesToInt(bytes.slice(0, 2)) : null;
  const percent = () => (A * 100) / 255;
  const trim = () => ((A - 128) * 100) / 128;
  let value = null;
  switch (pid) {
    case "04": case "11": case "2C": case "2E": case "2F": case "45":
    case "47": case "48": case "49": case "4A": case "4B": case "4C":
    case "52": case "5A": case "5B": value = percent(); break;
    case "05": case "0F": case "46": case "5C": value = A - 40; break;
    case "06": case "07": case "08": case "09": case "2D": value = trim(); break;
    case "0A": value = A * 3; break;
    case "0B": case "0D": case "30": case "33": value = A; break;
    case "0C": value = word / 4; break;
    case "0E": value = (A / 2) - 64; break;
    case "10": value = word / 100; break;
    case "14": case "15": case "18": case "19": value = A / 200; break;
    case "1F": case "21": case "31": case "4D": case "4E": case "63": value = word; break;
    case "22": value = word * 0.079; break;
    case "23": case "59": value = word * 10; break;
    case "32": value = (word / 4) - 8192; break;
    case "3C": case "3D": case "3E": case "3F": value = (word / 10) - 40; break;
    case "42": value = word / 1000; break;
    case "43": value = (word * 100) / 255; break;
    case "44": value = (word * 2) / 65536; break;
    case "53": value = word / 200; break;
    case "54": value = word - 32767; break;
    case "5D": value = (word / 128) - 210; break;
    case "5E": value = word * 0.05; break;
    case "61": case "62": value = A - 125; break;
    case "A6": value = bytesToInt(bytes) / 10; break;
    default:
      return null;
  }
  return Number.isFinite(value) ? { key: entry.name, value, unit: entry.unit } : null;
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
