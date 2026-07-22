/**
 * Motive webhook receiver — POST /api/webhooks/motive
 *
 * Motive signs each payload with HMAC-SHA1 using the shared secret from the
 * developer portal. The signature is in the X-KT-Webhook-Signature header.
 *
 * Fleet AI responds 200 immediately (Motive requires < 3s), then processes
 * the event asynchronously.
 *
 * Handled actions:
 *   fault_code_opened / fault_code_closed
 *   engine_toggle_event
 *   vehicle_upserted
 *   inspection_report_upserted
 *   driver_performance_event_created / _updated
 *   speeding_event_created / _updated
 *   vehicle_gateway_disconnected / vehicle_gateway_disconnect_ended
 *   vehicle_location_updated / vehicle_location_received  — live GPS map
 *   user_upserted                                         — driver sync
 *   hos_violation_upserted                               — HOS compliance
 *   vehicle_geofence_event                               — geofence alerts
 *   user_duty_status_updated                             — driver duty status
 *
 * Admin endpoints (requires SUPER_ADMIN session):
 *   POST /api/admin/motive/sync   — trigger fleet sync + fault code backfill
 *   GET  /api/admin/motive/status — check Motive credentials + last sync state
 *
 * Vehicles/drivers/notifications are Prisma-backed (server/db.js) — see
 * server/services/motiveSync.js for the shared upsert-by-motiveId logic.
 */

const crypto = require("crypto");
const { syncFleet, backfillFaultCodes, resolveVehicleId } = require("../services/motiveSync");
const motiveClient = require("../services/motiveClient");
const db = require("../db");

// Last sync timestamp for status endpoint
let _lastSyncAt = null;
let _lastSyncResult = null;

function _webhookSecret() {
  return (process.env.MOTIVE_WEBHOOK_SECRET || "").trim();
}

// HMAC-SHA1 — Motive's signing scheme
function _verifySignature(rawBody, signatureHeader) {
  const secret = _webhookSecret();
  if (!secret) {
    // No secret configured — warn in dev, reject in prod
    if (process.env.NODE_ENV === "production") return false;
    console.warn("[MOTIVE-WEBHOOK] MOTIVE_WEBHOOK_SECRET not set — skipping signature check in dev");
    return true;
  }
  if (!signatureHeader) return false;
  const expected = crypto.createHmac("sha1", secret).update(rawBody || "").digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signatureHeader, "hex"));
  } catch {
    return false;
  }
}

