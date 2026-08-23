/**
 * OEM API async ingestion worker.
 *
 * OEM telematics APIs (Cummins Connect, Detroit Connect, PACCAR Connect)
 * deliver extended engine data on 15-minute polling intervals. This worker
 * fetches that data and merges it into vehicle feature records alongside
 * real-time J1939 telemetry.
 *
 * Architecture:
 *   - Each registered OEM integration is polled on its configured interval
 *   - Results are normalized to Fleet AI metric keys and stored as telemetry samples
 *   - The ML prediction pipeline picks them up on the next predict() call
 *
 * Supported OEM APIs:
 *   - Cummins Connect REST API  (ISX15, X15 — injector balance, EGR cooler, misfire)
 *   - Detroit Connect REST API  (DD13/15/16 — turbo temp, DPF ash, SCR efficiency)
 *   - PACCAR Connect REST API   (MX-13/11 — oil dilution, coolant pressure decay)
 *
 * Usage:
 *   const oem = require('./oemIngestion');
 *   oem.startPolling(db, telemetryStore);
 *   oem.registerIntegration({ vehicleId, provider, apiKey, endpointUrl, intervalMin });
 */

const https = require("https");
const { validateOutboundHttpsUrl, pinnedLookup } = require("../lib/outboundUrlPolicy");

// In-memory registry of active OEM integrations
// tenantScope:vehicleId -> { provider, apiKey, endpointUrl, intervalMin, lastPolledAt, timerId }
const _registry = new Map();

// Normalize OEM API responses to Fleet AI metric keys
const _FIELD_MAPS = {
  cummins: {
    injectorBalanceRate1:  "injectorBalanceVariance",  // variance computed below
    injectorBalanceRate2:  "__inj2",
    injectorBalanceRate3:  "__inj3",
    injectorBalanceRate4:  "__inj4",
    injectorBalanceRate5:  "__inj5",
    injectorBalanceRate6:  "__inj6",
    cylinderMisfireCount:  "cylinderMisfireCount",
    egrCoolerInletTemp:    "__egrIn",
    egrCoolerOutletTemp:   "__egrOut",
    fuelSystemLeakRate:    "fuelPressureDecayRate",
  },
  detroit: {
    turboBearingTemp:      "turboBearingTemp",
    dpfAshAccumulation:    "dpfAshLoad",
    scrCatalystEfficiency: "scrEfficiency",
    injectorReturnFlow1:   "__injReturn",
  },
  paccar: {
    oilDilutionEstimate:   "oilDilutionPct",
    coolantPressureDecay:  "coolantPressureDecay",
    intakeTempBankA:       "__intakeA",
    intakeTempBankB:       "__intakeB",
    engineBrakeFreq:       "engineBrakeActivationFreq",
  },
};

/**
 * Normalize a raw OEM API payload to Fleet AI metric keys.
 * Handles derived fields (EGR cooler delta, injector balance variance).
 */
function normalizeOemPayload(provider, raw) {
  const fieldMap = _FIELD_MAPS[provider] || {};
  const metrics = {};
  const staging = {};  // temporary fields for derived computation

  for (const [oem_key, fleet_key] of Object.entries(fieldMap)) {
    const val = raw[oem_key];
    if (val == null) continue;
    const n = parseFloat(val);
    if (!isFinite(n)) continue;
    if (fleet_key.startsWith("__")) {
      staging[fleet_key] = n;
    } else {
      metrics[fleet_key] = n;
    }
  }

  // Derived: EGR cooler delta temperature (Cummins)
  if (staging["__egrIn"] != null && staging["__egrOut"] != null) {
    metrics["egrCoolerDelta"] = Math.abs(staging["__egrIn"] - staging["__egrOut"]);
  }

  // Derived: injector balance variance across cylinders (Cummins)
  const injRates = [staging["__inj2"], staging["__inj3"], staging["__inj4"],
                    staging["__inj5"], staging["__inj6"]]
    .filter((v) => v != null);
  if (injRates.length >= 2) {
    const mean = injRates.reduce((s, v) => s + v, 0) / injRates.length;
    const variance = injRates.reduce((s, v) => s + (v - mean) ** 2, 0) / injRates.length;
    metrics["injectorBalanceVariance"] = Math.sqrt(variance);
  }

  // Derived: PACCAR intake manifold temp differential per bank
  if (staging["__intakeA"] != null && staging["__intakeB"] != null) {
    metrics["intakeTempBankDelta"] = Math.abs(staging["__intakeA"] - staging["__intakeB"]);
  }

  return metrics;
}

/**
 * Fetch data from an OEM REST API endpoint.
 * Returns the parsed JSON response body or null on failure.
 */
