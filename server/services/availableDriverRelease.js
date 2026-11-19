const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { driverRelease } = require("./driverRelease");

const PACKAGED_DIRECTORY = path.resolve(__dirname, "../../releases/driver");
const verified = new Map();

function verifiedFile(filename, sha256, sizeBytes) {
  try {
    const stat = fs.statSync(filename);
    if (!stat.isFile() || stat.size <= 0) return false;
    if (sha256 === undefined) return true; // Existing operator-managed volume releases.
    if (!/^[a-f0-9]{64}$/.test(sha256) || !Number.isSafeInteger(sizeBytes) || stat.size !== sizeBytes) return false;
    const identity = `${sha256}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    if (verified.get(filename) === identity) return true;
    if (crypto.createHash("sha256").update(fs.readFileSync(filename)).digest("hex") !== sha256) return false;
    verified.set(filename, identity);
    return true;
  } catch (_) { return false; }
}

function availableDriverRelease(channel, env = process.env, packagedDirectory = PACKAGED_DIRECTORY) {
  if (channel === "play") {
    const release = driverRelease(channel, env);
    return release ? { release, file: null } : null;
  }
  if (channel !== "pilot-debug") return null;
  // Explicit configuration wins, including invalid/incomplete configurations.
  // Never silently publish a bundled version when an operator configured another.
  if (Object.keys(env).some(key => key.startsWith("FLEETAI_DRIVER_PILOT_DEBUG_"))) {
    const release = driverRelease(channel, env);
    const directory = env.FLEETAI_DRIVER_RELEASE_DIR;
    if (!release || !directory || !path.isAbsolute(directory)) return null;
    const file = path.join(directory, path.basename(new URL(release.url).pathname));
    return verifiedFile(file) ? { release, file } : null;
  }
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(packagedDirectory, "pilot.json"), "utf8"));
    if (manifest.channel !== channel || !/^[a-f0-9]{64}$/.test(manifest.sha256 || "") ||
        !Number.isSafeInteger(manifest.sizeBytes) || manifest.sizeBytes <= 0 ||
        !Number.isSafeInteger(manifest.versionCode) || manifest.versionCode <= 0 ||
        manifest.filename !== `fleetai-${manifest.versionCode}.apk`) return null;
    const release = driverRelease(channel, {
      FLEETAI_DRIVER_PILOT_DEBUG_VERSION_CODE: manifest.versionCode,
      FLEETAI_DRIVER_PILOT_DEBUG_VERSION_NAME: manifest.versionName,
      FLEETAI_DRIVER_PILOT_DEBUG_URL: `https://fleetaiops.com/downloads/driver/${manifest.filename}`,
      FLEETAI_DRIVER_PILOT_DEBUG_NOTES: manifest.notes
    });
    const file = path.join(packagedDirectory, manifest.filename);
    if (!release || !verifiedFile(file, manifest.sha256, manifest.sizeBytes)) return null;
    return { release: { ...release, sha256: manifest.sha256, sizeBytes: manifest.sizeBytes }, file };
  } catch (_) { return null; }
}

module.exports = { availableDriverRelease };
