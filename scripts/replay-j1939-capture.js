const fs = require("fs");
const path = require("path");
const { prepareTelemetryIngest } = require("../server/telematics/ingest/prepareTelemetryIngest");

const capturePath = path.resolve(process.argv[2] || path.join(__dirname, "..", "tests", "fixtures", "j1939-capture.json"));
const capture = JSON.parse(fs.readFileSync(capturePath, "utf8"));
const prepared = prepareTelemetryIngest(capture, {
  timestamp: capture.timestamp,
  nowEpochMs: Date.parse(capture.timestamp) + 1_000,
  orgId: capture.orgId || "REPLAY_ORG",
  vehicleId: capture.vehicleId || "REPLAY_VEHICLE"
});

const summary = {
  file: path.basename(capturePath),
  protocol: prepared.adapter.protocol,
  bitrate: prepared.capture.bitrate,
  frameCount: prepared.quality.frameCount,
  uniquePgnCount: prepared.quality.uniquePgnCount,
  uniqueSourceCount: prepared.quality.uniqueSourceCount,
  decodedMetrics: Object.keys(prepared.decoded.metrics || {}).sort(),
  activeDtcCount: prepared.decoded.dtc?.active?.length || 0
};

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
if (summary.protocol !== "J1939" || summary.frameCount === 0 || summary.decodedMetrics.length === 0) process.exit(1);
