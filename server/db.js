const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { PrismaClient } = require("@prisma/client");
const { Pool } = require("pg");
const { PrismaPg } = require("@prisma/adapter-pg");

let _prisma = null;
let _pool = null;

function getPrisma() {
  if (!_prisma) {
    if (!_pool) {
      _pool = new Pool({ connectionString: process.env.DATABASE_URL });
    }
    const adapter = new PrismaPg(_pool);
    _prisma = new PrismaClient({ adapter });
  }
  return _prisma;
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

// Ensure a minimal Vehicle stub exists so FK constraints are satisfied.
// ML data arrives before the fleet manager creates the Vehicle record.
async function ensureVehicleStub(vehicleId) {
  if (!vehicleId) return;
  await getPrisma().vehicle.upsert({
    where: { vehicleId },
    update: {},
    create: { vehicleId, unitName: vehicleId }
  });
}

function toDate(v) {
  if (!v) return new Date();
  if (v instanceof Date) return v;
  return new Date(v);
}

// ─── Telemetry Samples ────────────────────────────────────────────────────────

async function insertTelemetrySample(sample) {
  await ensureVehicleStub(sample.vehicleId);
  await getPrisma().telemetrySample.upsert({
    where: { id: sample.id },
    update: {
      orgId: sample.orgId || null,
      driverId: sample.driverId || null,
      ts: toDate(sample.ts),
      odometer: sample.odometer ?? null,
      engineHours: sample.engineHours ?? null,
      metrics: sample.metrics || {},
      raw: sample.raw || {}
    },
    create: {
      id: sample.id,
      orgId: sample.orgId || null,
      vehicleId: sample.vehicleId,
      driverId: sample.driverId || null,
      ts: toDate(sample.ts),
      odometer: sample.odometer ?? null,
      engineHours: sample.engineHours ?? null,
      metrics: sample.metrics || {},
      raw: sample.raw || {}
    }
  });
}

function rowToSample(row) {
  return {
    id: row.id,
    orgId: row.orgId,
    vehicleId: row.vehicleId,
    driverId: row.driverId,
    ts: row.ts instanceof Date ? row.ts.toISOString() : row.ts,
    odometer: row.odometer !== null ? Number(row.odometer) : null,
    engineHours: row.engineHours !== null ? Number(row.engineHours) : null,
    metrics: row.metrics || {},
    raw: row.raw || {}
  };
}

async function getSamplesForVehicle(vehicleId, { limit = 5000, since = null } = {}) {
  const where = { vehicleId };
  if (since) where.ts = { gte: toDate(since) };
  const rows = await getPrisma().telemetrySample.findMany({
    where,
    orderBy: { ts: "desc" },
    take: limit
  });
  return rows.reverse().map(rowToSample);
}

async function getSampleCountForVehicle(vehicleId) {
  return getPrisma().telemetrySample.count({ where: { vehicleId } });
}

// ─── Model States ─────────────────────────────────────────────────────────────

async function upsertModelState(state) {
  await ensureVehicleStub(state.vehicleId);
  const existing = await getPrisma().modelState.findUnique({
    where: { vehicleId: state.vehicleId },
    select: { state: true }
  });
  const mergedState = Object.assign({}, existing?.state || {}, state);
  await getPrisma().modelState.upsert({
    where: { vehicleId: state.vehicleId },
    update: { orgId: state.orgId || null, state: mergedState },
    create: { vehicleId: state.vehicleId, orgId: state.orgId || null, state: mergedState }
  });
}

async function getModelState(vehicleId) {
  const row = await getPrisma().modelState.findUnique({ where: { vehicleId } });
  return row ? row.state : null;
}

async function getAllModelStates() {
  const rows = await getPrisma().modelState.findMany({ orderBy: { updatedAt: "desc" } });
  return rows.map((r) => Object.assign({}, r.state || {}, {
    vehicleId: r.state?.vehicleId || r.vehicleId,
    orgId: r.state?.orgId || r.orgId || null
  }));
}

// ─── Alerts ───────────────────────────────────────────────────────────────────

function buildAlertDedupeKey(alert) {
  const key = String(alert?.dedupeKey || "").trim();
  return key || null;
}

async function insertAlert(alert) {
  await ensureVehicleStub(alert.vehicleId);
  const dedupeKey = buildAlertDedupeKey(alert);
  const create = {
    id: alert.id,
    dedupeKey,
    orgId: alert.orgId || null,
    vehicleId: alert.vehicleId,
    type: alert.type,
    severity: alert.severity,
    explanation: alert.explanation || null,
    recommendedChecks: alert.recommendedChecks || [],
    createdAt: toDate(alert.createdAt)
  };
  if (!dedupeKey) {
    await getPrisma().alert.upsert({ where: { id: alert.id }, update: {}, create });
    return alert.id;
  }
  return getPrisma().$transaction(async (tx) => {
    const existing = await tx.alert.findFirst({ where: { dedupeKey }, orderBy: { createdAt: "desc" } });
    if (!existing) {
      const row = await tx.alert.create({ data: create });
      return row.id;
    }
    const reopening = Boolean(existing.resolved);
    const row = await tx.alert.update({
      where: { id: existing.id },
      data: {
        orgId: alert.orgId || null,
        vehicleId: alert.vehicleId,
        type: alert.type,
        severity: alert.severity,
        explanation: alert.explanation || null,
        recommendedChecks: alert.recommendedChecks || [],
        resolved: false,
        resolvedAt: null,
        ...(reopening ? {
          acknowledged: false,
          ackAt: null,
          createdAt: toDate(alert.createdAt)
        } : {})
      }
    });
    return row.id;
  });
}

async function resolveInactiveMlAlerts(vehicleId, activeDedupeKeys = []) {
  if (!vehicleId) return 0;
  const dedupeKey = { startsWith: `ML:${vehicleId}:` };
  if (activeDedupeKeys.length) dedupeKey.notIn = activeDedupeKeys;
  const result = await getPrisma().alert.updateMany({
    where: { vehicleId, resolved: false, dedupeKey },
    data: { resolved: true, resolvedAt: new Date() }
  });
  return result.count;
}

function rowToAlert(row) {
  return {
    id: row.id,
    dedupeKey: row.dedupeKey || null,
    orgId: row.orgId,
    vehicleId: row.vehicleId,
    type: row.type,
    severity: row.severity,
    explanation: row.explanation,
    recommendedChecks: Array.isArray(row.recommendedChecks) ? row.recommendedChecks : [],
    acknowledged: Boolean(row.acknowledged),
    resolved: Boolean(row.resolved),
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    ackAt: row.ackAt instanceof Date ? row.ackAt.toISOString() : row.ackAt,
    resolvedAt: row.resolvedAt instanceof Date ? row.resolvedAt.toISOString() : row.resolvedAt
  };
}

async function getAlertsForVehicle(vehicleId, { limit = 50, unresolvedOnly = false } = {}) {
  const where = { vehicleId };
  if (unresolvedOnly) where.resolved = false;
  const rows = await getPrisma().alert.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit
  });
  return rows.map(rowToAlert);
}

