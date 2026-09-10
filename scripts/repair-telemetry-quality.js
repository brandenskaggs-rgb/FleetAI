"use strict";

// Dry-run by default. Originals stay in a database-local recovery ledger.
const crypto = require("node:crypto");
const { parseArgs } = require("node:util");

function repairMetrics(metrics, raw) {
  const next = { ...metrics };
  const reasons = [];
  if (typeof metrics.fuelPressure === "number" && Number.isFinite(metrics.fuelPressure)
      && typeof raw.fuelPressureKpa === "number"
      && metrics.fuelPressure === raw.fuelPressureKpa
      && !Object.hasOwn(metrics, "fuelPressureKpa")) {
    next.fuelPressureKpa = raw.fuelPressureKpa;
    reasons.push("explicit_fuel_pressure_kpa");
  }
  if (metrics.batteryVoltage === 0) {
    next.batteryVoltage = null;
    reasons.push("invalid_zero_voltage_to_missing");
  }
  return { metrics: next, reasons };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

function planRepair(records) {
  const seen = new Set();
  const actions = [];
  const summary = { scanned: records.length, duplicateRows: 0, pressureAliases: 0, invalidVoltageRows: 0 };
  for (const before of records) {
    // Do not collapse different drivers, counters, raw evidence, or readings.
    const identity = JSON.stringify(canonical({ org: before.orgId, vehicle: before.vehicleId,
      ts: before.ts, driver: before.driverId, odometer: before.odometer,
      engineHours: before.engineHours, metrics: before.metrics, raw: before.raw }));
    if (seen.has(identity)) {
      actions.push({ before, action: "archive_duplicate", after: null });
      summary.duplicateRows++;
      continue;
    }
    seen.add(identity);
    const repair = repairMetrics(before.metrics || {}, before.raw || {});
    if (!repair.reasons.length) continue;
    summary.pressureAliases += Number(repair.reasons.includes("explicit_fuel_pressure_kpa"));
    summary.invalidVoltageRows += Number(repair.reasons.includes("invalid_zero_voltage_to_missing"));
    actions.push({ before, action: "repair_metrics", after: repair.metrics });
  }
  return { actions, summary };
}

async function createLedger(client) {
  await client.query(`CREATE TABLE IF NOT EXISTS "_FleetTelemetryRepairBatch" (
    id text PRIMARY KEY, "orgId" text NOT NULL, "vehicleId" text NOT NULL,
    "createdAt" timestamptz NOT NULL DEFAULT now(), status text NOT NULL,
    summary jsonb NOT NULL, "rolledBackAt" timestamptz)`);
  await client.query(`CREATE TABLE IF NOT EXISTS "_FleetTelemetryRepairRow" (
    "batchId" text NOT NULL REFERENCES "_FleetTelemetryRepairBatch"(id),
    "sampleId" text NOT NULL, action text NOT NULL, "beforeRow" jsonb NOT NULL,
    "afterMetrics" jsonb, PRIMARY KEY("batchId","sampleId"))`);
}

async function rollbackBatch(client, batchId) {
  const batch = (await client.query('SELECT * FROM "_FleetTelemetryRepairBatch" WHERE id=$1 FOR UPDATE', [batchId])).rows[0];
  if (!batch || batch.status !== "applied") throw new Error("Batch is not eligible for rollback");
  const rows = (await client.query('SELECT * FROM "_FleetTelemetryRepairRow" WHERE "batchId"=$1 ORDER BY "sampleId"', [batchId])).rows;
  for (const row of rows) {
    const before = row.beforeRow;
    if (before.orgId !== batch.orgId || before.vehicleId !== batch.vehicleId) {
      throw new Error("Recovery ledger ownership mismatch");
    }
    const current = (await client.query('SELECT to_jsonb(t) AS original FROM "TelemetrySample" t WHERE id=$1 FOR UPDATE', [row.sampleId])).rows[0]?.original;
    if (row.action === "archive_duplicate") {
      if (current) throw new Error("A removed sample was recreated; rollback needs operator review");
      await client.query('INSERT INTO "TelemetrySample" SELECT * FROM jsonb_populate_record(NULL::"TelemetrySample",$1::jsonb)', [JSON.stringify(before)]);
    } else {
      const expected = { ...before, metrics: row.afterMetrics };
      if (JSON.stringify(canonical(current)) !== JSON.stringify(canonical(expected))) {
        throw new Error("A repaired sample changed after repair; rollback needs operator review");
      }
      await client.query('UPDATE "TelemetrySample" SET metrics=$1::jsonb WHERE id=$2 AND "orgId"=$3 AND "vehicleId"=$4',
        [JSON.stringify(before.metrics), before.id, batch.orgId, batch.vehicleId]);
    }
  }
  await client.query('UPDATE "_FleetTelemetryRepairBatch" SET status=$2,"rolledBackAt"=now() WHERE id=$1', [batchId, "rolled_back"]);
  return { batchId, restoredRows: rows.length, status: "rolled_back" };
}

async function run(client, { unit, apply = false, rollback = null }) {
  await client.query(apply ? "BEGIN ISOLATION LEVEL SERIALIZABLE" : "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    await client.query("SET LOCAL statement_timeout='20000'");
    await client.query("SET LOCAL lock_timeout='3000'");
    if (rollback) {
      if (!apply) throw new Error("Rollback requires --apply");
      const result = await rollbackBatch(client, rollback);
      await client.query("COMMIT");
      return result;
    }
    if (!unit) throw new Error("Specify the exact --unit to repair");
    const vehicles = (await client.query('SELECT "vehicleId","orgId" FROM "Vehicle" WHERE "unitName"=$1', [unit])).rows;
    if (vehicles.length !== 1 || !vehicles[0].orgId) throw new Error("Unit must identify exactly one tenant-owned vehicle");
    const vehicle = vehicles[0];
    const params = [vehicle.vehicleId, vehicle.orgId];
    const count = Number((await client.query('SELECT count(*) AS n FROM "TelemetrySample" WHERE "vehicleId"=$1 AND "orgId"=$2', params)).rows[0].n);
    if (count > 50000) throw new Error("Use a reviewed batch migration for histories above 50000 rows");
    if (apply) await client.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))', [vehicle.orgId, vehicle.vehicleId]);
    const records = (await client.query(`SELECT to_jsonb(t) AS original FROM "TelemetrySample" t
      WHERE "vehicleId"=$1 AND "orgId"=$2 AND ts < (now() AT TIME ZONE 'UTC')-interval '5 minutes'
      ORDER BY "createdAt",id ${apply ? "FOR UPDATE" : ""}`, params)).rows.map(row => row.original);
    const { actions, summary } = planRepair(records);
    if (!apply || !actions.length) {
      await client.query("ROLLBACK");
      return { mode: apply ? "no_changes_needed" : "dry_run", ...summary, affectedRows: actions.length };
    }
    await createLedger(client);
    const batchId = crypto.randomUUID();
    await client.query('INSERT INTO "_FleetTelemetryRepairBatch"(id,"orgId","vehicleId",status,summary) VALUES($1,$2,$3,$4,$5::jsonb)',
      [batchId, vehicle.orgId, vehicle.vehicleId, "applied", JSON.stringify(summary)]);
    // One bounded parameterized batch: recovery copies and edits commit together.
    const payload = actions.map(a => ({ sample_id: a.before.id, action: a.action, before_row: a.before, after_metrics: a.after }));
    await client.query(`INSERT INTO "_FleetTelemetryRepairRow"("batchId","sampleId",action,"beforeRow","afterMetrics")
      SELECT $1,p.sample_id,p.action,p.before_row,p.after_metrics FROM jsonb_to_recordset($2::jsonb)
      AS p(sample_id text, action text, before_row jsonb, after_metrics jsonb)`, [batchId, JSON.stringify(payload)]);
    const updated = await client.query(`UPDATE "TelemetrySample" t SET metrics=r."afterMetrics"
      FROM "_FleetTelemetryRepairRow" r WHERE r."batchId"=$1 AND r.action='repair_metrics'
      AND t.id=r."sampleId" AND t."orgId"=$2 AND t."vehicleId"=$3`, [batchId, vehicle.orgId, vehicle.vehicleId]);
    const removed = await client.query(`DELETE FROM "TelemetrySample" t USING "_FleetTelemetryRepairRow" r
      WHERE r."batchId"=$1 AND r.action='archive_duplicate' AND t.id=r."sampleId"
      AND t."orgId"=$2 AND t."vehicleId"=$3`, [batchId, vehicle.orgId, vehicle.vehicleId]);
    if (updated.rowCount + removed.rowCount !== actions.length) throw new Error("Repair row-count mismatch");
    const check = Number((await client.query('SELECT count(*) AS n FROM "TelemetrySample" WHERE "vehicleId"=$1 AND "orgId"=$2', params)).rows[0].n);
    if (check !== count - removed.rowCount) throw new Error("Post-repair count mismatch");
    await client.query("COMMIT");
    return { mode: "applied", batchId, ...summary, updatedRows: updated.rowCount, remainingRows: check,
      recovery: "Original rows retained in _FleetTelemetryRepairRow; raw evidence unchanged" };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

async function main() {
  const { values } = parseArgs({ options: {
    unit: { type: "string" }, apply: { type: "boolean", default: false },
    railway: { type: "boolean", default: false }, rollback: { type: "string" }
  }});
  let url = process.env.DATABASE_URL;
  if (values.railway) {
    const { spawnSync } = require("node:child_process");
    const command = "railway variable list --service Postgres --environment production --json";
    const result = process.platform === "win32"
      ? spawnSync("cmd.exe", ["/d", "/s", "/c", command], { encoding: "utf8", stdio: "pipe", timeout: 30000 })
      : spawnSync("railway", ["variable", "list", "--service", "Postgres", "--environment", "production", "--json"], { encoding: "utf8", stdio: "pipe", timeout: 30000 });
    if (result.status !== 0) throw new Error("Railway credential lookup failed");
    url = JSON.parse(result.stdout).DATABASE_PUBLIC_URL;
  }
  if (!url) throw new Error("A database connection is required");
  const { Client } = require("pg");
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 10000,
    application_name: "fleetai_scoped_quality_repair" });
  try {
    await client.connect();
    console.log(JSON.stringify(await run(client, values), null, 2));
  } finally { await client.end(); }
}

module.exports = { repairMetrics, planRepair, canonical, run };
if (require.main === module) main().catch(error => {
  // Database errors can contain connection details or telemetry; emit codes only.
  const code = /^[A-Z0-9_]{1,32}$/.test(error.code || "") ? error.code : "CHECK_FAILED";
  console.error(`Repair aborted (${code}); transaction rolled back or never started. No credentials displayed.`);
  process.exitCode = 1;
});
