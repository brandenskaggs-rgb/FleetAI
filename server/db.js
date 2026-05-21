const fs = require("fs");
const Database = require("better-sqlite3");
const path = require("path");
const crypto = require("crypto");
const { STATE_DIR } = require("./config/authStorePath");

const DB_PATH = path.resolve(process.env.FLEETAI_DB_PATH || path.join(STATE_DIR, "fleet.db"));

let _db = null;

function ensureDbDir() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}

function applyPragmas(db) {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = FULL");
  db.pragma("temp_store = MEMORY");
  db.pragma("journal_size_limit = 67108864");
  try {
    db.pragma("trusted_schema = OFF");
  } catch (err) {
    // Older SQLite builds may not support this pragma.
  }
}

function getDb() {
  if (_db) return _db;
  ensureDbDir();
  _db = new Database(DB_PATH, { timeout: 5000 });
  applyPragmas(_db);
  initSchema(_db);
  return _db;
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS telemetry_samples (
      id TEXT PRIMARY KEY,
      org_id TEXT,
      vehicle_id TEXT NOT NULL,
      driver_id TEXT,
      ts TEXT NOT NULL,
      odometer REAL,
      engine_hours REAL,
      metrics TEXT NOT NULL,
      raw TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS idx_ts_vehicle_ts ON telemetry_samples(vehicle_id, ts);
    CREATE INDEX IF NOT EXISTS idx_ts_org ON telemetry_samples(org_id);

    CREATE TABLE IF NOT EXISTS model_states (
      vehicle_id TEXT PRIMARY KEY,
      org_id TEXT,
      state TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id TEXT PRIMARY KEY,
      org_id TEXT,
      vehicle_id TEXT NOT NULL,
      type TEXT NOT NULL,
      severity TEXT NOT NULL,
      explanation TEXT,
      recommended_checks TEXT,
      acknowledged INTEGER DEFAULT 0,
      resolved INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      ack_at TEXT,
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_alerts_vehicle ON alerts(vehicle_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_alerts_org ON alerts(org_id, created_at);

    CREATE TABLE IF NOT EXISTS ai_reports (
      id TEXT PRIMARY KEY,
      org_id TEXT,
      vehicle_id TEXT NOT NULL,
      narrative TEXT NOT NULL,
      prediction_snapshot TEXT NOT NULL,
      model_used TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_reports_vehicle ON ai_reports(vehicle_id, created_at);

    CREATE TABLE IF NOT EXISTS vehicle_capabilities (
      vehicle_id TEXT PRIMARY KEY,
      vin TEXT,
      year INTEGER,
      make TEXT,
      model_year_str TEXT,
      supported_sensors TEXT NOT NULL,
      addon_eligible INTEGER DEFAULT 0,
      addon_sensors TEXT,
      detected_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS fuel_events (
      id TEXT PRIMARY KEY,
      org_id TEXT,
      vehicle_id TEXT NOT NULL,
      ts_start TEXT,
      ts_end TEXT,
      fuel_level_before REAL,
      fuel_level_after REAL,
      gallons_estimated REAL,
      detected_by TEXT DEFAULT 'AUTO',
      confidence REAL,
      note TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS idx_fuel_events_vehicle ON fuel_events(vehicle_id);

    CREATE TABLE IF NOT EXISTS ml_model_artifacts (
      id TEXT PRIMARY KEY,
      model_version TEXT NOT NULL,
      training_source TEXT,
      model_name TEXT,
      metadata TEXT NOT NULL,
      artifact_path TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ml_artifacts_version ON ml_model_artifacts(model_version, created_at);

    CREATE TABLE IF NOT EXISTS ml_baseline_profiles (
      profile_key TEXT PRIMARY KEY,
      vehicle_class TEXT,
      make TEXT,
      model TEXT,
      protocol TEXT,
      powertrain TEXT,
      training_source TEXT,
      model_version TEXT,
      profile_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ml_profiles_lookup ON ml_baseline_profiles(make, model, vehicle_class);

    CREATE TABLE IF NOT EXISTS ml_prediction_runs (
      id TEXT PRIMARY KEY,
      org_id TEXT,
      vehicle_id TEXT NOT NULL,
      model_version TEXT,
      source TEXT NOT NULL,
      confidence_stage TEXT,
      confidence REAL,
      risk_probability REAL,
      health_score REAL,
      prediction_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ml_runs_vehicle ON ml_prediction_runs(vehicle_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_ml_runs_org ON ml_prediction_runs(org_id, created_at);

    CREATE TABLE IF NOT EXISTS ml_feature_snapshots (
      id TEXT PRIMARY KEY,
      org_id TEXT,
      vehicle_id TEXT NOT NULL,
      prediction_run_id TEXT,
      feature_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ml_features_vehicle ON ml_feature_snapshots(vehicle_id, created_at);
  `);
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

const _insertSample = () => getDb().prepare(`
  INSERT OR REPLACE INTO telemetry_samples
    (id, org_id, vehicle_id, driver_id, ts, odometer, engine_hours, metrics, raw)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

function insertTelemetrySample(sample) {
  _insertSample().run(
    sample.id,
    sample.orgId || null,
    sample.vehicleId,
    sample.driverId || null,
    sample.ts,
    sample.odometer ?? null,
    sample.engineHours ?? null,
    JSON.stringify(sample.metrics || {}),
    JSON.stringify(sample.raw || {})
  );
}

function getSamplesForVehicle(vehicleId, { limit = 5000, since = null } = {}) {
  const db = getDb();
  if (since) {
    return db
      .prepare("SELECT * FROM telemetry_samples WHERE vehicle_id = ? AND ts >= ? ORDER BY ts ASC LIMIT ?")
      .all(vehicleId, since, limit)
      .map(rowToSample);
  }
  return db
    .prepare("SELECT * FROM telemetry_samples WHERE vehicle_id = ? ORDER BY ts ASC LIMIT ?")
    .all(vehicleId, limit)
    .map(rowToSample);
}

function getSampleCountForVehicle(vehicleId) {
  const row = getDb()
    .prepare("SELECT COUNT(*) as cnt FROM telemetry_samples WHERE vehicle_id = ?")
    .get(vehicleId);
  return row ? row.cnt : 0;
}

function rowToSample(row) {
  return {
    id: row.id,
    orgId: row.org_id,
    vehicleId: row.vehicle_id,
    driverId: row.driver_id,
    ts: row.ts,
    odometer: row.odometer,
    engineHours: row.engine_hours,
    metrics: JSON.parse(row.metrics || "{}"),
    raw: JSON.parse(row.raw || "{}")
  };
}

function upsertModelState(state) {
  getDb()
    .prepare(`
      INSERT OR REPLACE INTO model_states (vehicle_id, org_id, state, updated_at)
      VALUES (?, ?, ?, ?)
    `)
    .run(
      state.vehicleId,
      state.orgId || null,
      JSON.stringify(state),
      state.updatedAt || new Date().toISOString()
    );
}

function getModelState(vehicleId) {
  const row = getDb()
    .prepare("SELECT * FROM model_states WHERE vehicle_id = ?")
    .get(vehicleId);
  return row ? JSON.parse(row.state) : null;
}

function getAllModelStates() {
  return getDb()
    .prepare("SELECT * FROM model_states ORDER BY updated_at DESC")
    .all()
    .map((r) => JSON.parse(r.state));
}

function insertAlert(alert) {
  getDb()
    .prepare(`
      INSERT OR IGNORE INTO alerts
        (id, org_id, vehicle_id, type, severity, explanation, recommended_checks, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      alert.id,
      alert.orgId || null,
      alert.vehicleId,
      alert.type,
      alert.severity,
      alert.explanation || null,
      JSON.stringify(alert.recommendedChecks || []),
      alert.createdAt || new Date().toISOString()
    );
}

function getAlertsForVehicle(vehicleId, { limit = 50, unresolvedOnly = false } = {}) {
  const db = getDb();
  const q = unresolvedOnly
    ? "SELECT * FROM alerts WHERE vehicle_id = ? AND resolved = 0 ORDER BY created_at DESC LIMIT ?"
    : "SELECT * FROM alerts WHERE vehicle_id = ? ORDER BY created_at DESC LIMIT ?";
  return db.prepare(q).all(vehicleId, limit).map(rowToAlert);
}

function getAlertsForOrg(orgId, { limit = 100, unresolvedOnly = false } = {}) {
  const db = getDb();
  const q = unresolvedOnly
    ? "SELECT * FROM alerts WHERE org_id = ? AND resolved = 0 ORDER BY created_at DESC LIMIT ?"
    : "SELECT * FROM alerts WHERE org_id = ? ORDER BY created_at DESC LIMIT ?";
  return db.prepare(q).all(orgId, limit).map(rowToAlert);
}

function ackAlert(id) {
  getDb()
    .prepare("UPDATE alerts SET acknowledged = 1, ack_at = ? WHERE id = ?")
    .run(new Date().toISOString(), id);
}

function resolveAlert(id) {
  getDb()
    .prepare("UPDATE alerts SET resolved = 1, resolved_at = ? WHERE id = ?")
    .run(new Date().toISOString(), id);
}

function rowToAlert(row) {
  return {
    id: row.id,
    orgId: row.org_id,
    vehicleId: row.vehicle_id,
    type: row.type,
    severity: row.severity,
    explanation: row.explanation,
    recommendedChecks: JSON.parse(row.recommended_checks || "[]"),
    acknowledged: Boolean(row.acknowledged),
    resolved: Boolean(row.resolved),
    createdAt: row.created_at,
    ackAt: row.ack_at,
    resolvedAt: row.resolved_at
  };
}

function insertAiReport(report) {
  const id = report.id || makeId("RPT");
  getDb()
    .prepare(`
      INSERT INTO ai_reports
        (id, org_id, vehicle_id, narrative, prediction_snapshot, model_used, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      id,
      report.orgId || null,
      report.vehicleId,
      report.narrative,
      JSON.stringify(report.predictionSnapshot || {}),
      report.modelUsed || null,
      report.createdAt || new Date().toISOString()
    );
  return id;
}

function getLatestAiReport(vehicleId) {
  const row = getDb()
    .prepare("SELECT * FROM ai_reports WHERE vehicle_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(vehicleId);
  if (!row) return null;
  return {
    id: row.id,
    orgId: row.org_id,
    vehicleId: row.vehicle_id,
    narrative: row.narrative,
    predictionSnapshot: JSON.parse(row.prediction_snapshot || "{}"),
    modelUsed: row.model_used,
    createdAt: row.created_at
  };
}

function upsertVehicleCapabilities(cap) {
  const now = new Date().toISOString();
  getDb()
    .prepare(`
      INSERT OR REPLACE INTO vehicle_capabilities
        (vehicle_id, vin, year, make, model_year_str, supported_sensors, addon_eligible, addon_sensors, detected_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      cap.vehicleId,
      cap.vin || null,
      cap.year || null,
      cap.make || null,
      cap.modelYearStr || null,
      JSON.stringify(cap.supportedSensors || []),
      cap.addonEligible ? 1 : 0,
      JSON.stringify(cap.addonSensors || []),
      cap.detectedAt || now,
      now
    );
}

function getVehicleCapabilities(vehicleId) {
  const row = getDb()
    .prepare("SELECT * FROM vehicle_capabilities WHERE vehicle_id = ?")
    .get(vehicleId);
  if (!row) return null;
  return {
    vehicleId: row.vehicle_id,
    vin: row.vin,
    year: row.year,
    make: row.make,
    modelYearStr: row.model_year_str,
    supportedSensors: JSON.parse(row.supported_sensors || "[]"),
    addonEligible: Boolean(row.addon_eligible),
    addonSensors: JSON.parse(row.addon_sensors || "[]"),
    detectedAt: row.detected_at,
    updatedAt: row.updated_at
  };
}

function insertFuelEvent(evt) {
  getDb()
    .prepare(`
      INSERT OR IGNORE INTO fuel_events
        (id, org_id, vehicle_id, ts_start, ts_end, fuel_level_before, fuel_level_after,
         gallons_estimated, detected_by, confidence, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      evt.id,
      evt.orgId || null,
      evt.vehicleId,
      evt.tsStart || evt.startTs || null,
      evt.tsEnd || evt.endTs || null,
      evt.fuelLevelBefore ?? null,
      evt.fuelLevelAfter ?? null,
      evt.gallonsEstimated ?? null,
      evt.detectedBy || "AUTO",
      evt.confidence ?? null,
      evt.note || null
    );
}

function getFuelEventsForVehicle(vehicleId, limit = 20) {
  return getDb()
    .prepare("SELECT * FROM fuel_events WHERE vehicle_id = ? ORDER BY ts_end DESC LIMIT ?")
    .all(vehicleId, limit)
    .map((r) => ({
      id: r.id,
      orgId: r.org_id,
      vehicleId: r.vehicle_id,
      tsStart: r.ts_start,
      tsEnd: r.ts_end,
      fuelLevelBefore: r.fuel_level_before,
      fuelLevelAfter: r.fuel_level_after,
      gallonsEstimated: r.gallons_estimated,
      detectedBy: r.detected_by,
      confidence: r.confidence,
      note: r.note
    }));
}

function upsertMlModelArtifact(metadata = {}, artifactPath = null) {
  const modelVersion = metadata.modelVersion || metadata.model_version || "unknown";
  const id = `MLART_${modelVersion}`;
  getDb()
    .prepare(`
      INSERT OR REPLACE INTO ml_model_artifacts
        (id, model_version, training_source, model_name, metadata, artifact_path, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      id,
      modelVersion,
      metadata.trainingSource || metadata.training_source || null,
      metadata.model_name || metadata.modelName || null,
      JSON.stringify(metadata || {}),
      artifactPath || metadata.model_file || null,
      new Date().toISOString()
    );
  return id;
}

function upsertMlBaselineProfile(profile = {}) {
  const key = profile.profileKey || profile.profile_key;
  if (!key) return null;
  getDb()
    .prepare(`
      INSERT OR REPLACE INTO ml_baseline_profiles
        (profile_key, vehicle_class, make, model, protocol, powertrain,
         training_source, model_version, profile_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      key,
      profile.vehicleClass || profile.vehicle_class || null,
      profile.make || null,
      profile.model || null,
      profile.protocol || null,
      profile.powertrain || null,
      profile.trainingSource || profile.training_source || null,
      profile.modelVersion || profile.model_version || null,
      JSON.stringify(profile || {}),
      new Date().toISOString()
    );
  return key;
}

function getMlBaselineProfile(profileKey) {
  const row = getDb()
    .prepare("SELECT * FROM ml_baseline_profiles WHERE profile_key = ?")
    .get(profileKey);
  return row ? JSON.parse(row.profile_json || "{}") : null;
}

function findMlBaselineProfile({ make, model, vehicleClass } = {}) {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM ml_baseline_profiles").all();
  const norm = (v) => String(v || "").trim().toLowerCase();
  const exact = rows.find((row) =>
    norm(row.make) === norm(make) && norm(row.model) === norm(model) && (!vehicleClass || norm(row.vehicle_class) === norm(vehicleClass))
  );
  const byMake = rows.find((row) => norm(row.make) === norm(make) && (!vehicleClass || norm(row.vehicle_class) === norm(vehicleClass)));
  const byClass = rows.find((row) => vehicleClass && norm(row.vehicle_class) === norm(vehicleClass));
  const row = exact || byMake || byClass || rows[0];
  return row ? JSON.parse(row.profile_json || "{}") : null;
}

function insertMlPredictionRun(run = {}) {
  const id = run.id || makeId("MLRUN");
  getDb()
    .prepare(`
      INSERT INTO ml_prediction_runs
        (id, org_id, vehicle_id, model_version, source, confidence_stage,
         confidence, risk_probability, health_score, prediction_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      id,
      run.orgId || null,
      run.vehicleId,
      run.modelVersion || null,
      run.source || "unknown",
      run.confidenceStage || null,
      run.confidence ?? null,
      run.riskProbability ?? null,
      run.healthScore ?? null,
      JSON.stringify(run.prediction || {}),
      run.createdAt || new Date().toISOString()
    );
  return id;
}

function insertMlFeatureSnapshot(snapshot = {}) {
  const id = snapshot.id || makeId("MLFEAT");
  getDb()
    .prepare(`
      INSERT INTO ml_feature_snapshots
        (id, org_id, vehicle_id, prediction_run_id, feature_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    .run(
      id,
      snapshot.orgId || null,
      snapshot.vehicleId,
      snapshot.predictionRunId || null,
      JSON.stringify(snapshot.features || {}),
      snapshot.createdAt || new Date().toISOString()
    );
  return id;
}

function syncMlArtifactsFromDisk(modelDir) {
  const metadataPath = path.join(modelDir, "fleet_ai_model_metadata.json");
  const profilesPath = path.join(modelDir, "fleet_ai_baseline_profiles.json");
  const result = { artifact: false, profiles: 0 };
  if (fs.existsSync(metadataPath)) {
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    upsertMlModelArtifact(metadata, metadata.model_file || path.join(modelDir, "fleet_ai_model.pkl"));
    result.artifact = true;
  }
  if (fs.existsSync(profilesPath)) {
    const payload = JSON.parse(fs.readFileSync(profilesPath, "utf8"));
    const profiles = payload.profiles || payload || {};
    Object.values(profiles).forEach((profile) => {
      if (upsertMlBaselineProfile(profile)) result.profiles += 1;
    });
  }
  return result;
}

module.exports = {
  DB_PATH,
  getDb,
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