async function getAlertsForOrg(orgId, { limit = 100, unresolvedOnly = false } = {}) {
  const where = { orgId };
  if (unresolvedOnly) where.resolved = false;
  const rows = await getPrisma().alert.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit
  });
  return rows.map(rowToAlert);
}

async function getAlertById(id) {
  if (!id) return null;
  const row = await getPrisma().alert.findUnique({ where: { id } });
  return row ? rowToAlert(row) : null;
}

async function ackAlert(id) {
  await getPrisma().alert.update({
    where: { id },
    data: { acknowledged: true, ackAt: new Date() }
  });
}

async function resolveAlert(id) {
  await getPrisma().alert.update({
    where: { id },
    data: { resolved: true, resolvedAt: new Date() }
  });
}

// ─── AI Reports ───────────────────────────────────────────────────────────────

async function insertAiReport(report) {
  const id = report.id || makeId("RPT");
  await ensureVehicleStub(report.vehicleId);
  await getPrisma().aiReport.create({
    data: {
      id,
      orgId: report.orgId || null,
      vehicleId: report.vehicleId,
      narrative: report.narrative,
      predictionSnapshot: report.predictionSnapshot || {},
      modelUsed: report.modelUsed || null,
      createdAt: toDate(report.createdAt)
    }
  });
  return id;
}

async function getLatestAiReport(vehicleId) {
  const row = await getPrisma().aiReport.findFirst({
    where: { vehicleId },
    orderBy: { createdAt: "desc" }
  });
  if (!row) return null;
  return {
    id: row.id,
    orgId: row.orgId,
    vehicleId: row.vehicleId,
    narrative: row.narrative,
    predictionSnapshot: row.predictionSnapshot || {},
    modelUsed: row.modelUsed,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt
  };
}

// ─── Vehicle Capabilities ─────────────────────────────────────────────────────

async function upsertVehicleCapabilities(cap) {
  await ensureVehicleStub(cap.vehicleId);
  const now = new Date();
  await getPrisma().vehicleCapability.upsert({
    where: { vehicleId: cap.vehicleId },
    update: {
      vin: cap.vin || null,
      year: cap.year || null,
      make: cap.make || null,
      modelYearStr: cap.modelYearStr || null,
      supportedSensors: cap.supportedSensors || [],
      addonEligible: Boolean(cap.addonEligible),
      addonSensors: cap.addonSensors || [],
      updatedAt: now
    },
    create: {
      vehicleId: cap.vehicleId,
      vin: cap.vin || null,
      year: cap.year || null,
      make: cap.make || null,
      modelYearStr: cap.modelYearStr || null,
      supportedSensors: cap.supportedSensors || [],
      addonEligible: Boolean(cap.addonEligible),
      addonSensors: cap.addonSensors || [],
      detectedAt: toDate(cap.detectedAt) || now
    }
  });
}

async function getVehicleCapabilities(vehicleId) {
  const row = await getPrisma().vehicleCapability.findUnique({ where: { vehicleId } });
  if (!row) return null;
  return {
    vehicleId: row.vehicleId,
    vin: row.vin,
    year: row.year,
    make: row.make,
    modelYearStr: row.modelYearStr,
    supportedSensors: row.supportedSensors || [],
    addonEligible: Boolean(row.addonEligible),
    addonSensors: row.addonSensors || [],
    detectedAt: row.detectedAt instanceof Date ? row.detectedAt.toISOString() : row.detectedAt,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt
  };
}

// ─── Fuel Events ──────────────────────────────────────────────────────────────

async function insertFuelEvent(evt) {
  await ensureVehicleStub(evt.vehicleId);
  await getPrisma().fuelEvent.upsert({
    where: { id: evt.id },
    update: {},
    create: {
      id: evt.id,
      orgId: evt.orgId || null,
      vehicleId: evt.vehicleId,
      tsStart: evt.tsStart || evt.startTs ? toDate(evt.tsStart || evt.startTs) : null,
      tsEnd: evt.tsEnd || evt.endTs ? toDate(evt.tsEnd || evt.endTs) : null,
      fuelLevelBefore: evt.fuelLevelBefore ?? null,
      fuelLevelAfter: evt.fuelLevelAfter ?? null,
      gallonsEstimated: evt.gallonsEstimated ?? null,
      detectedBy: evt.detectedBy || "AUTO",
      confidence: evt.confidence ?? null,
      note: evt.note || null
    }
  });
}

async function getFuelEventsForVehicle(vehicleId, limit = 20) {
  const rows = await getPrisma().fuelEvent.findMany({
    where: { vehicleId },
    orderBy: { tsEnd: "desc" },
    take: limit
  });
  return rows.map((r) => ({
    id: r.id,
    orgId: r.orgId,
    vehicleId: r.vehicleId,
    tsStart: r.tsStart instanceof Date ? r.tsStart.toISOString() : r.tsStart,
    tsEnd: r.tsEnd instanceof Date ? r.tsEnd.toISOString() : r.tsEnd,
    fuelLevelBefore: r.fuelLevelBefore !== null ? Number(r.fuelLevelBefore) : null,
    fuelLevelAfter: r.fuelLevelAfter !== null ? Number(r.fuelLevelAfter) : null,
    gallonsEstimated: r.gallonsEstimated !== null ? Number(r.gallonsEstimated) : null,
    detectedBy: r.detectedBy,
    confidence: r.confidence !== null ? Number(r.confidence) : null,
    note: r.note
  }));
}