async function fetchOemData(endpointUrl, apiKey, allowedHosts = []) {
  let target;
  try {
    target = await validateOutboundHttpsUrl(endpointUrl, { allowedHosts });
  } catch (_) {
    return null;
  }
  return new Promise((resolve) => {
    try {
      const parsed = target.parsed;
      const req = https.request(
        {
          hostname: parsed.hostname,
          path:     parsed.pathname + parsed.search,
          method:   "GET",
          headers:  {
            "Authorization": `Bearer ${apiKey}`,
            "Accept":        "application/json",
            "User-Agent":    "FleetAI-OEMIngestion/1.0",
          },
          timeout: 10000,
          lookup: pinnedLookup(target.addresses),
          servername: parsed.hostname,
        },
        (res) => {
          let body = "";
          res.on("data", (chunk) => { body += chunk; });
          res.on("end", () => {
            try {
              resolve(JSON.parse(body));
            } catch (_) {
              resolve(null);
            }
          });
        }
      );
      req.on("timeout", () => { req.destroy(); resolve(null); });
      req.on("error", () => resolve(null));
      req.end();
    } catch (_) {
      resolve(null);
    }
  });
}

/**
 * Poll a single OEM integration and store results.
 */
async function pollIntegration(storageVehicleId, config, telemetryStore, nowIso) {
  const { provider, apiKey, endpointUrl, allowedHosts } = config;
  try {
    const raw = await fetchOemData(endpointUrl, apiKey, allowedHosts);
    if (!raw) return;

    const metrics = normalizeOemPayload(provider, raw);
    if (!Object.keys(metrics).length) return;

    // Store as a telemetry sample with source "oem_api"
    await telemetryStore.appendFrames(storageVehicleId, [{
      ts:      nowIso(),
      source:  "oem_api",
      provider,
      metrics,
    }]);

    config.lastPolledAt = new Date().toISOString();
  } catch (_) {
    // Non-fatal — OEM API unavailability should not affect core predictions
  }
}

/**
 * Register an OEM integration for a vehicle.
 * Starts polling immediately and schedules recurring polls.
 */
async function registerIntegration({ tenantScope, vehicleId, provider, apiKey, endpointUrl, intervalMin = 15, allowedHosts = [] }, telemetryStore, nowIso) {
  if (!tenantScope || !vehicleId || !provider || !apiKey || !endpointUrl) return false;
  if (!_FIELD_MAPS[provider]) {
    console.warn(`[oemIngestion] Unknown provider: ${provider}. Supported: ${Object.keys(_FIELD_MAPS).join(", ")}`);
    return false;
  }

  await validateOutboundHttpsUrl(endpointUrl, { allowedHosts });
  const registryKey = `${tenantScope}:${vehicleId}`;

  // Clear existing timer if re-registering
  if (_registry.has(registryKey)) {
    clearInterval(_registry.get(registryKey).timerId);
  }

  const config = { tenantScope, vehicleId, provider, apiKey, endpointUrl, intervalMin, allowedHosts, lastPolledAt: null, timerId: null };
  const intervalMs = Math.max(5, intervalMin) * 60 * 1000;

  // Poll immediately then on schedule
  pollIntegration(vehicleId, config, telemetryStore, nowIso);
  config.timerId = setInterval(
    () => pollIntegration(vehicleId, config, telemetryStore, nowIso),
    intervalMs
  );

  _registry.set(registryKey, config);
  console.log(`[oemIngestion] Registered ${provider} integration for vehicle ${vehicleId} (every ${intervalMin}min)`);
  return true;
}

/**
 * Remove an OEM integration and stop polling.
 */
function deregisterIntegration(tenantScope, vehicleId) {
  const registryKey = `${tenantScope}:${vehicleId}`;
  const config = _registry.get(registryKey);
  if (config?.timerId) clearInterval(config.timerId);
  _registry.delete(registryKey);
}

/**
 * List all active integrations (for admin UI).
 */
function listIntegrations() {
  const result = [];
  for (const [, config] of _registry.entries()) {
    result.push({
      tenantScope: config.tenantScope,
      vehicleId: config.vehicleId,
      provider:      config.provider,
      intervalMin:   config.intervalMin,
      lastPolledAt:  config.lastPolledAt,
      endpointUrl:   config.endpointUrl.replace(/apikey=[^&]+/i, "apikey=***"),
    });
  }
  return result;
}

/**
 * Accept a push payload directly (for OEM APIs that support webhooks instead of polling).
 * Call this from a POST endpoint to ingest OEM data without waiting for the poll cycle.
 */
async function ingestPush(vehicleId, provider, rawPayload, telemetryStore, nowIso) {
  if (!_FIELD_MAPS[provider]) return { ok: false, error: `Unknown provider: ${provider}` };
  const metrics = normalizeOemPayload(provider, rawPayload);
  if (!Object.keys(metrics).length) return { ok: false, error: "No recognizable fields in payload" };
  await telemetryStore.appendFrames(vehicleId, [{ ts: nowIso(), source: "oem_push", provider, metrics }]);
  return { ok: true, metricsIngested: Object.keys(metrics).length, metrics };
}

module.exports = { registerIntegration, deregisterIntegration, listIntegrations, ingestPush, normalizeOemPayload };
