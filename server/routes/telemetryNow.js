const express = require("express");
const router = express.Router();
const { telemetryLatest } = require("../state/telemetryState");

router.get("/", (req, res) => {
  const now = Date.now();
  let snap = null;
  telemetryLatest.forEach((s) => {
    if (!snap) snap = s;
    else {
      const a = new Date(snap.ts || snap.timestamp || 0).getTime();
      const b = new Date(s.ts || s.timestamp || 0).getTime();
      if (b > a) snap = s;
    }
  });
  const ts = snap ? new Date(snap.ts || snap.timestamp || 0).getTime() : 0;
  const ageMs = ts ? now - ts : null;
  const status = ageMs === null ? "disconnected" : ageMs <= 3000 ? "connected" : ageMs <= 15000 ? "stale" : "disconnected";
  res.set({
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    Pragma: "no-cache",
    Expires: "0",
    "Surrogate-Control": "no-store",
    "Content-Type": "application/json"
  });
  res.json({
    ok: true,
    now: new Date(now).toISOString(),
    vehicleId: snap ? snap.vehicleId || null : null,
    driverId: snap ? snap.driverId || null : null,
    source: snap?.meta?.source || "live",
    lastSampleAt: ts ? new Date(ts).toISOString() : null,
    ageMs,
    status,
    keys: snap && snap.metrics ? Object.keys(snap.metrics || {}).filter((k) => snap.metrics[k] != null) : [],
    snapshot: snap || {}
  });
});

module.exports = router;