// ─── ML Model Artifacts ───────────────────────────────────────────────────────

async function upsertMlModelArtifact(metadata = {}, artifactPath = null) {
  const modelVersion = metadata.modelVersion || metadata.model_version || "unknown";
  const id = `MLART_${modelVersion}`;
  await getPrisma().mlModelArtifact.upsert({
    where: { id },
    update: {
      trainingSource: metadata.trainingSource || metadata.training_source || null,
      modelName: metadata.model_name || metadata.modelName || null,
      metadata,
      artifactPath: artifactPath || metadata.model_file || null
    },
    create: {
      id,
      modelVersion,
      trainingSource: metadata.trainingSource || metadata.training_source || null,
      modelName: metadata.model_name || metadata.modelName || null,
      metadata,
      artifactPath: artifactPath || metadata.model_file || null
    }
  });
  return id;
}

// ─── ML Baseline Profiles ─────────────────────────────────────────────────────

async function upsertMlBaselineProfile(profile = {}) {
  const key = profile.profileKey || profile.profile_key;
  if (!key) return null;
  await getPrisma().mlBaselineProfile.upsert({
    where: { profileKey: key },
    update: {
      vehicleClass: profile.vehicleClass || profile.vehicle_class || null,
      make: profile.make || null,
      model: profile.model || null,
      protocol: profile.protocol || null,
      powertrain: profile.powertrain || null,
      trainingSource: profile.trainingSource || profile.training_source || null,
      modelVersion: profile.modelVersion || profile.model_version || null,
      profileJson: profile
    },
    create: {
      profileKey: key,
      vehicleClass: profile.vehicleClass || profile.vehicle_class || null,
      make: profile.make || null,
      model: profile.model || null,
      protocol: profile.protocol || null,
      powertrain: profile.powertrain || null,
      trainingSource: profile.trainingSource || profile.training_source || null,
      modelVersion: profile.modelVersion || profile.model_version || null,
      profileJson: profile
    }
  });
  return key;
}

async function getMlBaselineProfile(profileKey) {
  const row = await getPrisma().mlBaselineProfile.findUnique({ where: { profileKey } });
  return row ? row.profileJson : null;
}

async function findMlBaselineProfile({ make, model, vehicleClass } = {}) {
  const rows = await getPrisma().mlBaselineProfile.findMany();
  const norm = (v) => String(v || "").trim().toLowerCase();
  const exact = rows.find(
    (r) => norm(r.make) === norm(make) && norm(r.model) === norm(model) && (!vehicleClass || norm(r.vehicleClass) === norm(vehicleClass))
  );
  const byMake = rows.find(
    (r) => norm(r.make) === norm(make) && (!vehicleClass || norm(r.vehicleClass) === norm(vehicleClass))
  );
  const byClass = rows.find((r) => vehicleClass && norm(r.vehicleClass) === norm(vehicleClass));
  const row = exact || byMake || byClass || rows[0];
  return row ? row.profileJson : null;
}

// ─── ML Prediction Runs ───────────────────────────────────────────────────────

async function insertMlPredictionRun(run = {}) {
  const id = run.id || makeId("MLRUN");
  await ensureVehicleStub(run.vehicleId);
  await getPrisma().mlPredictionRun.create({
    data: {
      id,
      orgId: run.orgId || null,
      vehicleId: run.vehicleId,
      modelVersion: run.modelVersion || null,
      source: run.source || "unknown",
      confidenceStage: run.confidenceStage || null,
      confidence: run.confidence ?? null,
      riskProbability: run.riskProbability ?? null,
      healthScore: run.healthScore ?? null,
      predictionJson: run.prediction || {},
      createdAt: toDate(run.createdAt)
    }
  });
  return id;
}

// ─── ML Feature Snapshots ─────────────────────────────────────────────────────

async function insertMlFeatureSnapshot(snapshot = {}) {
  const id = snapshot.id || makeId("MLFEAT");
  await ensureVehicleStub(snapshot.vehicleId);
  await getPrisma().mlFeatureSnapshot.create({
    data: {
      id,
      orgId: snapshot.orgId || null,
      vehicleId: snapshot.vehicleId,
      predictionRunId: snapshot.predictionRunId || null,
      featureJson: snapshot.features || {},
      createdAt: toDate(snapshot.createdAt)
    }
  });
  return id;
}

// ─── Vehicles ─────────────────────────────────────────────────────────────────

function rowToVehicle(row) {
  return {
    id: row.id,
    vehicleId: row.vehicleId,
    unitName: row.unitName,
    vin: row.vin,
    type: row.type,
    orgId: row.orgId,
    year: row.year,
    make: row.make,
    model: row.model,
    motiveId: row.motiveId,
    motiveMetadata: row.motiveMetadata || {},
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt
  };
}

async function createVehicle(vehicle) {
  const row = await getPrisma().vehicle.create({
    data: {
      vehicleId: vehicle.vehicleId,
      unitName: vehicle.unitName,
      vin: vehicle.vin || null,
      type: vehicle.type || null,
      orgId: vehicle.orgId || null,
      year: vehicle.year ?? null,
      make: vehicle.make || null,
      model: vehicle.model || null
    }
  });
  return rowToVehicle(row);
}

async function listVehicles({ orgId } = {}) {
  const rows = await getPrisma().vehicle.findMany({
    where: orgId ? { orgId } : {},
    orderBy: { createdAt: "asc" }
  });
  return rows.map(rowToVehicle);
}

async function getVehicleByVehicleId(vehicleId) {
  if (!vehicleId) return null;
  const row = await getPrisma().vehicle.findUnique({ where: { vehicleId } });
  return row ? rowToVehicle(row) : null;
}

async function getVehicleByVin(vin) {
  const normalizedVin = String(vin || "").trim().toUpperCase();
  if (!normalizedVin) return null;
  const row = await getPrisma().vehicle.findFirst({
    where: { vin: { equals: normalizedVin, mode: "insensitive" } }
  });
  return row ? rowToVehicle(row) : null;
}

