const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { gpsPositionFromSnapshot } = require("../server/routes/solutionRoutes");

const now = Date.parse("2026-08-21T12:00:00.000Z");
const live = gpsPositionFromSnapshot({
  latitude: 37.7749,
  longitude: -122.4194,
  locationCapturedAt: now - 15_000,
  locationAccuracyMeters: 8.4,
  locationSpeedMps: 10,
  locationBearingDegrees: 245
}, now);

assert(live);
assert.strictEqual(live.lat, 37.7749);
assert.strictEqual(live.lon, -122.4194);
assert.strictEqual(Number(live.speedMph.toFixed(3)), 22.369);
assert.strictEqual(live.heading, 245);
assert.strictEqual(live.accuracyMeters, 8.4);
assert.strictEqual(live.stale, false);

const historical = gpsPositionFromSnapshot({
  ts: "2026-08-21T11:55:00.000Z",
  normalizedMetrics: { vehicle: { speedKph: 80 } },
  meta: { latitude: 39.0997, longitude: -94.5786 }
}, now);
assert(historical);
assert.strictEqual(Number(historical.speedMph.toFixed(3)), 49.71);
assert.strictEqual(historical.stale, true);

assert.strictEqual(gpsPositionFromSnapshot({ latitude: 95, longitude: -94 }, now), null);
assert.strictEqual(gpsPositionFromSnapshot({ latitude: 39, longitude: -190 }, now), null);
assert.strictEqual(gpsPositionFromSnapshot({ latitude: 39, longitude: -94 }, now), null);
assert.strictEqual(gpsPositionFromSnapshot({ latitude: 0, longitude: 0, locationCapturedAt: now }, now), null);

const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
assert(/latitude:\s*normalized\.meta\?\.latitude\s*\?\?\s*extra\.meta\?\.latitude/.test(server));
assert(/locationCapturedAt:\s*normalized\.meta\?\.locationCapturedAt\s*\?\?\s*extra\.meta\?\.locationCapturedAt/.test(server));
assert(/locationAccuracyMeters:\s*normalized\.meta\?\.locationAccuracyMeters\s*\?\?\s*extra\.meta\?\.locationAccuracyMeters/.test(server));

console.log("GPS location tests passed");