function registerMotiveWebhookRoutes(app, deps) {
  const { ml, pythonMlClient, sqliteDb, nowIso, requireSuperAdmin, telemetryLatest } = deps;

  // ── Incoming Motive webhook ────────────────────────────────────────────────
  app.post("/api/webhooks/motive", async (req, res) => {
    const signature = req.headers["x-kt-webhook-signature"] || "";
    if (!_verifySignature(req.rawBody, signature)) {
      console.warn("[MOTIVE-WEBHOOK] invalid signature — rejected");
      return res.status(403).json({ ok: false, error: "invalid_signature" });
    }

    // Respond 200 immediately — Motive retries on 4xx/5xx, not on 200
    res.status(200).json({ ok: true });

    const event = req.body || {};
    const action = String(event.action || "");
    console.log(`[MOTIVE-WEBHOOK] received action=${action}`);

    setImmediate(async () => {
      try {
        await _routeEvent(action, event, { ml, pythonMlClient, sqliteDb, nowIso, telemetryLatest });
      } catch (err) {
        console.error(`[MOTIVE-WEBHOOK] handler error action=${action}: ${err.message}`);
      }
    });
  });

  // ── Admin: trigger fleet sync ──────────────────────────────────────────────
  app.post("/api/admin/motive/sync", requireSuperAdmin, async (req, res) => {
    if (!motiveClient.isConfigured()) {
      return res.status(400).json({ ok: false, error: "Motive credentials not configured. Set MOTIVE_ACCESS_TOKEN." });
    }
    try {
      const syncResult = await syncFleet();
      if (!syncResult.ok) {
        return res.status(502).json({ ok: false, error: syncResult.error });
      }

      // Backfill fault codes for vehicles that came from Motive
      let backfillResult = [];
      if (syncResult.created > 0 || req.body?.backfill) {
        const allVehicles = await db.listVehicles();
        const motiveVehicles = allVehicles.filter((v) => v.motiveId);
        backfillResult = await backfillFaultCodes(motiveVehicles, { pythonMlClient, nowIso });
      }

      _lastSyncAt = nowIso();
      _lastSyncResult = { ...syncResult, backfillCount: backfillResult.length };

      return res.json({
        ok: true,
        sync: syncResult,
        backfill: { vehicles: backfillResult.length, results: backfillResult }
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── Admin: Motive integration status ──────────────────────────────────────
  app.get("/api/admin/motive/status", requireSuperAdmin, async (req, res) => {
    const allVehicles = await db.listVehicles();
    const motiveVehicles = allVehicles.filter((v) => v.motiveId);
    return res.json({
      ok: true,
      configured: motiveClient.isConfigured(),
      webhookSecretSet: Boolean(_webhookSecret()),
      motiveVehicleCount: motiveVehicles.length,
      lastSyncAt: _lastSyncAt,
      lastSyncResult: _lastSyncResult
    });
  });
}

// ── Event router ─────────────────────────────────────────────────────────────

async function _routeEvent(action, event, deps) {
  switch (action) {
    case "fault_code_opened":           return _onFaultCodeOpened(event, deps);
    case "fault_code_closed":           return _onFaultCodeClosed(event, deps);
    case "engine_toggle_event":         return _onEngineToggle(event, deps);
    case "vehicle_upserted":            return _onVehicleUpserted(event, deps);
    case "inspection_report_upserted":  return _onInspectionReport(event, deps);
    case "driver_performance_event_created":
    case "driver_performance_event_updated":
      return _onDriverPerformance(event, deps);
    case "speeding_event_created":
    case "speeding_event_updated":
      return _onSpeedingEvent(event, deps);
    case "vehicle_gateway_disconnected":
      return _onGatewayDisconnected(event, deps);
    case "vehicle_gateway_disconnect_ended":
      return _onGatewayReconnected(event, deps);
    case "vehicle_location_updated":
    case "vehicle_location_received":
      return _onVehicleLocation(event, deps);
    case "user_upserted":
      return _onUserUpserted(event, deps);
    case "hos_violation_upserted":
      return _onHosViolation(event, deps);
    case "vehicle_geofence_event":
      return _onGeofenceEvent(event, deps);
    case "user_duty_status_updated":
      return _onDutyStatusUpdated(event, deps);
    default:
      console.log(`[MOTIVE-WEBHOOK] no handler for action=${action}`);
  }
}

// ── fault_code_opened ─────────────────────────────────────────────────────────

async function _onFaultCodeOpened(event, { pythonMlClient, sqliteDb, nowIso }) {
  const motiveVehicleId = event.vehicle?.id;
  const vin = event.vehicle?.vin || "";
  const dtcCode = (event.code || "").trim();
  const severity = (event.dtc_severity || "").toUpperCase();
  const description = event.code_description || "";

  if (!dtcCode) return;

  const vehicleId = await resolveVehicleId(motiveVehicleId, vin);
  if (!vehicleId) {
    console.warn(`[MOTIVE-WEBHOOK] fault_code_opened: unknown vehicle motiveId=${motiveVehicleId} vin=${vin} — run /api/admin/motive/sync first`);
    return;
  }

  const vehicle = (await db.getVehicleByVehicleId(vehicleId)) || {};
  const vehicleMeta = {
    vehicleId,
    vin: vehicle.vin || vin,
    make: vehicle.make || event.vehicle?.make || null,
    model: vehicle.model || event.vehicle?.model || null,
    year: vehicle.year || event.vehicle?.year || null
  };

  console.log(`[MOTIVE-WEBHOOK] fault_code_opened vehicle=${vehicleId} code=${dtcCode} severity=${severity}`);

  // Run ML prediction with DTC as primary signal
  let prediction = null;
  try {
    prediction = await pythonMlClient.predict({
      orgId: vehicle.orgId || null,
      vehicleId,
      vehicleMeta,
      samples: [],   // Motive standard API does not expose raw sensor streams
      dtcCodes: [dtcCode]
    });
  } catch (err) {
    console.warn(`[MOTIVE-WEBHOOK] ML predict failed vehicle=${vehicleId}: ${err.message}`);
  }

  // Log prediction run for billing + history
  try {
    await sqliteDb.insertMlPredictionRun({
      orgId: vehicle.orgId || null,
      vehicleId,
      modelVersion: "motive-dtc-v1",
      source: "motive_webhook",
      confidenceStage: prediction?.modelStatus?.ifTrained ? "ensemble" : "dtc_only",
      confidence: prediction?.confidence ?? null,
      riskProbability: prediction?.riskProbability ?? null,
      healthScore: prediction?.healthScore ?? null,
      prediction: {
        dtcCode,
        dtcSeverity: severity,
        dtcDescription: description,
        fmi: event.fmi || null,
        codeType: event.type || null,
        firstObservedAt: event.first_observed_at || nowIso(),
        lastObservedAt: event.last_observed_at || null,
        numObservations: event.num_observations || 1,
        riskProbability: prediction?.riskProbability ?? null,
        prediction: prediction?.prediction ?? null,
        advisoryText: prediction?.advisoryText ?? null,
        diagnosis: prediction?.diagnosis ?? null
      }
    });
  } catch (err) {
    console.warn(`[MOTIVE-WEBHOOK] insertMlPredictionRun failed: ${err.message}`);
  }

  // Create notification for high-risk or critical fault codes
  const risk = prediction?.riskProbability ?? 0;
  if (risk >= 0.35 || severity === "CRITICAL") {
    const notifSeverity = (severity === "CRITICAL" || risk >= 0.75) ? "critical" : "warning";
    const riskPct = risk ? ` — ${Math.round(risk * 100)}% breakdown risk` : "";
    await db.createNotification({
      vehicleId,
      orgId: vehicle.orgId || null,
      severity: notifSeverity,
      title: `Fault Code: ${dtcCode}`,
      body: `${description || dtcCode} detected${riskPct}. ${prediction?.advisoryText || ""}`.trim(),
    });
  }
}

// ── fault_code_closed ─────────────────────────────────────────────────────────

async function _onFaultCodeClosed(event) {
  const vehicleId = await resolveVehicleId(event.vehicle?.id, event.vehicle?.vin);
  if (!vehicleId) return;
  console.log(`[MOTIVE-WEBHOOK] fault_code_closed vehicle=${vehicleId} code=${event.code}`);
  // Future: signal Python ML to recalibrate baseline for this vehicle
}

// ── engine_toggle_event ───────────────────────────────────────────────────────

async function _onEngineToggle(event, { pythonMlClient }) {
  const trigger = event.trigger; // "on" | "off"
  const vehicleId = await resolveVehicleId(event.vehicle_id, event.vin);
  if (!vehicleId) return;

  console.log(`[MOTIVE-WEBHOOK] engine_toggle vehicle=${vehicleId} trigger=${trigger}`);

  if (trigger === "on") {
    // Trip start — run a baseline health check with whatever context we have
    const vehicle = (await db.getVehicleByVehicleId(vehicleId)) || {};
    try {
      await pythonMlClient.predict({
        orgId: vehicle.orgId || null,
        vehicleId,
        vehicleMeta: {
          vehicleId,
          vin: vehicle.vin || event.vin || null,
          make: vehicle.make || event.make || null,
          model: vehicle.model || event.model || null,
          year: vehicle.year || event.year || null
        },
        samples: [],
        dtcCodes: []
      });
      console.log(`[MOTIVE-WEBHOOK] trip-start prediction complete vehicle=${vehicleId}`);
    } catch (err) {
      console.warn(`[MOTIVE-WEBHOOK] trip-start predict failed vehicle=${vehicleId}: ${err.message}`);
    }
  }
}

// ── vehicle_upserted ──────────────────────────────────────────────────────────

async function _onVehicleUpserted(event) {
  const motiveId = String(event.id || "");
  if (!motiveId) return;

  const vin = (event.vin || "").trim().toUpperCase();
  await db.upsertVehicleFromMotive({
    motiveId,
    vin: vin || null,
    make: event.make || null,
    model: event.model || null,
    year: event.year || null,
    unitName: event.number || null,
    orgId: (process.env.MOTIVE_ORG_ID || "ORG_DEFAULT").trim(),
    metadata: {
      motiveDeviceId: event.eld_device?.id ? String(event.eld_device.id) : null,
      motiveDeviceIdentifier: event.eld_device?.identifier || null
    }
  });

  console.log(`[MOTIVE-WEBHOOK] vehicle_upserted motiveId=${motiveId} vin=${vin}`);
}

// ── inspection_report_upserted ────────────────────────────────────────────────

async function _onInspectionReport(event) {
  const defects = Array.isArray(event.defects) ? event.defects : [];
  if (!defects.length) return;

  const vehicleId = await resolveVehicleId(event.vehicle?.id, event.vehicle?.vin);
  if (!vehicleId) return;

  const major = defects.filter((d) => d.severity === "major" || d.severity === "critical");
  console.log(`[MOTIVE-WEBHOOK] inspection_report vehicle=${vehicleId} defects=${defects.length} major=${major.length}`);

  if (major.length) {
    const vehicle = (await db.getVehicleByVehicleId(vehicleId)) || {};
    await db.createNotification({
      vehicleId,
      orgId: vehicle.orgId || null,
      severity: "warning",
      title: "DVIR: Major Defects Reported",
      body: major.map((d) => `${d.area || "Unknown area"}: ${d.description || "defect"}`).join("; ")
    });
  }
}

// ── driver_performance_event ──────────────────────────────────────────────────

async function _onDriverPerformance(event) {
  const vehicleId = await resolveVehicleId(event.vehicle?.id, event.vehicle?.vin);
  if (!vehicleId) return;
  const eventType = event.event_type || event.type || "unknown";
  // Logged for future stress-signal aggregation; no immediate action
  console.log(`[MOTIVE-WEBHOOK] driver_performance vehicle=${vehicleId} type=${eventType}`);
}

// ── speeding_event ────────────────────────────────────────────────────────────

async function _onSpeedingEvent(event) {
  const vehicleId = await resolveVehicleId(event.vehicle?.id, event.vehicle?.vin);
  if (!vehicleId) return;
  const maxKph = event.max_speed_kph || event.speed || null;
  console.log(`[MOTIVE-WEBHOOK] speeding_event vehicle=${vehicleId} max_kph=${maxKph}`);
}

// ── gateway connectivity ──────────────────────────────────────────────────────

async function _onGatewayDisconnected(event, { nowIso }) {
  const motiveId = event.vehicle?.id || event.vehicle_id;
  const vehicleId = await resolveVehicleId(motiveId, "");
  if (!vehicleId) return;
  await db.updateVehicleMotiveMetadata(vehicleId, {
    motiveGatewayConnected: false,
    motiveGatewayDisconnectedAt: nowIso()
  });
  console.log(`[MOTIVE-WEBHOOK] gateway_disconnected vehicle=${vehicleId}`);
}

async function _onGatewayReconnected(event) {
  const motiveId = event.vehicle?.id || event.vehicle_id;
  const vehicleId = await resolveVehicleId(motiveId, "");
  if (!vehicleId) return;
  await db.updateVehicleMotiveMetadata(vehicleId, {
    motiveGatewayConnected: true,
    motiveGatewayDisconnectedAt: null
  });
  console.log(`[MOTIVE-WEBHOOK] gateway_reconnected vehicle=${vehicleId}`);
}

// ── vehicle_location_updated / vehicle_location_received ─────────────────────

async function _onVehicleLocation(event, { nowIso, telemetryLatest }) {
  const motiveId = event.vehicle?.id || event.vehicle_id;
  const location = event.location || {};
  const lat = location.lat ?? null;
  const lon = location.lon ?? location.lng ?? null;

  if (!motiveId || lat === null || lon === null) return;

  const vehicleId = await resolveVehicleId(motiveId, "");
  if (!vehicleId) {
    console.log(`[MOTIVE-WEBHOOK] vehicle_location: unknown motiveId=${motiveId} — run sync first`);
    return;
  }

  const ts = event.reported_at || event.timestamp || nowIso();
  const speedKph = location.speed ?? null;
  const heading = location.heading ?? null;
  const description = location.description || location.address || null;

  if (telemetryLatest) {
    const existing = telemetryLatest.get(vehicleId) || {};
    telemetryLatest.set(vehicleId, Object.assign({}, existing, {
      vehicleId,
      ts,
      lat,
      lon,
      speedKph,
      heading,
      locationDescription: description,
      source: "motive_location"
    }));
  }

  console.log(`[MOTIVE-WEBHOOK] vehicle_location vehicle=${vehicleId} lat=${lat} lon=${lon} speed=${speedKph}`);
}

// ── user_upserted (Motive driver sync) ───────────────────────────────────────

async function _onUserUpserted(event) {
  const motiveUserId = String(event.id || "");
  if (!motiveUserId) return;

  const firstName = (event.first_name || "").trim();
  const lastName = (event.last_name || "").trim();
  const email = (event.email || "").trim().toLowerCase();
  const phone = (event.phone || "").trim();
  const role = (event.role || "").toLowerCase();

  // Only sync driver-role users
  if (role && !["driver", "user", ""].includes(role)) {
    console.log(`[MOTIVE-WEBHOOK] user_upserted: skipping role=${role} id=${motiveUserId}`);
    return;
  }

  await db.upsertDriverFromMotive({
    motiveUserId,
    firstName,
    lastName,
    email,
    phone,
    orgId: (process.env.MOTIVE_ORG_ID || "ORG_DEFAULT").trim()
  });

  console.log(`[MOTIVE-WEBHOOK] user_upserted motiveUserId=${motiveUserId} name="${firstName} ${lastName}"`);
}

// ── hos_violation_upserted ────────────────────────────────────────────────────

async function _onHosViolation(event) {
  const driver = event.driver || {};
  const motiveId = event.vehicle?.id || null;
  const violationType = event.violation_type || event.type || "HOS_VIOLATION";
  const description = event.description || violationType;
  const driverName = driver.first_name
    ? `${driver.first_name || ""} ${driver.last_name || ""}`.trim()
    : `Driver #${driver.id || "unknown"}`;

  const vehicleId = motiveId ? await resolveVehicleId(motiveId, "") : null;
  const vehicle = vehicleId ? await db.getVehicleByVehicleId(vehicleId) : null;

  console.log(`[MOTIVE-WEBHOOK] hos_violation driver="${driverName}" type=${violationType}`);

  await db.createNotification({
    vehicleId: vehicleId || "unknown",
    orgId: vehicle?.orgId || (process.env.MOTIVE_ORG_ID || "ORG_DEFAULT"),
    severity: "warning",
    title: `HOS Violation: ${driverName}`,
    body: description
  });
}

// ── vehicle_geofence_event ────────────────────────────────────────────────────

async function _onGeofenceEvent(event) {
  const motiveId = event.vehicle?.id || event.vehicle_id;
  const geofenceName = event.geofence?.name || event.geofence?.id || "Unknown";
  const eventType = (event.event_type || "").toLowerCase(); // "entry" | "exit"

  const vehicleId = await resolveVehicleId(motiveId, "");
  if (!vehicleId) return;

  const vehicle = (await db.getVehicleByVehicleId(vehicleId)) || {};
  const direction = eventType === "entry" ? "entered" : eventType === "exit" ? "exited" : "triggered";

  console.log(`[MOTIVE-WEBHOOK] geofence_event vehicle=${vehicleId} geofence="${geofenceName}" type=${eventType}`);

  await db.createNotification({
    vehicleId,
    orgId: vehicle.orgId || null,
    severity: "info",
    title: `Geofence: ${geofenceName}`,
    body: `Vehicle ${vehicle.unitName || vehicleId} ${direction} geofence "${geofenceName}".`
  });
}

// ── user_duty_status_updated ──────────────────────────────────────────────────

async function _onDutyStatusUpdated(event, { nowIso }) {
  const driver = event.driver || {};
  const motiveUserId = String(driver.id || "");
  const currentStatus = event.current_status || event.status || "";
  if (!motiveUserId) return;

  const driverRecord = await db.findDriverByMotiveUserId(motiveUserId);
  if (!driverRecord) {
    console.log(`[MOTIVE-WEBHOOK] duty_status: unknown motiveUserId=${motiveUserId}`);
    return;
  }

  await db.updateDriverMotiveMetadata(driverRecord.driverId, {
    dutyStatus: currentStatus,
    dutyStatusUpdatedAt: event.updated_at || nowIso()
  });
  console.log(`[MOTIVE-WEBHOOK] duty_status_updated motiveUserId=${motiveUserId} status=${currentStatus}`);
}

module.exports = { registerMotiveWebhookRoutes };