async function transferVehicleToOrg(vehicleId, orgId, patch = {}) {
  const prisma = getPrisma();
  const revokedAt = new Date();
  const vehicleData = {
    orgId,
    unitName: patch.unitName || undefined,
    vin: patch.vin ? String(patch.vin).trim().toUpperCase() : undefined,
    type: patch.type || undefined,
    year: patch.year ?? undefined,
    make: patch.make || undefined,
    model: patch.model || undefined
  };
  const operations = [
    // A tablet session must never survive a tenant transfer. The new owner can
    // issue a fresh pairing after assigning one of its own drivers.
    prisma.pairing.updateMany({
      where: { vehicleId },
      data: {
        orgId,
        status: "expired",
        expiresAt: revokedAt,
        revokedAt,
        deviceTokenHash: null,
        deviceTokenIssuedAt: null
      }
    }),
    prisma.telemetrySample.updateMany({ where: { vehicleId }, data: { orgId } }),
    prisma.telemetrySnapshot.updateMany({ where: { vehicleId }, data: { orgId } }),
    prisma.telemetryRecord.updateMany({ where: { vehicleId }, data: { orgId } }),
    prisma.modelState.updateMany({ where: { vehicleId }, data: { orgId } }),
    prisma.mlPredictionRun.updateMany({ where: { vehicleId }, data: { orgId } }),
    prisma.mlFeatureSnapshot.updateMany({ where: { vehicleId }, data: { orgId } }),
    prisma.baseline.updateMany({ where: { vehicleId }, data: { orgId } }),
    prisma.trendSignal.updateMany({ where: { vehicleId }, data: { orgId } }),
    prisma.feedbackLog.updateMany({ where: { vehicleId }, data: { orgId } }),
    prisma.patternSignature.updateMany({ where: { vehicleId }, data: { orgId } }),
    prisma.recommendation.updateMany({ where: { vehicleId }, data: { orgId } }),
    prisma.alert.updateMany({ where: { vehicleId }, data: { orgId } }),
    prisma.event.updateMany({ where: { vehicleId }, data: { orgId } }),
    prisma.notification.updateMany({ where: { vehicleId }, data: { orgId } }),
    prisma.aiReport.updateMany({ where: { vehicleId }, data: { orgId } }),
    prisma.fuelEvent.updateMany({ where: { vehicleId }, data: { orgId } }),
    prisma.maintenanceLog.updateMany({ where: { vehicleId }, data: { orgId } }),
    prisma.workOrder.updateMany({ where: { vehicleId }, data: { orgId } }),
    prisma.diagnosticScan.updateMany({ where: { vehicleId }, data: { orgId } }),
    prisma.vehicle.update({ where: { vehicleId }, data: vehicleData })
  ];
  const results = await prisma.$transaction(operations);
  return rowToVehicle(results[results.length - 1]);
}

async function deleteVehicleByVehicleId(vehicleId) {
  try {
    const row = await getPrisma().vehicle.delete({ where: { vehicleId } });
    return rowToVehicle(row);
  } catch (err) {
    if (err.code === "P2025") return null; // Prisma "record not found"
    throw err;
  }
}

async function findVehicleByMotiveIdOrVin(motiveId, vin) {
  if (motiveId) {
    const byMotive = await getPrisma().vehicle.findUnique({ where: { motiveId } });
    if (byMotive) return rowToVehicle(byMotive);
  }
  if (vin) {
    const byVin = await getPrisma().vehicle.findFirst({ where: { vin } });
    if (byVin) return rowToVehicle(byVin);
  }
  return null;
}

// Upserts a vehicle from Motive webhook/sync data. Matches by motiveId then VIN
// (mirrors the old flat-file matching order in motiveWebhookReceiver.js/motiveSync.js).
// Motive-specific device bookkeeping (motiveDeviceId, motiveDeviceIdentifier,
// motiveDeviceModel, metricUnits, source) lives in motiveMetadata (a flexible JSON
// blob) rather than one dedicated column each, since that integration is still
// evolving and its exact field set isn't stable yet.
async function upsertVehicleFromMotive({ motiveId, vin, make, model, year, unitName, orgId, metadata }) {
  const normalizedVin = vin ? String(vin).trim().toUpperCase() : null;
  const existing = await findVehicleByMotiveIdOrVin(motiveId, normalizedVin);
  const yearInt = year != null && year !== "" ? parseInt(year, 10) : null;
  const safeYear = Number.isFinite(yearInt) ? yearInt : null;

  if (existing) {
    const mergedMetadata = Object.assign({}, existing.motiveMetadata || {}, metadata || {});
    const row = await getPrisma().vehicle.update({
      where: { vehicleId: existing.vehicleId },
      data: {
        motiveId: motiveId || existing.motiveId,
        vin: normalizedVin || existing.vin,
        make: make || existing.make,
        model: model || existing.model,
        year: safeYear ?? existing.year,
        unitName: unitName || existing.unitName,
        motiveMetadata: mergedMetadata
      }
    });
    return { vehicle: rowToVehicle(row), created: false };
  }

  const vehicleId = makeId("VEH");
  const row = await getPrisma().vehicle.create({
    data: {
      vehicleId,
      unitName: unitName || vehicleId,
      vin: normalizedVin || null,
      make: make || null,
      model: model || null,
      year: safeYear,
      motiveId: motiveId || null,
      orgId: orgId || null,
      motiveMetadata: metadata || {}
    }
  });
  return { vehicle: rowToVehicle(row), created: true };
}

async function updateVehicleMotiveMetadata(vehicleId, patch = {}) {
  const existing = await getVehicleByVehicleId(vehicleId);
  if (!existing) return null;
  const merged = Object.assign({}, existing.motiveMetadata || {}, patch);
  const row = await getPrisma().vehicle.update({ where: { vehicleId }, data: { motiveMetadata: merged } });
  return rowToVehicle(row);
}

// Replaces resolveOrgIdForVehicle (server.js:2091) which scanned a denormalized
// org.vehicleIds array. Vehicle.orgId is a direct FK — this is a single lookup.
async function getVehicleOrgId(vehicleId, fallback = "ORG_DEFAULT") {
  if (!vehicleId) return fallback;
  const row = await getPrisma().vehicle.findUnique({ where: { vehicleId }, select: { orgId: true } });
  return (row && row.orgId) || fallback;
}

