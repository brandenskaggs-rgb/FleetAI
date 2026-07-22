/**
 * Motive fleet sync — pulls ELD devices from Motive on first connect,
 * creates/updates vehicles in the Fleet AI data store, and backfills
 * open fault codes into the ML prediction pipeline.
 *
 * Call syncFleet() once after OAuth authorization completes.
 * Call backfillFaultCodes() after syncFleet() to seed initial DTC risk scores.
 */

const motiveClient = require("./motiveClient");
const db = require("../db");

function _motiveOrgId() {
  return (process.env.MOTIVE_ORG_ID || "ORG_DEFAULT").trim();
}

/**
 * Sync all Motive vehicles into Prisma. Matches existing vehicles by motiveId
 * first, then VIN (db.upsertVehicleFromMotive). Device-level bookkeeping
 * (motiveDeviceId/Identifier/Model, metricUnits) lives in Vehicle.motiveMetadata
 * rather than dedicated columns, since Motive's exact field set is still evolving.
 * Returns { ok, created, updated, total }
 */
async function syncFleet() {
  if (!motiveClient.isConfigured()) {
    return { ok: false, error: "Motive credentials not configured (MOTIVE_ACCESS_TOKEN or MOTIVE_API_KEY)" };
  }

  let devices;
  try {
    devices = await motiveClient.fetchEldDevices();
  } catch (err) {
    return { ok: false, error: err.message };
  }

  if (!devices.length) return { ok: true, created: 0, updated: 0, total: 0 };

  const orgId = _motiveOrgId();
  let created = 0;
  let updated = 0;

  for (const device of devices) {
    const v = device.vehicle;
    if (!v || !v.id) continue;

    const { created: wasCreated } = await db.upsertVehicleFromMotive({
      motiveId: String(v.id),
      vin: v.vin || null,
      make: v.make || null,
      model: v.model || null,
      year: v.year || null,
      unitName: v.number || null,
      orgId,
      metadata: {
        motiveDeviceId: device.id != null ? String(device.id) : null,
        motiveDeviceIdentifier: device.identifier || null,
        motiveDeviceModel: device.model || null,
        metricUnits: v.metric_units ?? false
      }
    });
    if (wasCreated) created++;
    else updated++;
  }

  console.log(`[MOTIVE-SYNC] fleet sync done: created=${created} updated=${updated} total=${devices.length}`);
  return { ok: true, created, updated, total: devices.length };
}

/**
 * Backfill open fault codes for Motive vehicles.
 * Calls the Python ML service with existing DTC codes so each vehicle
 * gets an initial risk score without needing a sensor data stream.
 */
async function backfillFaultCodes(vehicles, { pythonMlClient, nowIso }) {
  if (!motiveClient.isConfigured()) return [];
  const results = [];

  for (const vehicle of vehicles) {
    if (!vehicle.motiveId) continue;
    try {
      const faultCodes = await motiveClient.fetchVehicleFaultCodes(vehicle.motiveId, { status: "open" });
      const dtcCodes = faultCodes.map((fc) => fc.code).filter(Boolean);
      if (!dtcCodes.length) continue;

      const vehicleMeta = {
        vehicleId: vehicle.vehicleId,
        vin: vehicle.vin,
        make: vehicle.make,
        model: vehicle.model,
        year: vehicle.year
      };

      let prediction = null;
      try {
        prediction = await pythonMlClient.predict({
          orgId: vehicle.orgId,
          vehicleId: vehicle.vehicleId,
          vehicleMeta,
          samples: [],
          dtcCodes
        });
      } catch (_) {}

      results.push({
        vehicleId: vehicle.vehicleId,
        dtcCount: dtcCodes.length,
        prediction: prediction?.prediction ?? null,
        riskProbability: prediction?.riskProbability ?? null
      });
      console.log(`[MOTIVE-SYNC] backfill vehicle=${vehicle.vehicleId} dtcs=[${dtcCodes.join(",")}] risk=${prediction?.riskProbability ?? "n/a"}`);
    } catch (err) {
      console.warn(`[MOTIVE-SYNC] backfill error vehicle=${vehicle.vehicleId}: ${err.message}`);
    }
  }

  return results;
}

/**
 * Resolve Fleet AI vehicleId from a Motive vehicle identifier.
 * Matches by motiveId first, then VIN. Now a Prisma lookup (db.findVehicleByMotiveIdOrVin)
 * instead of scanning the flat file's data.vehicles — callers must await this.
 */
async function resolveVehicleId(motiveVehicleId, vin) {
  const motiveIdStr = motiveVehicleId ? String(motiveVehicleId) : null;
  const vinUpper = (vin || "").trim().toUpperCase() || null;
  const match = await db.findVehicleByMotiveIdOrVin(motiveIdStr, vinUpper);
  return match?.vehicleId ?? null;
}

module.exports = { syncFleet, backfillFaultCodes, resolveVehicleId };
