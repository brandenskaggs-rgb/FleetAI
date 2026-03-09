const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");

function safeNow() {
  return new Date().toISOString();
}

function readContract(contractPath) {
  try {
    const raw = fs.readFileSync(contractPath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    return { endpoints: [], intervalMs: 10000, maxTimeoutMs: 2000 };
  }
}

function writeLog(logPath, line) {
  try {
    fs.appendFileSync(logPath, `${line}\n`, "utf8");
  } catch (_) {}
}

function requestJson(url, timeoutMs) {
  return new Promise((resolve) => {
    try {
      const isHttps = url.startsWith("https://");
      const lib = isHttps ? https : http;
      const req = lib.get(url, { timeout: timeoutMs }, (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          let parsed = null;
          try { parsed = data ? JSON.parse(data) : {}; } catch (_) { parsed = null; }
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, statusCode: res.statusCode, data: parsed });
        });
      });
      req.on("timeout", () => {
        req.destroy();
        resolve({ ok: false, statusCode: 0, error: "timeout" });
      });
      req.on("error", (err) => {
        resolve({ ok: false, statusCode: 0, error: err.message || "error" });
      });
    } catch (err) {
      resolve({ ok: false, statusCode: 0, error: err.message || "error" });
    }
  });
}

function startWatchdog(options) {
  const baseUrl = (options.baseUrl || "").replace(/\/$/, "");
  const contractPath = options.contractPath || path.join(process.cwd(), "spec", "config", "watchdog_contract.json");
  const logPath = options.logPath || path.join(process.cwd(), "server", "logs", "watchdog.log");
  const contract = readContract(contractPath);
  const intervalMs = Number(contract.intervalMs || options.intervalMs || 10000);
  const timeoutMs = Number(contract.maxTimeoutMs || options.timeoutMs || 2000);

  const state = {
    lastOkAt: null,
    lastFailAt: null,
    lastError: null,
    checks: {}
  };

  async function runOnce() {
    const endpoints = Array.isArray(contract.endpoints) ? contract.endpoints : [];
    for (const ep of endpoints) {
      const url = `${baseUrl}${ep.path}`;
      const started = Date.now();
      const result = await requestJson(url, Math.min(timeoutMs, ep.timeoutMs || timeoutMs));
      const ms = Date.now() - started;
      const entry = {
        ok: result.ok,
        ms,
        statusCode: result.statusCode || 0,
        error: result.error || "",
        at: safeNow()
      };
      state.checks[ep.name || ep.path] = entry;
      const line = `[WATCHDOG] ${entry.at} ${ep.name || ep.path} ok=${entry.ok} status=${entry.statusCode} ms=${entry.ms} error=${entry.error}`;
      writeLog(logPath, line);
      if (result.ok) {
        state.lastOkAt = entry.at;
      } else {
        state.lastFailAt = entry.at;
        state.lastError = entry.error || `status_${entry.statusCode}`;
      }
    }
  }

  const timer = setInterval(() => {
    runOnce().catch(() => {});
  }, intervalMs);
  timer.unref();
  runOnce().catch(() => {});

  return {
    getState: () => ({ ...state }),
    stop: () => clearInterval(timer)
  };
}

module.exports = { startWatchdog };
