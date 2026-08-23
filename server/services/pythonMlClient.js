const http = require("http");
const https = require("https");

const DEFAULT_URL = "http://127.0.0.1:8010";
const ML_SERVICE_URL = (process.env.FLEETAI_ML_SERVICE_URL || DEFAULT_URL).replace(/\/+$/, "");
const ML_SERVICE_TIMEOUT_MS = Number(process.env.FLEETAI_ML_SERVICE_TIMEOUT_MS || 4000);
const PYTHON_ML_ENABLED = (process.env.FLEETAI_PYTHON_ML_ENABLED || "true").toLowerCase() !== "false";
const ML_INTERNAL_TOKEN = String(process.env.FLEETAI_ML_INTERNAL_TOKEN || "").trim();

// Persistent connection pool — avoids TCP handshake overhead on every prediction
const ML_AGENT       = new http.Agent({ keepAlive: true, maxSockets: 10 });
const ML_AGENT_HTTPS = new https.Agent({ keepAlive: true, maxSockets: 10 });

function postJson(path, payload) {
  if (!PYTHON_ML_ENABLED) {
    return Promise.reject(new Error("Python ML disabled"));
  }
  const target = new URL(`${ML_SERVICE_URL}${path}`);
  const body = JSON.stringify(payload || {});
  const transport = target.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        method: "POST",
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          ...(ML_INTERNAL_TOKEN ? { "X-FleetAI-ML-Token": ML_INTERNAL_TOKEN } : {})
        },
        timeout: ML_SERVICE_TIMEOUT_MS,
        agent: target.protocol === "https:" ? ML_AGENT_HTTPS : ML_AGENT,
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => { raw += chunk; });
        res.on("end", () => {
          let data = null;
          try { data = raw ? JSON.parse(raw) : null; } catch (_) {}
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(data?.detail || data?.error || `ML service HTTP ${res.statusCode}`));
          }
          resolve(data);
        });
      }
    );
    req.on("timeout", () => {
      req.destroy(new Error("ML service timeout"));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function getJson(path) {
  if (!PYTHON_ML_ENABLED) {
    return Promise.reject(new Error("Python ML disabled"));
  }
  const target = new URL(`${ML_SERVICE_URL}${path}`);
  const transport = target.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        method: "GET",
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        timeout: ML_SERVICE_TIMEOUT_MS,
        agent: target.protocol === "https:" ? ML_AGENT_HTTPS : ML_AGENT,
        headers: ML_INTERNAL_TOKEN ? { "X-FleetAI-ML-Token": ML_INTERNAL_TOKEN } : undefined,
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => { raw += chunk; });
        res.on("end", () => {
          let data = null;
          try { data = raw ? JSON.parse(raw) : null; } catch (_) {}
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(data?.detail || data?.error || `ML service HTTP ${res.statusCode}`));
          }
          resolve(data);
        });
      }
    );
    req.on("timeout", () => {
      req.destroy(new Error("ML service timeout"));
    });
    req.on("error", reject);
    req.end();
  });
}

async function predict({ orgId, vehicleId, vehicleMeta, samples, dtcCodes }) {
  return postJson("/predict", {
    orgId: orgId || null,
    vehicleId,
    vehicleMeta: vehicleMeta || {},
    samples: Array.isArray(samples) ? samples : [],
    dtcCodes: Array.isArray(dtcCodes) ? dtcCodes : []
  });
}

async function status(vehicleId, orgId) {
  const query = new URLSearchParams();
  if (vehicleId) query.set("vehicleId", vehicleId);
  if (orgId) query.set("orgId", orgId);
  return getJson(`/model/status${query.size ? `?${query.toString()}` : ""}`);
}

async function baseline(profileKey) {
  return getJson(`/baselines/${encodeURIComponent(profileKey)}`);
}

module.exports = {
  ML_SERVICE_URL,
  PYTHON_ML_ENABLED,
  baseline,
  predict,
  status
};