// ─── Drivers ──────────────────────────────────────────────────────────────────

function rowToDriver(row) {
  return {
    id: row.id,
    driverId: row.driverId,
    firstName: row.firstName,
    lastName: row.lastName,
    email: row.email,
    phone: row.phone,
    pin: row.pin,
    orgId: row.orgId,
    status: row.status,
    licenseNum: row.licenseNum,
    motiveId: row.motiveId,
    motiveMetadata: row.motiveMetadata || {},
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt
  };
}

async function createDriver(driver) {
  const row = await getPrisma().driver.create({
    data: {
      driverId: driver.driverId,
      firstName: driver.firstName || null,
      lastName: driver.lastName || null,
      phone: driver.phone || null,
      email: driver.email || null,
      orgId: driver.orgId || null,
      pin: driver.pin || null,
      licenseNum: driver.licenseNum || null
    }
  });
  return rowToDriver(row);
}

async function listDrivers({ orgId } = {}) {
  const rows = await getPrisma().driver.findMany({
    where: orgId ? { orgId } : {},
    orderBy: { createdAt: "asc" }
  });
  return rows.map(rowToDriver);
}

async function getDriverByDriverId(driverId) {
  if (!driverId) return null;
  const row = await getPrisma().driver.findUnique({ where: { driverId } });
  return row ? rowToDriver(row) : null;
}

async function deleteDriverByDriverId(driverId) {
  try {
    const row = await getPrisma().driver.delete({ where: { driverId } });
    return rowToDriver(row);
  } catch (err) {
    if (err.code === "P2025") return null;
    throw err;
  }
}

async function findDriverByMotiveUserId(motiveUserId) {
  if (!motiveUserId) return null;
  const row = await getPrisma().driver.findUnique({ where: { motiveId: motiveUserId } });
  return row ? rowToDriver(row) : null;
}

async function upsertDriverFromMotive({ motiveUserId, firstName, lastName, email, phone, orgId }) {
  const existing = await findDriverByMotiveUserId(motiveUserId);
  if (existing) {
    const row = await getPrisma().driver.update({
      where: { driverId: existing.driverId },
      data: {
        firstName: firstName || existing.firstName,
        lastName: lastName || existing.lastName,
        email: email || existing.email,
        phone: phone || existing.phone,
        status: "active"
      }
    });
    return { driver: rowToDriver(row), created: false };
  }
  const driverId = makeId("DRV");
  const row = await getPrisma().driver.create({
    data: {
      driverId,
      motiveId: motiveUserId,
      firstName: firstName || "",
      lastName: lastName || "",
      email: email || "",
      phone: phone || "",
      orgId: orgId || null,
      status: "active"
    }
  });
  return { driver: rowToDriver(row), created: true };
}

async function updateDriverMotiveMetadata(driverId, patch = {}) {
  const existing = await getDriverByDriverId(driverId);
  if (!existing) return null;
  const prismaRow = await getPrisma().driver.findUnique({ where: { driverId }, select: { motiveMetadata: true } });
  const merged = Object.assign({}, prismaRow?.motiveMetadata || {}, patch);
  const row = await getPrisma().driver.update({ where: { driverId }, data: { motiveMetadata: merged } });
  return rowToDriver(row);
}

// ─── Users (minimal — auth itself stays on prismaAuthAdapter.js) ──────────────

async function getUserById(userId) {
  if (!userId) return null;
  const row = await getPrisma().user.findUnique({ where: { id: userId } });
  if (!row) return null;
  return { id: row.id, email: row.email, orgId: row.orgId || null, role: row.role };
}

// Notification.vehicleId has no FK constraint (plain string field), so no
// ensureVehicleStub needed here — safe to pass "unknown" for unresolved vehicles.
async function createNotification({ orgId, vehicleId, eventId, recipientType, recipientId, title, body, severity } = {}) {
  await getPrisma().notification.create({
    data: {
      orgId: orgId || null,
      vehicleId: vehicleId || null,
      eventId: eventId || null,
      recipientType: recipientType || "fleet_manager",
      recipientId: recipientId || orgId || null,
      title,
      body,
      severity: severity || null
    }
  });
}

async function logAudit({ orgId, userId, event, detail } = {}) {
  if (!event) return;
  await getPrisma().auditLog.create({
    data: {
      orgId: orgId || null,
      userId: userId || null,
      event,
      detail: detail || ""
    }
  });
}

// ─── Orgs ─────────────────────────────────────────────────────────────────────

function rowToOrg(row) {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    email: row.email,
    phone: row.phone,
    address: row.address,
    industry: row.industry,
    companyCode: row.companyCode,
    vehicleIds: Array.isArray(row.vehicleIds) ? row.vehicleIds : [],
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt
  };
}

async function createOrg(org) {
  const id = org.id || makeId("ORG");
  const row = await getPrisma().org.create({
    data: {
      id,
      name: org.name || id,
      status: org.status || "LEAD",
      email: org.email || null,
      phone: org.phone || null,
      address: org.address || null,
      industry: org.industry || null,
      companyCode: org.companyCode || null
    }
  });
  return rowToOrg(row);
}

async function getOrg(orgId) {
  if (!orgId) return null;
  const row = await getPrisma().org.findUnique({ where: { id: orgId } });
  return row ? rowToOrg(row) : null;
}

async function listOrgs() {
  const rows = await getPrisma().org.findMany({ orderBy: { createdAt: "asc" } });
  return rows.map(rowToOrg);
}

async function updateOrg(orgId, patch = {}) {
  const data = {};
  for (const key of ["name", "status", "email", "phone", "address", "industry", "companyCode"]) {
    if (patch[key] !== undefined) data[key] = patch[key];
  }
  const row = await getPrisma().org.update({ where: { id: orgId }, data });
  return rowToOrg(row);
}

async function updateOrgStatus(orgId, status) {
  const row = await getPrisma().org.update({ where: { id: orgId }, data: { status } });
  return rowToOrg(row);
}

// Replaces repairAuthStore.js's ensureOrg — guarantees a real Org row exists
// (previously only the flat file's data.orgs got this synthetic default).
async function ensureDefaultOrg(orgId = "ORG_DEFAULT") {
  const row = await getPrisma().org.upsert({
    where: { id: orgId },
    update: {},
    create: { id: orgId, name: "Default Org", status: "active" }
  });
  return rowToOrg(row);
}

