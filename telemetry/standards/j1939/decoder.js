const { SPN_CATALOG } = require("./spnCatalog");

function extractPgn(canId) {
  const pf = (canId >> 16) & 0xff;
  const ps = (canId >> 8) & 0xff;
  const dp = (canId >> 24) & 0x01;
  let pgn;
  if (pf < 240) {
    pgn = (dp << 16) | (pf << 8);
  } else {
    pgn = (dp << 16) | (pf << 8) | ps;
  }
  return pgn;
}

function bytesToInt(bytes) {
  let value = 0;
  for (let i = bytes.length - 1; i >= 0; i -= 1) {
    value = (value << 8) + bytes[i];
  }
  return value;
}

function decodeSpns(pgn, data) {
  const items = SPN_CATALOG[pgn];
  if (!items) return [];
  const out = [];
  for (const spn of items) {
    const slice = data.slice(spn.start, spn.start + spn.length);
    if (slice.length < spn.length) continue;
    const raw = bytesToInt(slice);
    const value = raw === (Math.pow(2, spn.length * 8) - 1) ? null : raw * spn.scale + spn.offset;
    out.push({ spn: spn.spn, name: spn.name, value, unit: spn.unit });
  }
  return out;
}

function decodeDmDtc(data) {
  const dtcs = [];
  for (let i = 2; i + 3 < data.length; i += 4) {
    const b0 = data[i];
    const b1 = data[i + 1];
    const b2 = data[i + 2];
    const spn = ((b1 & 0xe0) << 11) | (b2 << 8) | b0;
    const fmi = b1 & 0x1f;
    const oc = b2 >> 5;
    dtcs.push({ spn, fmi, oc });
  }
  return dtcs;
}

class J1939Reassembler {
  constructor() {
    this.sessions = new Map();
  }

  handleTpCm(frame) {
    const data = frame.data || [];
    const control = data[0];
    const totalBytes = data[1] | (data[2] << 8);
    const totalPackets = data[3];
    const pgn = data[5] | (data[6] << 8) | (data[7] << 16);
    const key = `${frame.source}-${pgn}`;
    if (control === 0x20 || control === 0x10) {
      this.sessions.set(key, {
        pgn,
        totalBytes,
        totalPackets,
        packets: new Array(totalPackets),
        received: 0
      });
    }
  }

  handleTpDt(frame) {
    const data = frame.data || [];
    const seq = data[0];
    const payload = data.slice(1);
    for (const [key, session] of this.sessions.entries()) {
      if (!session) continue;
      if (seq >= 1 && seq <= session.totalPackets) {
        session.packets[seq - 1] = payload;
        session.received += 1;
        if (session.received >= session.totalPackets) {
          const bytes = session.packets.flat().slice(0, session.totalBytes);
          this.sessions.delete(key);
          return { pgn: session.pgn, data: bytes };
        }
      }
    }
    return null;
  }
}

function decodeFrame(frame, reassembler) {
  const canId = frame.id;
  const pgn = frame.pgn || extractPgn(canId);
  const data = frame.data || [];
  if (pgn === 60416) {
    reassembler.handleTpCm({ data, source: frame.source || 0 });
    return null;
  }
  if (pgn === 60160) {
    return reassembler.handleTpDt({ data, source: frame.source || 0 });
  }
  return { pgn, data };
}

module.exports = {
  extractPgn,
  decodeSpns,
  decodeDmDtc,
  J1939Reassembler,
  decodeFrame
};
