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
 *
 * Admin endpoints (requires SUPER_ADMIN session):
 *   POST /api/admin/motive/sync   — trigger fleet sync + fault code backfill
 *   GET  /api/admin/motive/status — check Motive credentials + last sync state
 */

const crypto = require("crypto");
const { syncFleet, backfillFaultCodes, resolveVehicleId } = require("../services/motiveSync");
const motiveClient = require("../services/motiveClient");

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
  const { readData, writeData, ml, pythonMlClient, sqliteDb, makeId, nowIso, requireSuperAdmin } = deps;

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
        await _routeEvent(action, event, { readData, writeData, ml, pythonMlClient, sqliteDb, makeId, nowIso });
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
      const syncResult = await syncFleet({ readData, writeData, makeId, nowIso });
      if (!syncResult.ok) {
        return res.status(502).json({ ok: false, error: syncResult.error });
      }

      // Backfill fault codes for vehicles that came from Motive
      let backfillResult = [];
      if (syncResult.created > 0 || req.body?.backfill) {
        const data = await readData();
        const motiveVehicles = (data.vehicles || []).filter((v) => v.motiveId);
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
    const data = await readData();
    const motiveVehicles = (data.vehicles || []).filter((v) => v.motiveId);
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
    default:
      console.log(`[MOTIVE-WEBHOOK] no handler for action=${action}`);
  }
}

// ── fault_code_opened ─────────────────────────────────────────────────────────

async function _onFaultCodeOpened(event, { readData, writeData, pythonMlClient, sqliteDb, makeId, nowIso }) {
  const motiveVehicleId = event.vehicle?.id;
  const vin = event.vehicle?.vin || "";
  const dtcCode = (event.code || "").trim();
  const severity = (event.dtc_severity || "").toUpperCase();
  const description = event.code_description || "";

  if (!dtcCode) return;

  const data = await readData();
  const vehicleId = resolveVehicleId(data.vehicles, motiveVehicleId, vin);
  if (!vehicleId) {
    console.warn(`[MOTIVE-WEBHOOK] fault_code_opened: unknown vehicle motiveId=${motiveVehicleId} vin=${vin} — run /api/admin/motive/sync first`);
    return;
  }

  const vehicle = data.vehicles.find((v) => v.vehicleId === vehicleId) || {};
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
    await _pushNotification(data, {
      vehicleId,
      orgId: vehicle.orgId || null,
      severity: notifSeverity,
      title: `Fault Code: ${dtcCode}`,
      body: `${description || dtcCode} detected${riskPct}. ${prediction?.advisoryText || ""}`.trim(),
      source: "motive_fault_code",
      makeId,
      nowIso
    });
    await writeData(data);
  }
}

// ── fault_code_closed ─────────────────────────────────────────────────────────

async function _onFaultCodeClosed(event, { readData, nowIso }) {
  const data = await readData();
  const vehicleId = resolveVehicleId(data.vehicles, event.vehicle?.id, event.vehicle?.vin);
  if (!vehicleId) return;
  console.log(`[MOTIVE-WEBHOOK] fault_code_closed vehicle=${vehicleId} code=${event.code}`);
  // Future: signal Python ML to recalibrate baseline for this vehicle
}

// ── engine_toggle_event ───────────────────────────────────────────────────────

