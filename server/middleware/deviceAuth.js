/**
 * Device authentication for paired tablets and the Android driver app.
 *
 * Before this existed, /auth/driverLogin returned a random `drv_...` string
 * that was never persisted and never verified by anything — the Android client
 * attached it as a bearer token and no route on the server ever looked at it.
 * Every device-facing endpoint was therefore effectively public, including
 * telemetry ingest.
 *
 * A device now receives a real token when it successfully claims a pairing
 * (pairing code + driver PIN). The token maps back to that Pairing row, which
 * carries the vehicle, driver and org — so a device's authority is exactly the
 * one truck it was paired to, and revoking or expiring the pairing revokes the
 * token with it.
 */

const db = require("../db");

function extractBearer(req) {
  const header = req.headers.authorization || req.headers.Authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(String(header).trim());
  if (match) return match[1].trim();
  // Tablets running as kiosk web pages cannot always set headers on every
  // transport (EventSource, for one), so a query token is accepted as well.
  const q = req.query?.deviceToken || req.query?.device_token;
  return q ? String(q).trim() : "";
}

/**
 * Attaches req.device when a valid device token is present, otherwise leaves it
 * null and continues. Use for endpoints that serve both operators and devices.
 */
async function attachDevice(req, _res, next) {
  req.device = null;
  try {
    const token = extractBearer(req);
    if (token) {
      const pairing = await db.findPairingByDeviceToken(token);
      if (pairing) {
        req.device = {
          pairingId: pairing.id,
          vehicleId: pairing.vehicleId,
          driverId: pairing.driverId,
          orgId: pairing.orgId,
          deviceId: pairing.deviceId,
          deviceLabel: pairing.deviceLabel
        };
      }
    }
  } catch (_err) {
    req.device = null;
  }
  next();
}

/** Hard gate — 401 unless a valid device token was presented. */
async function requireDevice(req, res, next) {
  await attachDevice(req, res, () => {});
  if (!req.device) {
    return res.status(401).json({
      ok: false,
      error: "DEVICE_AUTH_REQUIRED",
      message: "A valid device token is required. Re-pair this device."
    });
  }
  next();
}

/**
 * Accepts EITHER an authenticated operator session OR a valid device token.
 * When authorised by device, req.device constrains what may be read — callers
 * must scope their query to req.device.vehicleId rather than trusting input.
 */
function requireOperatorOrDevice(requireOperator) {
  return async function (req, res, next) {
    await attachDevice(req, res, () => {});
    if (req.device) return next();
    return requireOperator(req, res, next);
  };
}

module.exports = { attachDevice, requireDevice, requireOperatorOrDevice, extractBearer };
