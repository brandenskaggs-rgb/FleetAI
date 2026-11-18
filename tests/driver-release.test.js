const { test } = require("node:test");
const assert = require("node:assert/strict");
const { driverRelease, PLAY_URL } = require("../server/services/driverRelease");

test("unpublished/invalid channels advertise no release", () => {
  assert.equal(driverRelease("play", {}), null);
  assert.equal(driverRelease("arbitrary", {}), null);
  assert.equal(driverRelease("play", { FLEETAI_DRIVER_PLAY_VERSION_CODE: "NaN", FLEETAI_DRIVER_PLAY_VERSION_NAME: "1.0" }), null);
});
test("Play builds only get the official Play URL", () => {
  const release = driverRelease("play", { FLEETAI_DRIVER_PLAY_VERSION_CODE: "18", FLEETAI_DRIVER_PLAY_VERSION_NAME: "1.10.6", FLEETAI_DRIVER_PLAY_URL: "https://evil.example/update.apk" });
  assert.equal(release.url, PLAY_URL);
});
test("pilot releases reject untrusted hosts, credentials, query strings, and path traversal", () => {
  const env = { FLEETAI_DRIVER_PILOT_DEBUG_VERSION_CODE: "18", FLEETAI_DRIVER_PILOT_DEBUG_VERSION_NAME: "1.10.6" };
  for (const url of ["http://fleetaiops.com/downloads/driver/a.apk", "https://evil.example/a.apk", "https://fleetaiops.com.evil.example/downloads/driver/a.apk", "https://user@fleetaiops.com/downloads/driver/a.apk", "https://fleetaiops.com/downloads/driver/a.apk?redirect=evil", "https://fleetaiops.com/downloads/driver/../a.apk"]) {
    assert.equal(driverRelease("pilot-debug", { ...env, FLEETAI_DRIVER_PILOT_DEBUG_URL: url }), null, url);
  }
  assert.ok(driverRelease("pilot-debug", { ...env, FLEETAI_DRIVER_PILOT_DEBUG_URL: "https://fleetaiops.com/downloads/driver/fleetai-18.apk" }));
});
