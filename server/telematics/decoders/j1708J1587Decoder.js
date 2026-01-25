const J1708_PID_MAP = {
  190: { metric: "rpm", scale: 0.25, offset: 0 },
  84: { metric: "speedKph", scale: 0.5, offset: 0 },
  110: { metric: "coolantTempC", scale: 1, offset: -40 },
  158: { metric: "batteryVoltageV", scale: 0.05, offset: 0 },
  247: { metric: "engineHours", scale: 0.05, offset: 0 },
  183: { metric: "fuelRateLph", scale: 0.05, offset: 0 }
};

function decodeJ1708Frames(frames) {
  const metrics = {};
  const dtc = { active: [], pending: [] };
  const meta = {};

  frames.forEach((frame) => {
    if (!frame) return;
    if (frame.dtcCodes && Array.isArray(frame.dtcCodes)) {
      dtc.active.push(...frame.dtcCodes);
      return;
    }
    const pid = frame.pid || frame.pidId;
    if (!pid) return;
    const entry = J1708_PID_MAP[Number(pid)];
    if (!entry) return;
    const rawValue = frame.value != null ? Number(frame.value) : null;
    if (rawValue == null) return;
    metrics[entry.metric] = rawValue * entry.scale + entry.offset;
  });

  return { metrics, dtc, meta };
}

module.exports = {
  decodeJ1708Frames
};
