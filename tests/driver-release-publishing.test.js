const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const express = require("express");
const { availableDriverRelease } = require("../server/services/availableDriverRelease");
const { registerDriverAppRoutes } = require("../server/routes/driverAppRoutes");

test("packaged pilot metadata requires the exact APK, size and checksum", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fleetai-release-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bytes = Buffer.from("test fixture, not a real APK");
  const manifest = { channel: "pilot-debug", versionCode: 19, versionName: "1.10.7", filename: "fleetai-19.apk",
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length };
  const save = data => fs.writeFileSync(path.join(directory, "pilot.json"), JSON.stringify(data));
  save(manifest);
  assert.equal(availableDriverRelease("pilot-debug", {}, directory), null);
  fs.writeFileSync(path.join(directory, manifest.filename), bytes);
  assert.equal(availableDriverRelease("pilot-debug", {}, directory).release.versionCode, 19);
  for (const edit of [{ filename: "../bad.apk" }, { sha256: "0".repeat(64) }, { sha256: undefined }, { sizeBytes: 0 }, { versionCode: "19" }, { channel: "play" }]) {
    save({ ...manifest, ...edit }); assert.equal(availableDriverRelease("pilot-debug", {}, directory), null);
  }
  save(manifest);
  fs.writeFileSync(path.join(directory, manifest.filename), Buffer.alloc(bytes.length, 1));
  assert.equal(availableDriverRelease("pilot-debug", {}, directory), null, "changed bytes cannot use a prior hash cache entry");
});

test("operator configuration overrides packaged artifacts and never advertises missing files", () => {
  assert.equal(availableDriverRelease("pilot-debug", { FLEETAI_DRIVER_PILOT_DEBUG_VERSION_CODE: "99" }), null);
  assert.equal(availableDriverRelease("pilot-debug", {
    FLEETAI_DRIVER_PILOT_DEBUG_VERSION_CODE: "99", FLEETAI_DRIVER_PILOT_DEBUG_VERSION_NAME: "9.9.9",
    FLEETAI_DRIVER_PILOT_DEBUG_URL: "https://fleetaiops.com/downloads/driver/missing.apk",
    FLEETAI_DRIVER_RELEASE_DIR: __dirname
  }), null);
  assert.equal(availableDriverRelease("play", {}), null, "a pilot APK is not a Play release");
  assert.equal(availableDriverRelease("unknown", {}), null);
});

test("committed APK metadata matches the Android build version", () => {
  const result = availableDriverRelease("pilot-debug", {});
  assert.ok(result, "packaged APK and verified metadata are required to publish");
  const gradle = fs.readFileSync(path.join(__dirname, "../driver_app/app/build.gradle"), "utf8");
  assert.match(gradle, new RegExp(`versionCode ${result.release.versionCode}\\b`));
  assert.ok(gradle.includes(`versionName "${result.release.versionName}"`));
  assert.ok(result.release.versionCode > 18, "installed 1.10.6 must detect a newer version");
});

test("public release/download routes serve only the advertised APK without touching pairing", async t => {
  const old = {};
  for (const key of Object.keys(process.env).filter(key => key.startsWith("FLEETAI_DRIVER_PILOT_DEBUG_"))) {
    old[key] = process.env[key]; delete process.env[key];
  }
  t.after(() => Object.assign(process.env, old));
  const app = express();
  registerDriverAppRoutes(app, { sanitizeString: String, nowIso: () => new Date().toISOString() });
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const metadataResponse = await fetch(origin + "/api/driver/releases/latest?channel=pilot-debug");
  assert.equal(metadataResponse.headers.get("cache-control"), "no-store");
  const { release } = await metadataResponse.json();
  assert.equal(release.versionCode, 19);
  const apk = await fetch(origin + new URL(release.url).pathname);
  assert.equal(apk.status, 200);
  assert.match(apk.headers.get("content-disposition"), /fleetai-19\.apk/);
  const bytes = Buffer.from(await apk.arrayBuffer());
  assert.equal(bytes.length, release.sizeBytes);
  assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), release.sha256);
  assert.equal((await fetch(origin + "/downloads/driver/pilot.json")).status, 404);
  assert.equal((await fetch(origin + "/downloads/driver/fleetai-18.apk")).status, 404);
});
