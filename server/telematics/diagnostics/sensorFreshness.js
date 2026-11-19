// Match the existing Android J1979 expiry policy, not the ML evidence window.
// Most signals expire at 30s; slow lifecycle readings have longer poll intervals.
const SLOW_INTERVALS_MS = Object.freeze({
  ethanolFuelPct: 10_000, distanceWithMilOnKm: 15_000, warmupsSinceClear: 30_000,
  distanceSinceClearKm: 15_000, milRunTimeMin: 15_000, timeSinceClearMin: 15_000,
  odometerKm: 30_000, odometerKmObd: 30_000
});

function sensorTtlMs(key) {
  return Math.min(120_000, Math.max(30_000, (SLOW_INTERVALS_MS[key] || 0) * 4));
}

function sensorAgeMs(value, elapsedMs = 0) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const age = Number(value);
  return Number.isFinite(age) && age >= 0 && Number.isFinite(elapsedMs)
    ? age + Math.max(0, elapsedMs) : null;
}

module.exports = { sensorTtlMs, sensorAgeMs, SLOW_INTERVALS_MS };
