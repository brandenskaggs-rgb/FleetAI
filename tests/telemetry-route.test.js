const assert = require("assert");
const fs = require("fs");
const path = require("path");
const db = require("../server/db");
const { registerFleetOpsRoutes } = require("../server/routes/fleetOpsRoutes");

function fakeApp() {
  const routes = new Map();
  const add = (method) => (route, ...handlers) => routes.set(`${method} ${route}`, handlers);
  return { routes, get: add("GET"), post: add("POST"), patch: add("PATCH"), delete: add("DELETE") };
}

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    set() {},
    flushHeaders() {},
    write() {},
    end() {}
  };
}

async function invoke(app, body) {
  const handlers = app.routes.get("POST /api/telemetry/ingest");
  const res = response();
  const req = {
    body,
    query: {},
    params: {},
    path: "/api/telemetry/ingest",
    device: { orgId: "ORG_A", vehicleId: "TRUCK_1", driverId: "DRIVER_1", deviceId: "TABLET_1" }
  };
  await handlers[handlers.length - 1](req, res, (error) => { if (error) throw error; });
  return res;
}

(async () => {
  const app = fakeApp();
  const data = {};
  let writes = 0;
  let stored = null;
  let pipelineRuns = 0;
  let lastActivity = null;
  const telemetryLatest = new Map();
  const telemetryWrites = [];
  const telemetrySubscribers = new Set([{
    __fleetScope: { kind: "operator", orgId: "ORG_A" },
    write: (frame) => telemetryWrites.push(frame)
  }]);
  registerFleetOpsRoutes(app, {
    readData: async () => data,
    writeData: async () => { writes += 1; },
    sanitizeString: (value, max = 500) => String(value || "").trim().slice(0, max),
    parseNumberField: (value, fallback = null) => Number.isFinite(Number(value)) ? Number(value) : fallback,
    nowIso: () => "2026-08-14T12:00:01.000Z",
    generateDigits: () => "123456",
    requireEmployeeOrCustomerApi: (_req, _res, next) => next(),
    telemetryLatest,
    telemetrySubscribers,
    getTelemetryLastSeen: () => null,
    getTelemetryState: () => ({}),
    triggerTelemetryPipeline: () => { pipelineRuns += 1; },
    storeNormalizedSnapshot: (store, normalized, extra) => { stored = { store, normalized, extra }; },
    normalizeMetrics: (value) => value,
    recordTelemetryActivity: (snapshot) => { lastActivity = snapshot; }
  });

  const payload = {
    batchId: "batch-1",
    vehicleId: "TRUCK_1",
    protocol: "J1939",
    adapter: {
      transport: "USB_SLCAN",
      protocol: "J1939",
      manufacturer: "Bench Adapter",
      product: "Isolated CAN",
      listenOnly: true,
      bitrate: 250000,
      connectorProfile: "BLACK_9_PIN"
    },
    timestamp: "2026-08-14T12:00:00.000Z",
    meta: {
      vin: "1FUAAAAAAAAAAAAAA",
      metricAgesMs: { coolantTempC: 750 },
      latitude: 37.7749,
      longitude: -122.4194,
      locationCapturedAt: Date.parse("2026-08-14T11:59:59.000Z"),
      locationAccuracyMeters: 7.5
    },
    frames: [{ id: 0x18feee00, data: [130, 255, 255, 255, 255, 255, 255, 255] }]
  };
  const first = await invoke(app, payload);
  assert.strictEqual(first.statusCode, 200);
  assert.strictEqual(first.body.success, true);
  assert.strictEqual(stored.normalized.engine.coolantTempC, 90);
  assert.strictEqual(stored.normalized.vehicleId, "TRUCK_1");
  assert.strictEqual(stored.extra.vin, "1FUAAAAAAAAAAAAAA");
  assert.strictEqual(stored.extra.meta.metricAgesMs.coolantTempC, 750);
  assert.strictEqual(stored.extra.meta.latitude, 37.7749);
  assert.strictEqual(stored.extra.meta.longitude, -122.4194);
  assert.strictEqual(stored.extra.meta.locationAccuracyMeters, 7.5);
  assert.strictEqual(data.telemetryFrames.length, 1);
  assert.strictEqual(data.telemetryFrames[0].orgId, "ORG_A");
  assert.strictEqual(data.telemetryFrames[0].pgn, 65262);
  assert.strictEqual(data.telemetryFrames[0].sourceAddress, 0);
  assert.strictEqual(data.telemetryFrames[0].capture.bitrate, 250000);
  assert.strictEqual(first.body.snapshot.captureQuality.uniquePgnCount, 1);
  assert.strictEqual(writes, 1);
  assert.strictEqual(pipelineRuns, 1);
  assert.strictEqual(first.body.snapshot.connectionState, "live");
  assert.strictEqual(first.body.snapshot.readingCount > 0, true);
  assert.strictEqual(lastActivity.vehicleId, "TRUCK_1");
  assert.strictEqual(telemetryWrites.length, 1);
  assert.strictEqual(telemetryWrites[0].startsWith("data: "), true);
  assert.strictEqual(telemetryWrites[0].includes("event: link"), false);

  const duplicate = await invoke(app, payload);
  assert.strictEqual(duplicate.body.duplicate, true);
  assert.strictEqual(writes, 1);
  assert.strictEqual(data.telemetryFrames.length, 1);

  const staleHeartbeat = await invoke(app, {
    batchId: "batch-stale-heartbeat",
    vehicleId: "TRUCK_1",
    protocol: "OBD2",
    timestamp: "2026-08-14T11:59:00.000Z",
    metrics: { heartbeatMs: 123455 },
    obdConnected: false
  });
  assert.strictEqual(staleHeartbeat.body.outOfOrder, true);
  assert.strictEqual(staleHeartbeat.body.livePromoted, false);
  assert.strictEqual(telemetryLatest.get("TRUCK_1").connectionState, "live");
  assert.strictEqual(lastActivity.connectionState, "live");

  const repeatedPacket = await invoke(app, Object.assign({}, payload, { batchId: "batch-2" }));
  assert.strictEqual(repeatedPacket.body.duplicateSample, true);
  assert.strictEqual(repeatedPacket.body.stored, false);
  assert.strictEqual(writes, 1);
  assert.strictEqual(pipelineRuns, 1);
  assert.strictEqual(data.telemetryFrames.length, 1);

  const heartbeat = await invoke(app, {
    batchId: "batch-heartbeat",
    vehicleId: "TRUCK_1",
    protocol: "OBD2",
    timestamp: "2026-08-14T12:00:02.000Z",
    metrics: { heartbeatMs: 123456 },
    obdConnected: true,
    meta: {
      appVersion: "1.4",
      adapterResponding: true,
      ecuResponding: false,
      ecuState: "no_ecu_response",
      obdFailureReason: "ECU returned NO DATA"
    }
  });
  assert.strictEqual(heartbeat.statusCode, 200);
  assert.strictEqual(heartbeat.body.stored, false);
  assert.strictEqual(heartbeat.body.linkOnly, true);
  assert.strictEqual(heartbeat.body.snapshot.connectionState, "adapter_only");
  assert.strictEqual(heartbeat.body.snapshot.readingCount, 0);
  assert.strictEqual(heartbeat.body.snapshot.deviceDiagnostics.appVersion, "1.4");
  assert.strictEqual(heartbeat.body.snapshot.deviceDiagnostics.ecuResponding, false);
  assert.strictEqual(heartbeat.body.snapshot.deviceDiagnostics.obdFailureReason, "ECU returned NO DATA");
  assert.strictEqual(writes, 1);
  assert.strictEqual(pipelineRuns, 1);
  assert.strictEqual(telemetryLatest.get("TRUCK_1").connectionState, "adapter_only");
  assert.strictEqual(telemetryLatest.get("TRUCK_1").lastObdPacketAt, "2026-08-14T12:00:00.000Z");
  assert.strictEqual(telemetryLatest.get("TRUCK_1").metrics.engine.coolantTempC, 90);
  assert.strictEqual(telemetryWrites.at(-1).startsWith("event: link\ndata: "), true);

  const transportOnly = await invoke(app, {
    batchId: "batch-transport-only",
    vehicleId: "TRUCK_1",
    protocol: "OBD2",
    timestamp: "2026-08-14T12:00:03.000Z",
    metrics: { heartbeatMs: 123457 },
    obdConnected: true,
    meta: {
      appVersion: "1.4",
      adapterResponding: false,
      ecuResponding: false,
      ecuState: "adapter_unavailable",
      obdFailureReason: "OBD adapter did not answer the reset command"
    }
  });
  assert.strictEqual(transportOnly.body.snapshot.connectionState, "transport_only");
  assert.strictEqual(transportOnly.body.snapshot.deviceDiagnostics.adapterResponding, false);
  assert.strictEqual(transportOnly.body.stored, false);

  const resumedBetweenHeartbeats = await invoke(app, {
    batchId: "batch-resumed-between-heartbeats",
    vehicleId: "TRUCK_1",
    protocol: "OBD2",
    timestamp: "2026-08-14T12:00:02.500Z",
    metrics: { rpm: 900 },
    obdConnected: true,
    meta: { adapterResponding: true, ecuResponding: true }
  });
  assert.strictEqual(resumedBetweenHeartbeats.body.livePromoted, true);
  assert.strictEqual(resumedBetweenHeartbeats.body.snapshot.connectionState, "live");
  assert.strictEqual(telemetryLatest.get("TRUCK_1").lastObdPacketAt, "2026-08-14T12:00:02.500Z");

  const rotatingPidBatch = await invoke(app, {
    batchId: "batch-rotating-pid",
    vehicleId: "TRUCK_1",
    protocol: "OBD2",
    timestamp: "2026-08-14T12:00:04.000Z",
    metrics: { batteryVoltageV: 14.2 },
    obdConnected: true,
    meta: {
      adapterResponding: true,
      ecuResponding: true,
      metricAgesMs: { batteryVoltageV: 120 }
    }
  });
  assert.strictEqual(rotatingPidBatch.body.livePromoted, true);
  assert.strictEqual(rotatingPidBatch.body.snapshot.metrics.electrical.batteryVoltageV, 14.2);
  assert.strictEqual(rotatingPidBatch.body.snapshot.metrics.engine.rpm, 900);
  assert.strictEqual(rotatingPidBatch.body.snapshot.metrics.engine.coolantTempC, 90);
  assert.strictEqual(rotatingPidBatch.body.snapshot.deviceDiagnostics.metricAgesMs.batteryVoltageV, 120);
  assert.strictEqual(rotatingPidBatch.body.snapshot.deviceDiagnostics.metricAgesMs.coolantTempC, 5250);

  const originalGetVehicleOrgId = db.getVehicleOrgId;
  const originalGetSamplesForVehicle = db.getSamplesForVehicle;
  try {
    db.getVehicleOrgId = async () => "ORG_A";
    db.getSamplesForVehicle = async () => [{
      id: "TS_HISTORY",
      ts: "2026-08-14T12:00:05.000Z",
      metrics: {
        vehicleSpeed: 72,
        coolantTemp: 93,
        batteryVoltage: 14.1,
        engineLoad: 41,
        fuelLevel: 68
      },
      raw: { quality: "live" }
    }];
    const historyHandler = app.routes.get("GET /api/telemetry/history").at(-1);
    const expectedHistoryValues = {
      speed: 72,
      coolant_temp: 93,
      battery_voltage: 14.1,
      engine_load: 41,
      fuel_level: 68
    };
    for (const [metric, expected] of Object.entries(expectedHistoryValues)) {
      const res = response();
      const req = {
        query: { vehicleId: "TRUCK_1", metric, range: "24h" },
        params: {},
        customer: { orgId: "ORG_A" }
      };
      await historyHandler(req, res, (error) => { if (error) throw error; });
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.data.length, 1);
      assert.strictEqual(res.body.data[0].value, expected);
    }
  } finally {
    db.getVehicleOrgId = originalGetVehicleOrgId;
    db.getSamplesForVehicle = originalGetSamplesForVehicle;
  }

  const dbSource = fs.readFileSync(path.join(__dirname, "..", "server", "db.js"), "utf8");
  const sampleQuerySource = dbSource.slice(
    dbSource.indexOf("async function getSamplesForVehicle"),
    dbSource.indexOf("async function getSampleCountForVehicle")
  );
  assert.match(sampleQuerySource, /orderBy:\s*\{\s*ts:\s*"desc"\s*\}/);
  assert.match(sampleQuerySource, /rows\.reverse\(\)\.map\(rowToSample\)/);

  console.log("Telemetry route tests passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
