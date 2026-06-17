/**
 * Motive API client — authenticated requests to api.gomotive.com
 *
 * Configure via environment:
 *   MOTIVE_ACCESS_TOKEN  — OAuth 2.0 Bearer token (preferred)
 *   MOTIVE_API_KEY       — API key fallback
 */

const https = require("https");

const MOTIVE_HOST = "api.gomotive.com";
const MOTIVE_AGENT = new https.Agent({ keepAlive: true, maxSockets: 5 });

function _authHeader() {
  const bearer = (process.env.MOTIVE_ACCESS_TOKEN || "").trim();
  if (bearer) return { Authorization: `Bearer ${bearer}` };
  const apiKey = (process.env.MOTIVE_API_KEY || "").trim();
  if (apiKey) return { "x-api-key": apiKey };
  throw new Error("Motive credentials not configured. Set MOTIVE_ACCESS_TOKEN or MOTIVE_API_KEY.");
}

function motiveRequest(path, { method = "GET", params = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    let auth;
    try { auth = _authHeader(); } catch (err) { return reject(err); }

    const url = new URL(`https://${MOTIVE_HOST}${path}`);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }

    const reqBody = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        hostname: MOTIVE_HOST,
        path: url.pathname + url.search,
        method,
        agent: MOTIVE_AGENT,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          ...(reqBody ? { "Content-Length": Buffer.byteLength(reqBody) } : {}),
          ...auth
        }
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => { raw += chunk; });
        res.on("end", () => {
          try {
            const parsed = JSON.parse(raw);
            if (res.statusCode >= 400) {
              const msg = parsed?.error_message || parsed?.message || JSON.stringify(parsed);
              return reject(new Error(`Motive ${res.statusCode}: ${msg}`));
            }
            resolve(parsed);
          } catch (err) {
            reject(new Error(`Motive response parse error: ${err.message}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error("Motive API timeout")); });
    if (reqBody) req.write(reqBody);
    req.end();
  });
}

async function _fetchAllPages(path, rootKey, params = {}) {
  const all = [];
  let page = 1;
  const perPage = 100;
  while (true) {
    const data = await motiveRequest(path, { params: { ...params, per_page: perPage, page_no: page } });
    const items = Array.isArray(data[rootKey]) ? data[rootKey] : [];
    all.push(...items);
    const total = data.pagination?.total ?? 0;
    if (all.length >= total || items.length < perPage) break;
    page++;
  }
  return all;
}

// Fetch all ELD devices (vehicle gateways) for the org
async function fetchEldDevices(params = {}) {
  const items = await _fetchAllPages("/v1/eld_devices", "eld_devices", params);
  return items.map((item) => item.eld_device || item);
}

// Fetch fault codes — pass motiveVehicleId to scope to one vehicle, or omit for fleet-wide
async function fetchVehicleFaultCodes(motiveVehicleId, params = {}) {
  const query = motiveVehicleId ? { vehicle_id: motiveVehicleId, ...params } : params;
  const items = await _fetchAllPages("/v1/fault_codes", "fault_codes", query);
  return items.map((item) => item.fault_code || item);
}

async function fetchOpenFaultCodes(params = {}) {
  return fetchVehicleFaultCodes(null, { status: "open", ...params });
}

async function fetchVehicles(params = {}) {
  const items = await _fetchAllPages("/v1/vehicles", "vehicles", params);
  return items.map((item) => item.vehicle || item);
}

function isConfigured() {
  return Boolean(
    (process.env.MOTIVE_ACCESS_TOKEN || "").trim() ||
    (process.env.MOTIVE_API_KEY || "").trim()
  );
}

module.exports = { motiveRequest, fetchEldDevices, fetchVehicleFaultCodes, fetchOpenFaultCodes, fetchVehicles, isConfigured };
