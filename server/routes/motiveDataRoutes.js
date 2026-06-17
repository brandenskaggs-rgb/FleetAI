/**
 * Motive-powered data routes
 *
 *   GET /api/fuel/events        — fuel purchases per vehicle
 *   GET /api/fuel-events        — alias
 *   GET /api/cost-analytics     — per-vehicle fuel cost summary
 *   GET /api/driver-scores      — driver leaderboard from idle events
 */

const motiveClient = require("../services/motiveClient");

function registerMotiveDataRoutes(app, { requireEmployeeOrCustomerApi, readData, sanitizeString }) {

  // ── Fuel Events ─────────────────────────────────────────────────────────────
  async function handleFuelEvents(req, res) {
    const vehicleId = sanitizeString(req.query.vehicleId || req.query.vehicle_id || "", 80);
    if (!motiveClient.isConfigured()) {
      return res.json({ ok: true, data: [] });
    }
    try {
      const params = {};
      if (vehicleId) params.vehicle_ids = vehicleId;
      const purchases = await motiveClient.getFuelPurchases(params);
      const data = purchases.map((p) => ({
        date: p.purchased_at || null,
        vehicleId: String(p.vehicle?.id || vehicleId || ""),
        vehicleName: p.vehicle?.number || p.vehicle?.vin || vehicleId || "--",
        gallons: p.fuel || 0,
        cost: p.total_cost || 0,
        location: p.vendor || p.jurisdiction || "Unknown"
      }));
      return res.json({ ok: true, data });
    } catch (err) {
      console.warn("[MOTIVE-DATA] fuel events error:", err.message);
      return res.json({ ok: true, data: [] });
    }
  }

  app.get("/api/fuel/events", requireEmployeeOrCustomerApi, handleFuelEvents);
  app.get("/api/fuel-events", requireEmployeeOrCustomerApi, handleFuelEvents);

  // ── Cost Analytics ──────────────────────────────────────────────────────────
  app.get("/api/cost-analytics", requireEmployeeOrCustomerApi, async (req, res) => {
    if (!motiveClient.isConfigured()) {
      return res.json({ ok: true, data: [] });
    }
    try {
      const [purchases, localData] = await Promise.all([
        motiveClient.getFuelPurchases(),
        readData()
      ]);

      const localVehicles = Array.isArray(localData.vehicles) ? localData.vehicles : [];

      // Aggregate fuel cost per Motive vehicle ID
      const byVehicle = new Map();
      for (const p of purchases) {
        const vid = String(p.vehicle?.id || "unknown");
        if (!byVehicle.has(vid)) {
          byVehicle.set(vid, {
            motiveVehicleId: vid,
            vehicleName: p.vehicle?.number || p.vehicle?.vin || vid,
            fuelCost: 0,
            gallons: 0,
            purchases: 0
          });
        }
        const entry = byVehicle.get(vid);
        entry.fuelCost += Number(p.total_cost || 0);
        entry.gallons += Number(p.fuel || 0);
        entry.purchases++;
      }

      const data = Array.from(byVehicle.values()).map((v) => {
        // Try to match to local vehicle for Fleet AI vehicleId
        const local = localVehicles.find((lv) => lv.motiveId === v.motiveVehicleId);
        return {
          vehicleId: local?.vehicleId || v.motiveVehicleId,
          vehicleName: local?.unitName || v.vehicleName,
          fuelCost: Math.round(v.fuelCost * 100) / 100,
          maintCost: 0,
          totalCost: Math.round(v.fuelCost * 100) / 100,
          costPerMile: 0,
          costPerDay: v.purchases > 0 ? Math.round((v.fuelCost / 30) * 100) / 100 : 0
        };
      }).sort((a, b) => b.totalCost - a.totalCost);

      return res.json({ ok: true, data });
    } catch (err) {
      console.warn("[MOTIVE-DATA] cost analytics error:", err.message);
      return res.json({ ok: true, data: [] });
    }
  });

  // ── Driver Scores ───────────────────────────────────────────────────────────
  app.get("/api/driver-scores", requireEmployeeOrCustomerApi, async (req, res) => {
    if (!motiveClient.isConfigured()) {
      return res.json({ ok: true, data: [] });
    }
    try {
      const now = new Date();
      const start = new Date(now);
      start.setDate(start.getDate() - 30);

      const idleEvents = await motiveClient.getIdleEvents({
        start_date: start.toISOString().slice(0, 10),
        end_date: now.toISOString().slice(0, 10)
      });

      // Aggregate idle minutes per driver
      const byDriver = new Map();
      for (const evt of idleEvents) {
        const driverId = String(evt.driver?.id || "unknown");
        if (!byDriver.has(driverId)) {
          byDriver.set(driverId, {
            driverId,
            driverName: evt.driver
              ? `${evt.driver.first_name || ""} ${evt.driver.last_name || ""}`.trim()
              : "Unknown Driver",
            idleMinutes: 0,
            events: 0
          });
        }
        const entry = byDriver.get(driverId);
        const start_t = evt.start_time ? new Date(evt.start_time) : null;
        const end_t = evt.end_time ? new Date(evt.end_time) : null;
        if (start_t && end_t) {
          entry.idleMinutes += Math.round((end_t - start_t) / 60000);
        }
        entry.events++;
      }

      const data = Array.from(byDriver.values()).map((d) => {
        // Score 0-100: penalise 1 point per 10 idle minutes, floor at 0
        const idlePenalty = Math.min(100, Math.floor(d.idleMinutes / 10));
        const score = Math.max(0, 100 - idlePenalty);
        return {
          driverId: d.driverId,
          driverName: d.driverName,
          score,
          idleScore: d.idleMinutes,
          brakingScore: 0,
          speedScore: 0,
          incidents: d.events
        };
      }).sort((a, b) => b.score - a.score);

      return res.json({ ok: true, data });
    } catch (err) {
      console.warn("[MOTIVE-DATA] driver scores error:", err.message);
      return res.json({ ok: true, data: [] });
    }
  });
}

module.exports = { registerMotiveDataRoutes };