// ─── Pairings ─────────────────────────────────────────────────────────────────
// Thin persistence layer only — the business logic (code-collision retry loop,
// claim validation chain, response shaping) stays in legacyPairing.js exactly
// as it was, just re-pointed at these Prisma calls instead of the flat file.
// The flat-file "driverPinExpiresAt" field was always set identically to
// "expiresAt" in every code path (never independently) — both map to the single
// Prisma Pairing.expiresAt column.

function rowToPairing(row) {
  const expiresAtIso = row.expiresAt instanceof Date ? row.expiresAt.toISOString() : row.expiresAt;
  return {
    id: row.id,
    pairingCode: row.pairCode,
    pairCode: row.pairCode,
    vehicleId: row.vehicleId,
    driverId: row.driverId,
    deviceId: row.deviceId,
    deviceLabel: row.deviceLabel,
    driverPin: row.driverPin,
    orgId: row.orgId,
    status: row.status,
    expiresAt: expiresAtIso,
    // Deliberately the same instant as expiresAt — the PIN has no independent
    // lifetime. The separate field name is kept because the Android app and
    // tablet both read it, but callers must not infer that the PIN outlives, or
    // expires before, the pairing itself. In practice the PIN stops mattering
    // earlier than either for a different tablet: once claimed, status and
    // deviceId prevent another device from taking over the assignment.
    driverPinExpiresAt: expiresAtIso,
    claimedAt: row.claimedAt instanceof Date ? row.claimedAt.toISOString() : row.claimedAt,
    revokedAt: row.revokedAt instanceof Date ? row.revokedAt.toISOString() : row.revokedAt,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt
  };
}

async function createPairing(pairing) {
  const row = await getPrisma().pairing.create({
    data: {
      id: pairing.id || makeId("PAIR"),
      pairCode: pairing.pairingCode || pairing.pairCode || null,
      vehicleId: pairing.vehicleId || null,
      driverId: pairing.driverId || null,
      orgId: pairing.orgId || null,
      driverPin: pairing.driverPin || null,
      status: pairing.status || "pending",
      expiresAt: pairing.expiresAt ? new Date(pairing.expiresAt) : null
    }
  });
  return rowToPairing(row);
}

async function findPairingById(id) {
  if (!id) return null;
  const row = await getPrisma().pairing.findUnique({ where: { id } });
  return row ? rowToPairing(row) : null;
}

// pairCode isn't unique in the schema (a code can be reused once expired), so
// this returns the most recent match — mirrors the flat-file .find() which
// returned the first match in insertion order; matching latest is the more
// correct choice since codes are only reused after expiry/replacement.
async function findPairingByCode(code) {
  if (!code) return null;
  const row = await getPrisma().pairing.findFirst({
    where: { pairCode: code },
    orderBy: { createdAt: "desc" }
  });
  return row ? rowToPairing(row) : null;
}

async function updatePairing(id, patch = {}) {
  const data = {};
  if (patch.status !== undefined) data.status = patch.status;
  if (patch.deviceId !== undefined) data.deviceId = patch.deviceId;
  if (patch.deviceLabel !== undefined) data.deviceLabel = patch.deviceLabel;
  if (patch.expiresAt !== undefined) data.expiresAt = patch.expiresAt ? new Date(patch.expiresAt) : null;
  if (patch.claimedAt !== undefined) data.claimedAt = patch.claimedAt ? new Date(patch.claimedAt) : null;
  if (patch.deviceTokenHash !== undefined) data.deviceTokenHash = patch.deviceTokenHash;
  if (patch.deviceTokenIssuedAt !== undefined) {
    data.deviceTokenIssuedAt = patch.deviceTokenIssuedAt ? new Date(patch.deviceTokenIssuedAt) : null;
  }
  const row = await getPrisma().pairing.update({ where: { id }, data });
  return rowToPairing(row);
}

// ── Device sessions ───────────────────────────────────────────────────────────
// A paired tablet/app proves identity with a bearer token issued at claim time.
// Only the hash is persisted; the raw token is shown to the device exactly once.

function hashDeviceToken(rawToken) {
  return crypto.createHash("sha256").update(String(rawToken || ""), "utf8").digest("hex");
}

// Issues a fresh token, invalidating any previous one for this pairing
// (re-pairing a device revokes the old device's access).
async function issueDeviceToken(pairingId) {
  const raw = `dev_${crypto.randomBytes(32).toString("hex")}`;
  await getPrisma().pairing.update({
    where: { id: pairingId },
    data: { deviceTokenHash: hashDeviceToken(raw), deviceTokenIssuedAt: new Date() }
  });
  return raw;
}

// Atomically claims a pending pairing and issues its first device token. The
// status predicate is the compare-and-set guard: if another tablet won the
// claim, updateMany returns zero and no second token is minted.
async function claimPendingPairingAndIssueToken(pairingId, { deviceId, deviceLabel, claimedAt } = {}) {
  if (!pairingId || !deviceId) return null;
  const prisma = getPrisma();
  const raw = `dev_${crypto.randomBytes(32).toString("hex")}`;
  const now = new Date();
  const result = await prisma.pairing.updateMany({
    where: {
      id: pairingId,
      status: "pending",
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }]
    },
    data: {
      status: "active",
      deviceId,
      deviceLabel: deviceLabel || null,
      claimedAt: claimedAt ? new Date(claimedAt) : now,
      deviceTokenHash: hashDeviceToken(raw),
      deviceTokenIssuedAt: now
    }
  });
  if (result.count !== 1) return null;
  const row = await prisma.pairing.findUnique({ where: { id: pairingId } });
  return row ? { pairing: rowToPairing(row), deviceToken: raw } : null;
}

