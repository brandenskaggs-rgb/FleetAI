const fs = require("fs");
const path = require("path");
const { TelemetryManager } = require("./telemetryManager");
const J1939Adapter = require("./adapters/J1939Adapter");
const ELM327Adapter = require("./adapters/ELM327Adapter");

function usage() {
  console.log("Usage: node telemetry/replayHarness.js <frames.json> [output.json]");
}

function loadFrames(filePath) {
  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw);
}

function run() {
  const input = process.argv[2];
  const output = process.argv[3];
  if (!input) {
    usage();
    process.exit(1);
  }
  const frames = loadFrames(path.resolve(input));
  const manager = new TelemetryManager({ vehicleId: "REPLAY", deviceId: "REPLAY", vehicleClass: "heavy" });
  manager.registerAdapter(new J1939Adapter());
  manager.registerAdapter(new ELM327Adapter());
  const snapshots = [];

  frames.forEach((frame) => {
    const snap = manager.handleFrame(frame);
    snapshots.push({ ts: frame.ts || new Date().toISOString(), telemetry: snap });
  });

  if (output) {
    fs.writeFileSync(path.resolve(output), JSON.stringify(snapshots, null, 2));
    console.log(`Wrote ${snapshots.length} snapshots to ${output}`);
  } else {
    console.log(JSON.stringify(snapshots, null, 2));
  }
}

run();
