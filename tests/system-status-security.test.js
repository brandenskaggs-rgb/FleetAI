const assert = require("assert");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { registerSystemStatusRoutes } = require("../server/routes/systemStatus");
const { startWatchdog } = require("../tools/watchdog");

function fakeApp() {
  const routes = new Map();
  return {
    routes,
    get(route, ...handlers) { routes.set(`GET ${route}`, handlers); }
  };
}

async function invoke(handlers, req = {}) {
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    set() { return this; }
  };
  let index = -1;
  const dispatch = async (position) => {
    if (position <= index) throw new Error("next called twice");
    index = position;
    const handler = handlers[position];
    if (!handler) return;
    await handler(Object.assign({ headers: {}, ip: "203.0.113.5" }, req), res, (error) => {
      if (error) throw error;
      return dispatch(position + 1);
    });
  };
  await dispatch(0);
  return res;
}

(async () => {
  const app = fakeApp();
  registerSystemStatusRoutes(app, {
    healthPayload: async () => ({ ok: true }),
    readData: async () => ({}),
    DATA_PATH: "hidden",
    requireSuperAdmin: (_req, res) => res.status(401).json({ ok: false }),
    getDataLoadStatus: () => ({ dataLoadStatus: "ok" }),
    getDataLoadError: () => null,
    getDataLoadNote: () => null,
    getLastDataWriteAt: () => null,
    DATA_SCHEMA_VERSION: 2,
    APP_VERSION: "test",
    getWatchdogInstance: () => ({ getState: () => ({ checks: {} }) }),
    getTelemetryLastSeen: () => null,
    getTelemetryState: () => ({}),
    getTelemetryLatestSize: () => 0,
    getTelemetryLatestEntries: () => [],
    nowIso: () => "2026-08-23T00:00:00.000Z",
    watchdogInternalToken: "a".repeat(64)
  });

  const protectedHandlers = app.routes.get("GET /api/system/telemetry/status");
  const publicAttempt = await invoke(protectedHandlers);
  assert.strictEqual(publicAttempt.statusCode, 401);
  const watchdogAttempt = await invoke(protectedHandlers, {
    headers: { "x-fleetai-watchdog-token": "a".repeat(64) }
  });
  assert.strictEqual(watchdogAttempt.statusCode, 200);
  assert.strictEqual(watchdogAttempt.body.connectedDevicesCount, 0);

  const active = await invoke(app.routes.get("GET /api/active"));
  assert.deepStrictEqual(active.body, { ok: true, service: "fleet-ai", status: "reachable" });

  const server = http.createServer((req, res) => {
    assert.strictEqual(req.headers["x-fleetai-watchdog-token"], "watchdog-test");
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleetai-watchdog-"));
  const contractPath = path.join(tempDir, "contract.json");
  fs.writeFileSync(contractPath, JSON.stringify({
    endpoints: [{ name: "missing", path: "/status", requiredFields: ["required"] }],
    intervalMs: 60000,
    maxTimeoutMs: 1000
  }));
  const watchdog = startWatchdog({
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    contractPath,
    logPath: path.join(tempDir, "watchdog.log"),
    headers: { "X-FleetAI-Watchdog-Token": "watchdog-test" }
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.strictEqual(watchdog.getState().checks.missing.ok, false);
  assert.match(watchdog.getState().checks.missing.error, /missing_fields:required/);
  watchdog.stop();
  await new Promise((resolve) => server.close(resolve));

  console.log("System status security tests passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