// Resolves a bearer token to its pairing. Returns null unless the assignment
// is still active, so revoking/replacing it immediately kills device access
// without a separate session store. The pending claim-code expiry does not
// terminate an already active tablet session.
async function findPairingByDeviceToken(rawToken) {
  const token = String(rawToken || "");
  if (!token.startsWith("dev_")) return null;
  // findFirst, not findUnique: deviceTokenHash is indexed but not declared
  // unique (see prisma/schema.prisma for why). Functionally identical here —
  // the hash of 32 random bytes identifies exactly one row.
  const row = await getPrisma().pairing.findFirst({
    where: { deviceTokenHash: hashDeviceToken(token) },
    include: {
      vehicle: { select: { orgId: true } },
      driver: { select: { orgId: true } }
    }
  });
  if (!row) return null;
  if (row.status !== "active") return null;
  if (row.revokedAt) return null;
  // expiresAt is the one-time claim-code window. Once status is active, token
  // lifetime is controlled by explicit revoke/replace/tenant-transfer state.
  if (!row.orgId || row.vehicle?.orgId !== row.orgId || row.driver?.orgId !== row.orgId) return null;
  return rowToPairing(row);
}

async function revokeDeviceToken(pairingId) {
  await getPrisma().pairing.update({
    where: { id: pairingId },
    data: { deviceTokenHash: null, deviceTokenIssuedAt: null }
  });
}

// Pending/active pairings for the SAME vehicle+driver pair — used by
// handlePairCodeGenerate to expire a prior assignment before issuing a new code.
async function findActivePairingsForPair(vehicleId, driverId) {
  const rows = await getPrisma().pairing.findMany({
    where: { vehicleId, driverId, status: { in: ["pending", "active"] } }
  });
  return rows.map(rowToPairing);
}

// Any non-expired pairing touching EITHER the vehicle OR the driver — used by
// handlePairCodeReplace, which bumps status to "replaced" rather than "expired".
async function findNonExpiredPairingsForVehicleOrDriver(vehicleId, driverId) {
  const rows = await getPrisma().pairing.findMany({
    where: {
      status: { in: ["pending", "active"] },
      OR: [{ vehicleId }, { driverId }]
    }
  });
  return rows.map(rowToPairing);
}

async function isPairingCodeInUse(code) {
  return Boolean(await getPrisma().pairing.findFirst({
    where: { pairCode: code },
    select: { id: true }
  }));
}

async function getActivePairingForVehicle(vehicleId) {
  if (!vehicleId) return null;
  const row = await getPrisma().pairing.findFirst({
    where: { vehicleId, status: "active" },
    orderBy: { createdAt: "desc" }
  });
  return row ? rowToPairing(row) : null;
}

// Mirrors handlePairingsActive exactly: auto-expires stale pending rows first
// (a real side effect on read, same as the original), then returns pending rows
// that have a code+PIN+org set and aren't expired, newest first. Despite the
// route name ("active"), this has always meant "pending", not "claimed" —
// preserved as-is rather than silently renamed.
async function listPendingUnexpiredPairings() {
  const now = new Date();
  await getPrisma().pairing.updateMany({
    where: { status: "pending", expiresAt: { lte: now } },
    data: { status: "expired" }
  });
  const rows = await getPrisma().pairing.findMany({
    where: {
      status: "pending",
      pairCode: { not: null },
      driverPin: { not: null },
      orgId: { not: null },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }]
    },
    orderBy: { createdAt: "desc" }
  });
  return rows.map(rowToPairing);
}

// Truly claimed pairings (status "active") — distinct from listPendingUnexpiredPairings
// above, which despite its route's name actually lists "pending" pairings. Used by
// the /api/pairings/debug admin view, mirroring the original's separate definition.
async function listClaimedActivePairings() {
  const rows = await getPrisma().pairing.findMany({
    where: { status: "active", revokedAt: null },
    orderBy: { createdAt: "desc" }
  });
  return rows.map(rowToPairing);
}

