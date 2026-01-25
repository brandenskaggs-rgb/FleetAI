const FRAME_RETENTION = 20000;
const SNAPSHOT_RETENTION = 10000;

function appendFrames(data, frames) {
  data.telemetryFrames = Array.isArray(data.telemetryFrames) ? data.telemetryFrames : [];
  if (Array.isArray(frames) && frames.length) {
    data.telemetryFrames.push(...frames);
  }
  if (data.telemetryFrames.length > FRAME_RETENTION) {
    data.telemetryFrames = data.telemetryFrames.slice(-FRAME_RETENTION);
  }
}

function appendSnapshot(data, snapshot) {
  data.telemetrySnapshots = Array.isArray(data.telemetrySnapshots) ? data.telemetrySnapshots : [];
  data.telemetrySnapshots.push(snapshot);
  if (data.telemetrySnapshots.length > SNAPSHOT_RETENTION) {
    data.telemetrySnapshots = data.telemetrySnapshots.slice(-SNAPSHOT_RETENTION);
  }
}

module.exports = {
  appendFrames,
  appendSnapshot
};