async function _onEngineToggle(event, { readData, pythonMlClient, nowIso }) {
  const trigger = event.trigger; // "on" | "off"
  const data = await readData();
  const vehicleId = resolveVehicleId(data.vehicles, event.vehicle_id, event.vin);
  if (!vehicleId) return;

  console.log(`[MOTIVE-WEBHOOK] engine_toggle vehicle=${vehicleId} trigger=${trigger}`);

  if (trigger === "on") {
    // Trip start — run a baseline health check with whatever context we have
    const vehicle = data.vehicles.find((v) => v.vehicleId === vehicleId) || {};
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

async function _onVehicleUpserted(event, { readData, writeData, makeId, nowIso }) {
  const motiveId = String(event.id || "");
  if (!motiveId) return;

  const vin = (event.vin || "").trim().toUpperCase();
  const data = await readData();
  if (!Array.isArray(data.vehicles)) data.vehicles = [];

  let vehicle = data.vehicles.find((v) => v.motiveId === motiveId)
    || (vin ? data.vehicles.find((v) => (v.vin || "").toUpperCase() === vin) : null);

  const patch = {
    motiveId,
    vin: vin || vehicle?.vin || null,
    make: event.make || vehicle?.make || null,
    model: event.model || vehicle?.model || null,
    year: event.year ? String(event.year) : vehicle?.year || null,
    number: event.number || vehicle?.number || null,
    motiveDeviceId: event.eld_device?.id ? String(event.eld_device.id) : vehicle?.motiveDeviceId || null,
    motiveDeviceIdentifier: event.eld_device?.identifier || vehicle?.motiveDeviceIdentifier || null,
    updatedAt: nowIso()
  };

  if (vehicle) {
    Object.assign(vehicle, patch);
  } else {
    data.vehicles.push({
      vehicleId: makeId("VEH"),
      orgId: (process.env.MOTIVE_ORG_ID || "ORG_DEFAULT").trim(),
      isActive: true,
      source: "motive",
      createdAt: nowIso(),
      ...patch
    });
  }

  await writeData(data);
  console.log(`[MOTIVE-WEBHOOK] vehicle_upserted motiveId=${motiveId} vin=${vin}`);
}

// ── inspection_report_upserted ────────────────────────────────────────────────

async function _onInspectionReport(event, { readData, writeData, makeId, nowIso }) {
  const defects = Array.isArray(event.defects) ? event.defects : [];
  if (!defects.length) return;

  const data = await readData();
  const vehicleId = resolveVehicleId(data.vehicles, event.vehicle?.id, event.vehicle?.vin);
  if (!vehicleId) return;

  const major = defects.filter((d) => d.severity === "major" || d.severity === "critical");
  console.log(`[MOTIVE-WEBHOOK] inspection_report vehicle=${vehicleId} defects=${defects.length} major=${major.length}`);

  if (major.length) {
    const vehicle = data.vehicles.find((v) => v.vehicleId === vehicleId) || {};
    await _pushNotification(data, {
      vehicleId,
      orgId: vehicle.orgId || null,
      severity: "warning",
      title: "DVIR: Major Defects Reported",
      body: major.map((d) => `${d.area || "Unknown area"}: ${d.description || "defect"}`).join("; "),
      source: "motive_dvir",
      makeId,
      nowIso
    });
    await writeData(data);
  }
}

// ── driver_performance_event ──────────────────────────────────────────────────

async function _onDriverPerformance(event, { readData, nowIso }) {
  const data = await readData();
  const vehicleId = resolveVehicleId(data.vehicles, event.vehicle?.id, event.vehicle?.vin);
  if (!vehicleId) return;
  const eventType = event.event_type || event.type || "unknown";
  // Logged for future stress-signal aggregation; no immediate action
  console.log(`[MOTIVE-WEBHOOK] driver_performance vehicle=${vehicleId} type=${eventType}`);
}

// ── speeding_event ────────────────────────────────────────────────────────────

async function _onSpeedingEvent(event, { readData, nowIso }) {
  const data = await readData();
  const vehicleId = resolveVehicleId(data.vehicles, event.vehicle?.id, event.vehicle?.vin);
  if (!vehicleId) return;
  const maxKph = event.max_speed_kph || event.speed || null;
  console.log(`[MOTIVE-WEBHOOK] speeding_event vehicle=${vehicleId} max_kph=${maxKph}`);
}

// ── gateway connectivity ──────────────────────────────────────────────────────

async function _onGatewayDisconnected(event, { readData, writeData, nowIso }) {
  const data = await readData();
  const motiveId = event.vehicle?.id || event.vehicle_id;
  const vehicleId = resolveVehicleId(data.vehicles, motiveId, "");
  if (!vehicleId) return;
  const vehicle = data.vehicles.find((v) => v.vehicleId === vehicleId);
  if (vehicle) {
    vehicle.motiveGatewayConnected = false;
    vehicle.motiveGatewayDisconnectedAt = nowIso();
    await writeData(data);
  }
  console.log(`[MOTIVE-WEBHOOK] gateway_disconnected vehicle=${vehicleId}`);
}

async function _onGatewayReconnected(event, { readData, writeData, nowIso }) {
  const data = await readData();
  const motiveId = event.vehicle?.id || event.vehicle_id;
  const vehicleId = resolveVehicleId(data.vehicles, motiveId, "");
  if (!vehicleId) return;
  const vehicle = data.vehicles.find((v) => v.vehicleId === vehicleId);
  if (vehicle) {
    vehicle.motiveGatewayConnected = true;
    vehicle.motiveGatewayDisconnectedAt = null;
    await writeData(data);
  }
  console.log(`[MOTIVE-WEBHOOK] gateway_reconnected vehicle=${vehicleId}`);
}

// ── Shared helper ─────────────────────────────────────────────────────────────

async function _pushNotification(data, { vehicleId, orgId, severity, title, body, source, makeId, nowIso }) {
  if (!Array.isArray(data.notifications)) data.notifications = [];
  data.notifications.unshift({
    id: makeId("NOTIF"),
    org_id: orgId,
    recipient_type: "fleet_manager",
    recipient_id: orgId,
    vehicle_id: vehicleId,
    event_id: "",
    title,
    body,
    severity,
    status: "unread",
    source,
    created_at: nowIso()
  });
  // Cap notification list
  if (data.notifications.length > 500) data.notifications.length = 500;
}

module.exports = { registerMotiveWebhookRoutes };