async function getPairingStatusSummary() {
  const [mostRecent, activeClaimsCount] = await Promise.all([
    getPrisma().pairing.findFirst({ orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
    getPrisma().pairing.count({ where: { status: "active", revokedAt: null } })
  ]);
  return {
    lastPairCodeCreatedAt: mostRecent?.createdAt instanceof Date ? mostRecent.createdAt.toISOString() : null,
    activeClaimsCount
  };
}

async function getPairingHealthCounts() {
  const now = new Date();
  const [active, pending] = await Promise.all([
    getPrisma().pairing.count({ where: { status: "active", revokedAt: null } }),
    getPrisma().pairing.count({ where: { status: "pending", OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] } })
  ]);
  return { active, pending };
}

// Resolves the /auth/driverLogin flow: among ALL non-expired pairings whose
// driverPin matches, find the one whose org (by raw orgId or by companyCode)
// also matches what was typed — mirrors the original's single combined
// find() predicate (pin AND org-code together), not "find by pin then check
// org", since two different orgs could in principle share a driverPin.
async function findDriverLoginPairing({ companyCode, driverPin, normalizeCode }) {
  const norm = normalizeCode;
  const typedCode = norm(companyCode);
  const rows = await getPrisma().pairing.findMany({
    where: { driverPin, status: { not: "expired" } },
    orderBy: { createdAt: "desc" }
  });
  for (const row of rows) {
    const pairing = rowToPairing(row);
    const orgId = pairing.orgId || "ORG_DEFAULT";
    const pairingOrgCode = norm(orgId);
    const org = await getOrg(orgId);
    const friendlyCode = org?.companyCode ? norm(org.companyCode) : "";
    if (pairingOrgCode === typedCode || friendlyCode === typedCode) {
      return { pairing, org };
    }
  }
  return null;
}

// ─── Sync Artifacts From Disk ─────────────────────────────────────────────────

async function syncMlArtifactsFromDisk(modelDir) {
  const metadataPath = path.join(modelDir, "fleet_ai_model_metadata.json");
  const profilesPath = path.join(modelDir, "fleet_ai_baseline_profiles.json");
  const result = { artifact: false, profiles: 0 };
  if (fs.existsSync(metadataPath)) {
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    await upsertMlModelArtifact(metadata, metadata.model_file || path.join(modelDir, "fleet_ai_model.pkl"));
    result.artifact = true;
  }
  if (fs.existsSync(profilesPath)) {
    const payload = JSON.parse(fs.readFileSync(profilesPath, "utf8"));
    const profiles = payload.profiles || payload || {};
    for (const profile of Object.values(profiles)) {
      if (await upsertMlBaselineProfile(profile)) result.profiles += 1;
    }
  }
  return result;
}


// ─── Diagnostic scans ─────────────────────────────────────────────────────────
// One row per on-board diagnostic run, including clean scans — a scan that
// found nothing is evidence the truck was checked, which matters for a DVIR
// trail. Codes are stored already decoded so a manager reading history is not
// dependent on the catalog still holding an entry that has since been revised.

async function insertDiagnosticScan({ vehicleId, orgId, driverId, deviceId, source, scannedAt, codes, summary } = {}) {
  await ensureVehicleStub(vehicleId);
  const row = await getPrisma().diagnosticScan.create({
    data: {
      orgId: orgId || null,
      vehicleId,
      driverId: driverId || null,
      deviceId: deviceId || null,
      source: source || "device",
      scannedAt: toDate(scannedAt),
      severity: summary?.severity || "info",
      driveability: summary?.driveability || "ok",
      codeCount: Array.isArray(codes) ? codes.length : 0,
      codes: codes || [],
      summary: summary || {}
    },
    select: { id: true }
  });
  return row.id;
}

function rowToDiagnosticScan(row) {
  return {
    id: row.id,
    orgId: row.orgId,
    vehicleId: row.vehicleId,
    driverId: row.driverId,
    deviceId: row.deviceId,
    source: row.source,
    severity: row.severity,
    driveability: row.driveability,
    codeCount: row.codeCount,
    codes: Array.isArray(row.codes) ? row.codes : [],
    summary: row.summary || {},
    scannedAt: row.scannedAt instanceof Date ? row.scannedAt.toISOString() : row.scannedAt,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt
  };
}

async function listDiagnosticScans(vehicleId, { limit = 20 } = {}) {
  const rows = await getPrisma().diagnosticScan.findMany({
    where: { vehicleId },
    orderBy: { scannedAt: "desc" },
    take: limit
  });
  return rows.map(rowToDiagnosticScan);
}

// Fleet-wide view for the manager dashboard: most recent scan per vehicle that
// still needs attention, worst first.
async function listOpenDiagnosticScans(orgId, { limit = 50 } = {}) {
  const rows = await getPrisma().diagnosticScan.findMany({
    where: {
      ...(orgId ? { orgId } : {}),
      severity: { in: ["critical", "warning"] }
    },
    orderBy: [{ severity: "asc" }, { scannedAt: "desc" }],
    take: limit
  });
  return rows.map(rowToDiagnosticScan);
}


// ─── Events (HOS duty status, and other vehicle-scoped occurrences) ──────────
// The Event model stores its body in `metricsSnapshot` and its time in
// `detectedAt`; callers pass a friendlier {payload, createdAt} and the mapping
// happens here so route code is not coupled to those column names.

async function insertEvent({ orgId, vehicleId, type, severity, payload, createdAt, dedupeKey } = {}) {
  await ensureVehicleStub(vehicleId);
  const row = await getPrisma().event.create({
    data: {
      orgId: orgId || null,
      vehicleId,
      type,
      severity: severity || "info",
      dedupeKey: dedupeKey || null,
      detectedAt: toDate(createdAt),
      metricsSnapshot: payload || {}
    },
    select: { id: true }
  });
  return row.id;
}

function rowToEvent(row) {
  return {
    id: row.id,
    orgId: row.orgId,
    vehicleId: row.vehicleId,
    type: row.type,
    severity: row.severity,
    status: row.status,
    payload: row.metricsSnapshot || {},
    createdAt: row.detectedAt instanceof Date ? row.detectedAt.toISOString() : row.detectedAt
  };
}

async function listEventsForVehicle(vehicleId, { type = null, limit = 100 } = {}) {
  const where = { vehicleId };
  if (type) where.type = type;
  const rows = await getPrisma().event.findMany({
    where,
    orderBy: { detectedAt: "desc" },
    take: limit
  });
  return rows.map(rowToEvent);
}

module.exports = {
  getPrisma,
  makeId,
  insertEvent,
  listEventsForVehicle,
  insertDiagnosticScan,
  listDiagnosticScans,
  listOpenDiagnosticScans,
  hashDeviceToken,
  issueDeviceToken,
  claimPendingPairingAndIssueToken,
  findPairingByDeviceToken,
  revokeDeviceToken,
  insertTelemetrySample,
  getSamplesForVehicle,
  getSampleCountForVehicle,
  upsertModelState,
  getModelState,
  getAllModelStates,
  insertAlert,
  buildAlertDedupeKey,
  resolveInactiveMlAlerts,
  getAlertsForVehicle,
  getAlertsForOrg,
  getAlertById,
  ackAlert,
  resolveAlert,
  insertAiReport,
  getLatestAiReport,
  upsertVehicleCapabilities,
  getVehicleCapabilities,
  insertFuelEvent,
  getFuelEventsForVehicle,
  upsertMlModelArtifact,
  upsertMlBaselineProfile,
  getMlBaselineProfile,
  findMlBaselineProfile,
  insertMlPredictionRun,
  insertMlFeatureSnapshot,
  syncMlArtifactsFromDisk,
  // Vehicles
  createVehicle,
  listVehicles,
  getVehicleByVehicleId,
  getVehicleByVin,
  transferVehicleToOrg,
  deleteVehicleByVehicleId,
  findVehicleByMotiveIdOrVin,
  upsertVehicleFromMotive,
  updateVehicleMotiveMetadata,
  getVehicleOrgId,
  // Drivers
  createDriver,
  listDrivers,
  getDriverByDriverId,
  deleteDriverByDriverId,
  findDriverByMotiveUserId,
  upsertDriverFromMotive,
  updateDriverMotiveMetadata,
  getUserById,
  logAudit,
  createNotification,
  // Orgs
  createOrg,
  getOrg,
  listOrgs,
  updateOrg,
  updateOrgStatus,
  ensureDefaultOrg,
  // Pairings
  createPairing,
  findPairingById,
  findPairingByCode,
  updatePairing,
  findActivePairingsForPair,
  findNonExpiredPairingsForVehicleOrDriver,
  isPairingCodeInUse,
  getActivePairingForVehicle,
  listPendingUnexpiredPairings,
  listClaimedActivePairings,
  getPairingHealthCounts,
  getPairingStatusSummary,
  findDriverLoginPairing
};
