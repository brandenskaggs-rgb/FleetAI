/**
 * Motive fleet sync — pulls ELD devices from Motive on first connect,
 * creates/updates vehicles in the Fleet AI data store, and backfills
 * open fault codes into the ML prediction pipeline.
 *
 * Call syncFleet() once after OAuth authorization completes.
 * Call backfillFaultCodes() after syncFleet() to seed initial DTC risk scores.
 */

const motiveClient = require("./motiveClient");

function _motiveOrgId() {
  return (process.env.MOTIVE_ORG_ID || "ORG_DEFAULT").trim();
}

/**
 * Sync all Motive vehicles into the Fleet AI data store.
 * Matches existing vehicles by motiveId first, then VIN.
 * Returns { ok, created, updated, total }
 */
async function syncFleet({ readData, writeData, makeId, nowIso }) {
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

  const data = await readData();
  if (!Array.isArray(data.vehicles)) data.vehicles = [];

  const orgId = _motiveOrgId();
  let created = 0;
  let updated = 0;

  for (const device of devices) {
    const v = device.vehicle;
    if (!v || !v.id) continue;

    const motiveId = String(v.id);
    const vin = (v.vin || "").trim().toUpperCase();

    const existing = data.vehicles.find((x) => x.motiveId === motiveId)
      || (vin ? data.vehicles.find((x) => (x.vin || "").toUpperCase() === vin) : null);

    const patch = {
      motiveId,
      motiveDeviceId: device.id != null ? String(device.id) : null,
      motiveDeviceIdentifier: device.identifier || null,
      motiveDeviceModel: device.model || null,
      vin: vin || existing?.vin || null,
      make: v.make || existing?.make || null,
      model: v.model || existing?.model || null,
      year: v.year ? String(v.year) : existing?.year || null,
      number: v.number || existing?.number || null,
      metricUnits: v.metric_units ?? false,
      updatedAt: nowIso()
    };

    if (existing) {
      Object.assign(existing, patch);
      updated++;
    } else {
      data.vehicles.push({
        vehicleId: makeId("VEH"),
        orgId,
        isActive: true,
        source: "motive",
        createdAt: nowIso(),
        ...patch
      });
      created++;
    }
  }

  await writeData(data);
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
 * Matches by motiveId first, then VIN.
 */
function resolveVehicleId(vehicles, motiveVehicleId, vin) {
  const motiveIdStr = String(motiveVehicleId || "");
  const vinUpper = (vin || "").trim().toUpperCase();
  const match = (vehicles || []).find(
    (v) => (motiveIdStr && v.motiveId === motiveIdStr) ||
            (vinUpper && (v.vin || "").toUpperCase() === vinUpper)
  );
  return match?.vehicleId ?? null;
}

module.exports = { syncFleet, backfillFaultCodes, resolveVehicleId };
