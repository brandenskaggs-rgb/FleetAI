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
    orderBy: { ts: "asc" },
    take: limit
  });
  return rows.map(rowToSample);
}

async function getSampleCountForVehicle(vehicleId) {
  return getPrisma().telemetrySample.count({ where: { vehicleId } });
}

// ─── Model States ─────────────────────────────────────────────────────────────

async function upsertModelState(state) {
  await ensureVehicleStub(state.vehicleId);
  await getPrisma().modelState.upsert({
    where: { vehicleId: state.vehicleId },
    update: { orgId: state.orgId || null, state },
    create: { vehicleId: state.vehicleId, orgId: state.orgId || null, state }
  });
}

async function getModelState(vehicleId) {
  const row = await getPrisma().modelState.findUnique({ where: { vehicleId } });
  return row ? row.state : null;
}

async function getAllModelStates() {
  const rows = await getPrisma().modelState.findMany({ orderBy: { updatedAt: "desc" } });
  return rows.map((r) => r.state);
}

// ─── Alerts ───────────────────────────────────────────────────────────────────

async function insertAlert(alert) {
  await ensureVehicleStub(alert.vehicleId);
  await getPrisma().alert.upsert({
    where: { id: alert.id },
    update: {},
    create: {
      id: alert.id,
      orgId: alert.orgId || null,
      vehicleId: alert.vehicleId,
      type: alert.type,
      severity: alert.severity,
      explanation: alert.explanation || null,
      recommendedChecks: alert.recommendedChecks || [],
      createdAt: toDate(alert.createdAt)
    }
  });
}

function rowToAlert(row) {
  return {
    id: row.id,
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

module.exports = {
  getPrisma,
  makeId,
  insertTelemetrySample,
  getSamplesForVehicle,
  getSampleCountForVehicle,
  upsertModelState,
  getModelState,
  getAllModelStates,
  insertAlert,
  getAlertsForVehicle,
  getAlertsForOrg,
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
  syncMlArtifactsFromDisk
};
