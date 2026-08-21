/**
 * One-time migration: SQLite + JSON flat-files → PostgreSQL (via Prisma)
 *
 * Run AFTER:
 *   1. npx prisma migrate deploy   (applies the schema to PostgreSQL)
 *   2. Set DATABASE_URL in your environment to the Railway PostgreSQL connection string
 *
 * Usage:
 *   node scripts/migrate-to-postgres.js
 *
 * Safe to re-run: uses upsert / createMany with skipDuplicates where possible.
 * Row counts are printed for every table so you can verify parity.
 */

"use strict";

require("dotenv").config({ path: require("path").resolve(__dirname, "..", ".env") });

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

// ── Paths ──────────────────────────────────────────────────────────────────
const ROOT = path.resolve(__dirname, "..");
const SQLITE_PATH = process.env.FLEETAI_DB_PATH
  || path.join(ROOT, "server", "state", "fleet.db");
const AUTH_STORE_PATH = process.env.AUTH_STORE_PATH
  || path.join(ROOT, "server", "state", "auth-store.json");

// ── Helpers ────────────────────────────────────────────────────────────────

function log(msg) {
  console.log(`[migrate] ${msg}`);
}

function warn(msg) {
  console.warn(`[migrate:warn] ${msg}`);
}

function readJsonStore(filePath) {
  if (!fs.existsSync(filePath)) {
    warn(`JSON store not found: ${filePath}`);
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    warn(`Failed to parse ${filePath}: ${err.message}`);
    return {};
  }
}

function toDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

