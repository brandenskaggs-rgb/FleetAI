const spnMap = require("./j1939_spn_map.json");

function decodeSpnValue(spn, rawValue) {
  const entry = spnMap[String(spn)];
  if (!entry || rawValue == null) return null;
  if (entry.metric === "regenActive") {
    return { [entry.metric]: Boolean(rawValue) };
  }
  const scaled = rawValue * entry.scale + entry.offset;
  return { [entry.metric]: scaled };
}

function decodeJ1939Frames(frames) {
  const metrics = {};
  const dtc = { active: [], pending: [] };
  const meta = { supportedSpns: [] };

  frames.forEach((frame) => {
    if (!frame) return;
    if (frame.supportedSpns && Array.isArray(frame.supportedSpns)) {
      meta.supportedSpns = frame.supportedSpns;
    }
    if (frame.dtcCodes && Array.isArray(frame.dtcCodes)) {
      dtc.active.push(...frame.dtcCodes);
      return;
    }
    const spn = frame.spn || frame.spnId;
    if (!spn) return;
    const rawValue = frame.value != null ? Number(frame.value) : null;
    const decoded = decodeSpnValue(spn, rawValue);
    if (decoded) Object.assign(metrics, decoded);
  });

  return { metrics, dtc, meta };
}

module.exports = {
  decodeJ1939Frames
};
