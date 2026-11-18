const PLAY_URL = "https://play.google.com/store/apps/details?id=com.fleetai.driver";

function driverRelease(channel, env = process.env) {
  if (!["play", "pilot-debug"].includes(channel)) return null;
  const prefix = channel === "play" ? "FLEETAI_DRIVER_PLAY" : "FLEETAI_DRIVER_PILOT_DEBUG";
  const versionCode = Number(env[`${prefix}_VERSION_CODE`]);
  const versionName = env[`${prefix}_VERSION_NAME`];
  if (!Number.isSafeInteger(versionCode) || versionCode <= 0 || typeof versionName !== "string" || !/^[\w.+-]{1,40}$/.test(versionName)) return null;
  let url = PLAY_URL;
  if (channel === "pilot-debug") {
    try {
      const parsed = new URL(env[`${prefix}_URL`]);
      if (parsed.origin !== "https://fleetaiops.com" || !/^\/downloads\/driver\/[a-zA-Z0-9._-]+\.apk$/.test(parsed.pathname) || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
      url = parsed.href;
    } catch (_) { return null; }
  }
  return { channel, versionCode, versionName, url,
    notes: String(env[`${prefix}_NOTES`] || "Update while parked. Keep Fleet AI installed to preserve your pairing.").slice(0, 500) };
}

module.exports = { driverRelease, PLAY_URL };