function toDecimal(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return isFinite(n) ? n : null;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function batchUpsert(label, items, fn) {
  let count = 0;
  for (const batch of chunk(items, 200)) {
    await fn(batch);
    count += batch.length;
  }
  log(`${label}: ${count} rows`);
  return count;
}

// ══════════════════════════════════════════════════════════════════════════
// STEP 1 — Migrate from JSON flat-file (auth store + app data)
// ══════════════════════════════════════════════════════════════════════════

async function migrateJsonStore(data) {
  log("=== Migrating JSON flat-file store ===");

  // ── Orgs ────────────────────────────────────────────────────────────────
  const orgs = Array.isArray(data.orgs) ? data.orgs : [];
  await batchUpsert("orgs", orgs, async (batch) => {
    await prisma.org.createMany({
      data: batch.map((o) => ({
        id: o.id || o.orgId,
        name: o.name || "Unknown",
        status: o.status || "LEAD",
        email: o.email || null,
        phone: o.phone || null,
        address: o.address || null,
        industry: o.industry || null,
        vehicleIds: Array.isArray(o.vehicleIds) ? o.vehicleIds : [],
        createdAt: toDate(o.createdAt) || new Date(),
        updatedAt: toDate(o.updatedAt) || new Date(),
      })),
      skipDuplicates: true,
    });
  });

  // ── TenantSettings ──────────────────────────────────────────────────────
  const ts = data.tenantSettings;
  if (ts && orgs.length > 0) {
    const orgId = orgs[0].id || orgs[0].orgId;
    await prisma.tenantSettings.upsert({
      where: { orgId },
      create: {
        orgId,
        companyName: ts.companyName || "Fleet AI",
        logoUrl: ts.logoUrl || "",
        themeMode: ts.themeMode || "blue",
        accentColor: ts.accentColor || "",
      },
      update: {
        companyName: ts.companyName || "Fleet AI",
        logoUrl: ts.logoUrl || "",
        themeMode: ts.themeMode || "blue",
        accentColor: ts.accentColor || "",
      },
    });
    log("tenantSettings: 1 row");
  }

  // ── OrgBillingSettings ──────────────────────────────────────────────────
  const billing = data.orgBillingSettings;
  if (billing && orgs.length > 0) {
    const orgId = orgs[0].id || orgs[0].orgId;
    await prisma.orgBillingSettings.upsert({
      where: { orgId },
      create: {
        orgId,
        plan: billing.plan || "PILOT_CORE",
        priceMonthly: toDecimal(billing.priceMonthly) || 50,
        status: billing.status || "NONE",
        activatedAt: toDate(billing.activatedAt),
        nextBillAt: toDate(billing.nextBillAt),
        vehicleCount: Number(billing.vehicleCount) || 0,
        contractTermMonths: Number(billing.contractTermMonths) || 0,
        notes: billing.notes || "",
      },
      update: {
        plan: billing.plan || "PILOT_CORE",
        status: billing.status || "NONE",
      },
    });
    log("orgBillingSettings: 1 row");
  }

  // ── PaymentMethod ───────────────────────────────────────────────────────
  const pm = data.paymentMethod;
  if (pm && orgs.length > 0) {
    const orgId = orgs[0].id || orgs[0].orgId;
    await prisma.paymentMethod.upsert({
      where: { orgId },
      create: {
        orgId,
        type: pm.type || "CARD_STUB",
        billingName: pm.billingName || "",
        billingEmail: pm.billingEmail || "",
        last4: pm.last4 || "",
        expMonth: Number(pm.expMonth) || 1,
        expYear: Number(pm.expYear) || new Date().getFullYear(),
        brand: pm.brand || "",
        postalCode: pm.postalCode || "",
        accountType: pm.accountType || "",
        routingLast4: pm.routingLast4 || "",
        accountLast4: pm.accountLast4 || "",
      },
      update: {},
    });
    log("paymentMethod: 1 row");
  }

  // ── Users ────────────────────────────────────────────────────────────────
  const users = Array.isArray(data.users) ? data.users : [];
  await batchUpsert("users", users, async (batch) => {
    for (const u of batch) {
      const role = String(u.role || "CUSTOMER").toUpperCase();
      const kind = u.kind || (role.startsWith("CUSTOMER") || role === "ORG_ADMIN" ? "customer" : "employee");
      await prisma.user.upsert({
        where: { email: String(u.email || "").toLowerCase() },
        create: {
          id: u.id,
          email: String(u.email || "").toLowerCase(),
          role,
          kind,
          orgId: u.orgId || null,
          passwordHash: u.passwordHash || "",
          passwordAlgo: u.passwordAlgo || "bcrypt",
          isActive: u.isActive !== false,
          active: u.active !== false,
          verified: u.verified || false,
          mustSetPassword: u.mustSetPassword || false,
          requirePasswordReset: u.requirePasswordReset || false,
          displayName: u.displayName || "",
          lastLoginAt: toDate(u.lastLoginAt),
          createdAt: toDate(u.createdAt) || new Date(),
        },
        update: {
          role,
          orgId: u.orgId || null,
          passwordHash: u.passwordHash || "",
          isActive: u.isActive !== false,
          lastLoginAt: toDate(u.lastLoginAt),
        },
      });
    }
  });

  // ── Vehicles ─────────────────────────────────────────────────────────────
  const vehicles = Array.isArray(data.vehicles) ? data.vehicles : [];
  await batchUpsert("vehicles", vehicles, async (batch) => {
    for (const v of batch) {
      await prisma.vehicle.upsert({
        where: { vehicleId: v.vehicleId },
        create: {
          id: v.id,
          vehicleId: v.vehicleId,
          unitName: v.unitName || v.vehicleId,
          vin: v.vin || null,
          type: v.type || null,
          orgId: v.orgId || null,
          year: v.year ? Number(v.year) : null,
          make: v.make || null,
          model: v.model || null,
          createdAt: toDate(v.createdAt) || new Date(),
        },
        update: { unitName: v.unitName || v.vehicleId, vin: v.vin || null },
      });
    }
  });

  // ── Drivers ──────────────────────────────────────────────────────────────
  const drivers = Array.isArray(data.drivers) ? data.drivers : [];
  await batchUpsert("drivers", drivers, async (batch) => {
    for (const d of batch) {
      await prisma.driver.upsert({
        where: { driverId: d.driverId || d.id },
        create: {
          id: d.id,
          driverId: d.driverId || d.id,
          firstName: d.firstName || null,
          lastName: d.lastName || null,
          email: d.email || null,
          phone: d.phone || null,
          pin: d.pin || null,
          orgId: d.orgId || null,
          status: d.status || "active",
          licenseNum: d.licenseNum || null,
          createdAt: toDate(d.createdAt) || new Date(),
        },
        update: { status: d.status || "active" },
      });
    }
  });

  // ── Pairings ─────────────────────────────────────────────────────────────
  const pairings = Array.isArray(data.pairings) ? data.pairings : [];
  await batchUpsert("pairings", pairings, async (batch) => {
    await prisma.pairing.createMany({
      data: batch.map((p) => ({
        id: p.id,
        pairCode: p.pairCode || p.code || null,
        vehicleId: p.vehicleId || null,
        driverId: p.driverId || null,
        deviceId: p.deviceId || null,
        orgId: p.orgId || null,
        status: p.status || "pending",
        expiresAt: toDate(p.expiresAt),
        claimedAt: toDate(p.claimedAt),
        revokedAt: toDate(p.revokedAt),
        createdAt: toDate(p.createdAt) || new Date(),
        updatedAt: toDate(p.updatedAt) || new Date(),
      })),
      skipDuplicates: true,
    });
  });

  // ── MaintenanceLogs ──────────────────────────────────────────────────────
  const logs = Array.isArray(data.maintenanceLogs) ? data.maintenanceLogs
    : Array.isArray(data.maintenance_logs) ? data.maintenance_logs : [];
  await batchUpsert("maintenanceLogs", logs, async (batch) => {
    await prisma.maintenanceLog.createMany({
      data: batch.map((m) => ({
        id: m.id,
        orgId: m.orgId || null,
        vehicleId: m.vehicleId,
        serviceType: m.serviceType || null,
        serviceCategory: m.serviceCategory || null,
        maintenanceType: m.maintenanceType || m.type || null,
        description: m.description || m.notes || null,
        performedAt: toDate(m.performedAt || m.occurredAt || m.serviceDate),
        odometerMiles: toDecimal(m.odometerMiles || m.odometer),
        engineHours: toDecimal(m.engineHours),
        laborHours: toDecimal(m.laborHours),
        laborCost: toDecimal(m.laborCost),
        partsCost: toDecimal(m.partsCost),
        totalCost: toDecimal(m.totalCost || m.cost),
        parts: Array.isArray(m.parts) ? m.parts : [],
        technicianName: m.technicianName || m.technician || null,
        shopName: m.shopName || null,
        notes: m.notes || null,
        status: m.status || "completed",
        createdAt: toDate(m.createdAt) || new Date(),
        updatedAt: toDate(m.updatedAt) || new Date(),
      })),
      skipDuplicates: true,
    });
  });

  // ── WorkOrders ───────────────────────────────────────────────────────────
  const workOrders = Array.isArray(data.workOrders) ? data.workOrders : [];
  await batchUpsert("workOrders", workOrders, async (batch) => {
    await prisma.workOrder.createMany({
      data: batch.map((w) => ({
        id: w.id,
        orgId: w.orgId || null,
        vehicleId: w.vehicleId,
        title: w.title || "Work Order",
        description: w.description || null,
        status: w.status || "open",
        priority: w.priority || "normal",
        dueDate: toDate(w.dueDate),
        closedAt: toDate(w.closedAt),
        createdAt: toDate(w.createdAt) || new Date(),
        updatedAt: toDate(w.updatedAt) || new Date(),
      })),
      skipDuplicates: true,
    });
  });

  // ── WorkOrderLines ───────────────────────────────────────────────────────
  const lines = Array.isArray(data.workOrderLineItems) ? data.workOrderLineItems : [];
  await batchUpsert("workOrderLineItems", lines, async (batch) => {
    await prisma.workOrderLine.createMany({
      data: batch.map((l) => ({
        id: l.id,
        workOrderId: l.workOrderId,
        description: l.description || "",
        qty: toDecimal(l.qty),
        unitCost: toDecimal(l.unitCost),
        totalCost: toDecimal(l.totalCost),
        partNumber: l.partNumber || null,
        createdAt: toDate(l.createdAt) || new Date(),
      })),
      skipDuplicates: true,
    });
  });

  // ── Events ───────────────────────────────────────────────────────────────
  const events = Array.isArray(data.events) ? data.events : [];
  await batchUpsert("events", events, async (batch) => {
    await prisma.event.createMany({
      data: batch.map((e) => ({
        id: e.id,
        orgId: e.org_id || e.orgId || null,
        vehicleId: e.vehicle_id || e.vehicleId,
        type: e.type,
        severity: e.severity || "info",
        status: e.status || "open",
        dedupeKey: e.dedupe_key || null,
        detectedAt: toDate(e.detected_at || e.detectedAt) || new Date(),
        lastNotifiedAt: toDate(e.last_notified_at),
        metricsSnapshot: e.metrics_snapshot || {},
        explanation: e.explanation || "",
        recommendedActions: Array.isArray(e.recommended_actions) ? e.recommended_actions : [],
        explanationSource: e.explanation_source || "fallback",
        updatedAt: toDate(e.updated_at) || new Date(),
      })),
      skipDuplicates: true,
    });
  });

  // ── Notifications ────────────────────────────────────────────────────────
  const notifications = Array.isArray(data.notifications) ? data.notifications : [];
  await batchUpsert("notifications", notifications, async (batch) => {
    await prisma.notification.createMany({
      data: batch.map((n) => ({
        id: n.id,
        orgId: n.org_id || n.orgId || null,
        vehicleId: n.vehicle_id || n.vehicleId || null,
        eventId: n.event_id || n.eventId || null,
        recipientType: n.recipient_type || null,
        recipientId: n.recipient_id || null,
        title: n.title || "",
        body: n.body || "",
        severity: n.severity || null,
        status: n.status || "unread",
        createdAt: toDate(n.created_at || n.createdAt) || new Date(),
      })),
      skipDuplicates: true,
    });
  });

  // ── Leads ────────────────────────────────────────────────────────────────
  const leads = Array.isArray(data.leads) ? data.leads : [];
  await batchUpsert("leads", leads, async (batch) => {
    await prisma.lead.createMany({
      data: batch.map((l) => ({
        id: l.id,
        orgId: l.orgId || null,
        name: l.name || null,
        email: l.email || null,
        phone: l.phone || null,
        company: l.company || null,
        status: l.status || "NEW",
        notes: l.notes || null,
        source: l.source || null,
        vehicleCount: l.vehicleCount ? Number(l.vehicleCount) : null,
        createdAt: toDate(l.createdAt) || new Date(),
        updatedAt: toDate(l.updatedAt) || new Date(),
      })),
      skipDuplicates: true,
    });
  });

  // ── Invites ──────────────────────────────────────────────────────────────
  const invites = Array.isArray(data.invites) ? data.invites : [];
  await batchUpsert("invites", invites, async (batch) => {
    await prisma.invite.createMany({
      data: batch.map((i) => ({
        id: i.id,
        orgId: i.orgId || null,
        email: i.email || null,
        type: i.type || "CUSTOMER",
        token: i.token,
        expiresAt: toDate(i.expiresAt),
        acceptedAt: toDate(i.acceptedAt),
        createdAt: toDate(i.createdAt) || new Date(),
      })),
      skipDuplicates: true,
    });
  });

  // ── AuditLogs ────────────────────────────────────────────────────────────
  const audit = Array.isArray(data.audit) ? data.audit : [];
  await batchUpsert("auditLogs", audit, async (batch) => {
    await prisma.auditLog.createMany({
      data: batch.map((a) => ({
        id: a.id,
        orgId: a.orgId || null,
        event: a.event,
        detail: a.detail || "",
        createdAt: toDate(a.createdAt) || new Date(),
      })),
      skipDuplicates: true,
    });
  });

  // ── TelemetrySnapshots ───────────────────────────────────────────────────
  const snapshots = Array.isArray(data.telemetrySnapshots) ? data.telemetrySnapshots : [];
  await batchUpsert("telemetrySnapshots", snapshots, async (batch) => {
    await prisma.telemetrySnapshot.createMany({
      data: batch.map((s) => ({
        id: s.id,
        orgId: s.orgId || null,
        vehicleId: s.vehicleId,
        driverId: s.driverId || null,
        deviceId: s.deviceId || null,
        ts: toDate(s.ts) || new Date(),
        odometerMiles: toDecimal(s.odometerMiles),
        engineHours: toDecimal(s.engineHours),
        dtcCodes: Array.isArray(s.dtcCodes) ? s.dtcCodes : [],
        rawPids: s.rawPids || {},
        derivedMetrics: s.derivedMetrics || {},
        coolantTemp: toDecimal(s.coolantTemp),
        batteryVoltage: toDecimal(s.batteryVoltage),
        engineLoad: toDecimal(s.engineLoad),
        maf: toDecimal(s.maf),
        rpm: toDecimal(s.rpm),
        stft1: toDecimal(s.stft1),
        ltft1: toDecimal(s.ltft1),
        intakeAirTemp: toDecimal(s.intakeAirTemp),
        speedKph: toDecimal(s.speedKph),
        fuelLevelPct: toDecimal(s.fuelLevelPct),
        sourceProtocol: s.sourceProtocol || "UNKNOWN",
        vin: s.vin || null,
        createdAt: toDate(s.createdAt) || new Date(),
      })),
      skipDuplicates: true,
    });
  });
}

// ══════════════════════════════════════════════════════════════════════════
// STEP 2 — Migrate from SQLite
// ══════════════════════════════════════════════════════════════════════════

async function migrateSqlite(db) {
  log("=== Migrating SQLite database ===");

  // ── TelemetrySamples ─────────────────────────────────────────────────────
  const samples = db.prepare("SELECT * FROM telemetry_samples ORDER BY ts ASC").all();
  await batchUpsert("telemetrySamples", samples, async (batch) => {
    await prisma.telemetrySample.createMany({
      data: batch.map((r) => ({
        id: r.id,
        orgId: r.org_id || null,
        vehicleId: r.vehicle_id,
        driverId: r.driver_id || null,
        ts: toDate(r.ts) || new Date(),
        odometer: toDecimal(r.odometer),
        engineHours: toDecimal(r.engine_hours),
        metrics: JSON.parse(r.metrics || "{}"),
        raw: JSON.parse(r.raw || "{}"),
        createdAt: toDate(r.created_at) || new Date(),
      })),
      skipDuplicates: true,
    });
  });

  // ── ModelStates ──────────────────────────────────────────────────────────
  const states = db.prepare("SELECT * FROM model_states").all();
  await batchUpsert("modelStates", states, async (batch) => {
    for (const r of batch) {
      await prisma.modelState.upsert({
        where: { vehicleId: r.vehicle_id },
        create: {
          vehicleId: r.vehicle_id,
          orgId: r.org_id || null,
          state: JSON.parse(r.state || "{}"),
          updatedAt: toDate(r.updated_at) || new Date(),
        },
        update: {
          state: JSON.parse(r.state || "{}"),
          updatedAt: toDate(r.updated_at) || new Date(),
        },
      });
    }
  });

  // ── Alerts ───────────────────────────────────────────────────────────────
  const alerts = db.prepare("SELECT * FROM alerts").all();
  await batchUpsert("alerts", alerts, async (batch) => {
    await prisma.alert.createMany({
      data: batch.map((r) => ({
        id: r.id,
        orgId: r.org_id || null,
        vehicleId: r.vehicle_id,
        type: r.type,
        severity: r.severity,
        explanation: r.explanation || null,
        recommendedChecks: JSON.parse(r.recommended_checks || "[]"),
        acknowledged: Boolean(r.acknowledged),
        resolved: Boolean(r.resolved),
        createdAt: toDate(r.created_at) || new Date(),
        ackAt: toDate(r.ack_at),
        resolvedAt: toDate(r.resolved_at),
      })),
      skipDuplicates: true,
    });
  });

  // ── AiReports ────────────────────────────────────────────────────────────
  const reports = db.prepare("SELECT * FROM ai_reports").all();
  await batchUpsert("aiReports", reports, async (batch) => {
    await prisma.aiReport.createMany({
      data: batch.map((r) => ({
        id: r.id,
        orgId: r.org_id || null,
        vehicleId: r.vehicle_id,
        narrative: r.narrative,
        predictionSnapshot: JSON.parse(r.prediction_snapshot || "{}"),
        modelUsed: r.model_used || null,
        createdAt: toDate(r.created_at) || new Date(),
      })),
      skipDuplicates: true,
    });
  });

  // ── VehicleCapabilities ──────────────────────────────────────────────────
  const caps = db.prepare("SELECT * FROM vehicle_capabilities").all();
  await batchUpsert("vehicleCapabilities", caps, async (batch) => {
    for (const r of batch) {
      await prisma.vehicleCapability.upsert({
        where: { vehicleId: r.vehicle_id },
        create: {
          vehicleId: r.vehicle_id,
          vin: r.vin || null,
          year: r.year ? Number(r.year) : null,
          make: r.make || null,
          modelYearStr: r.model_year_str || null,
          supportedSensors: JSON.parse(r.supported_sensors || "[]"),
          addonEligible: Boolean(r.addon_eligible),
          addonSensors: JSON.parse(r.addon_sensors || "[]"),
          detectedAt: toDate(r.detected_at) || new Date(),
          updatedAt: toDate(r.updated_at) || new Date(),
        },
        update: {
          supportedSensors: JSON.parse(r.supported_sensors || "[]"),
          updatedAt: toDate(r.updated_at) || new Date(),
        },
      });
    }
  });

  // ── FuelEvents ───────────────────────────────────────────────────────────
  const fuel = db.prepare("SELECT * FROM fuel_events").all();
  await batchUpsert("fuelEvents", fuel, async (batch) => {
    await prisma.fuelEvent.createMany({
      data: batch.map((r) => ({
        id: r.id,
        orgId: r.org_id || null,
        vehicleId: r.vehicle_id,
        tsStart: toDate(r.ts_start),
        tsEnd: toDate(r.ts_end),
        fuelLevelBefore: toDecimal(r.fuel_level_before),
        fuelLevelAfter: toDecimal(r.fuel_level_after),
        gallonsEstimated: toDecimal(r.gallons_estimated),
        detectedBy: r.detected_by || "AUTO",
        confidence: toDecimal(r.confidence),
        note: r.note || null,
        createdAt: toDate(r.created_at) || new Date(),
      })),
      skipDuplicates: true,
    });
  });

  // ── MlModelArtifacts ─────────────────────────────────────────────────────
  const artifacts = db.prepare("SELECT * FROM ml_model_artifacts").all();
  await batchUpsert("mlModelArtifacts", artifacts, async (batch) => {
    await prisma.mlModelArtifact.createMany({
      data: batch.map((r) => ({
        id: r.id,
        modelVersion: r.model_version,
        trainingSource: r.training_source || null,
        modelName: r.model_name || null,
        metadata: JSON.parse(r.metadata || "{}"),
        artifactPath: r.artifact_path || null,
        createdAt: toDate(r.created_at) || new Date(),
      })),
      skipDuplicates: true,
    });
  });

  // ── MlBaselineProfiles ───────────────────────────────────────────────────
  const profiles = db.prepare("SELECT * FROM ml_baseline_profiles").all();
  await batchUpsert("mlBaselineProfiles", profiles, async (batch) => {
    for (const r of batch) {
      await prisma.mlBaselineProfile.upsert({
        where: { profileKey: r.profile_key },
        create: {
          profileKey: r.profile_key,
          vehicleClass: r.vehicle_class || null,
          make: r.make || null,
          model: r.model || null,
          protocol: r.protocol || null,
          powertrain: r.powertrain || null,
          trainingSource: r.training_source || null,
          modelVersion: r.model_version || null,
          profileJson: JSON.parse(r.profile_json || "{}"),
          updatedAt: toDate(r.updated_at) || new Date(),
        },
        update: {
          profileJson: JSON.parse(r.profile_json || "{}"),
          updatedAt: toDate(r.updated_at) || new Date(),
        },
      });
    }
  });

  // ── MlPredictionRuns ─────────────────────────────────────────────────────
  const runs = db.prepare("SELECT * FROM ml_prediction_runs").all();
  await batchUpsert("mlPredictionRuns", runs, async (batch) => {
    await prisma.mlPredictionRun.createMany({
      data: batch.map((r) => ({
        id: r.id,
        orgId: r.org_id || null,
        vehicleId: r.vehicle_id,
        modelVersion: r.model_version || null,
        source: r.source || "unknown",
        confidenceStage: r.confidence_stage || null,
        confidence: toDecimal(r.confidence),
        riskProbability: toDecimal(r.risk_probability),
        healthScore: toDecimal(r.health_score),
        predictionJson: JSON.parse(r.prediction_json || "{}"),
        createdAt: toDate(r.created_at) || new Date(),
      })),
      skipDuplicates: true,
    });
  });

  // ── MlFeatureSnapshots ───────────────────────────────────────────────────
  const features = db.prepare("SELECT * FROM ml_feature_snapshots").all();
  await batchUpsert("mlFeatureSnapshots", features, async (batch) => {
    await prisma.mlFeatureSnapshot.createMany({
      data: batch.map((r) => ({
        id: r.id,
        orgId: r.org_id || null,
        vehicleId: r.vehicle_id,
        predictionRunId: r.prediction_run_id || null,
        featureJson: JSON.parse(r.feature_json || "{}"),
        createdAt: toDate(r.created_at) || new Date(),
      })),
      skipDuplicates: true,
    });
  });
}

// ══════════════════════════════════════════════════════════════════════════
// STEP 3 — Verify row counts
// ══════════════════════════════════════════════════════════════════════════

async function verifyRowCounts(sqliteDb, jsonData) {
  log("=== Verification ===");
  const checks = [
    ["users", () => prisma.user.count(), () => (jsonData.users || []).length],
    ["orgs", () => prisma.org.count(), () => (jsonData.orgs || []).length],
    ["vehicles", () => prisma.vehicle.count(), () => (jsonData.vehicles || []).length],
    ["drivers", () => prisma.driver.count(), () => (jsonData.drivers || []).length],
    ["pairings", () => prisma.pairing.count(), () => (jsonData.pairings || []).length],
    ["telemetrySamples (SQLite)", () => prisma.telemetrySample.count(), () => sqliteDb.prepare("SELECT COUNT(*) AS c FROM telemetry_samples").get().c],
    ["alerts (SQLite)", () => prisma.alert.count(), () => sqliteDb.prepare("SELECT COUNT(*) AS c FROM alerts").get().c],
    ["aiReports (SQLite)", () => prisma.aiReport.count(), () => sqliteDb.prepare("SELECT COUNT(*) AS c FROM ai_reports").get().c],
  ];

  let allMatch = true;
  for (const [label, pgCount, sourceCount] of checks) {
    const pg = await pgCount();
    const src = sourceCount();
    const match = pg >= src;
    const status = match ? "OK" : "MISMATCH";
    log(`${status}  ${label}: source=${src} postgres=${pg}`);
    if (!match) allMatch = false;
  }
  return allMatch;
}

// ══════════════════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════════════════

async function main() {
  log("Fleet AI → PostgreSQL migration starting");
  log(`SQLite path: ${SQLITE_PATH}`);
  log(`JSON store path: ${AUTH_STORE_PATH}`);

  if (!process.env.DATABASE_URL) {
    console.error("[migrate] ERROR: DATABASE_URL is not set. Set it to your PostgreSQL connection string.");
    process.exit(1);
  }

  // Load JSON store
  const jsonData = readJsonStore(AUTH_STORE_PATH);

  // Load SQLite
  let sqliteDb = null;
  if (fs.existsSync(SQLITE_PATH)) {
    sqliteDb = new Database(SQLITE_PATH, { readonly: true });
    log(`SQLite opened: ${SQLITE_PATH}`);
  } else {
    warn(`SQLite not found at ${SQLITE_PATH} — skipping SQLite migration`);
  }

  // Migrate JSON store first (orgs, users, vehicles must exist before relations)
  await migrateJsonStore(jsonData);

  // Migrate SQLite (telemetry, ML — references vehicles)
  if (sqliteDb) {
    await migrateSqlite(sqliteDb);
    sqliteDb.close();
  }

  // Verify
  const ok = await verifyRowCounts(
    sqliteDb || { prepare: () => ({ get: () => ({ c: 0 }) }) },
    jsonData
  );

  if (ok) {
    log("Migration complete. All row counts match.");
  } else {
    log("Migration complete with WARNINGS. Review MISMATCH rows above.");
    process.exit(1);
  }
}

main()
  .catch((err) => {
    console.error("[migrate] Fatal:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
