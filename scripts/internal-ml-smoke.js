const BASE_URL = (process.env.FLEETAI_INTERNAL_ML_BASE_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");
const API_KEY = String(process.env.INTERNAL_ML_API_KEY || "").trim();

function fail(message, details) {
  console.error(`[internal-ml-smoke] ${message}`);
  if (details) console.error(details);
  process.exit(1);
}

async function request(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) {}
  return { res, data, text };
}

async function main() {
  if (!API_KEY) {
    fail("INTERNAL_ML_API_KEY is required; not printing or generating secrets from this script.");
  }

  const status = await request("/internal/ml/status");
  if (!status.res.ok || !status.data?.ok) {
    fail(`status failed with HTTP ${status.res.status}`, status.data || status.text);
  }
  console.log(`[internal-ml-smoke] status ok source=${status.data.data?.serviceAvailable === false ? "node-fallback-ready" : "python-ready"}`);

  const prediction = await request("/internal/ml/predict", {
    method: "POST",
    body: JSON.stringify({
      externalVehicleId: "internal-smoke-truck-2701",
      vehicle: {
        make: "Freightliner",
        model: "Cascadia",
        year: 2022,
        vehicleClass: "heavy_duty_j1939",
        protocol: "J1939",
        powertrain: "diesel"
      },
      telemetry: {
        rpm: 1450,
        coolantTemp: 101,
        oilTemp: 108,
        oilPressure: 35,
        fuelRate: 8.1,
        batteryVoltage: 13.4,
        dpfSootLoad: 27,
        brakeTemp: 118,
        tirePressure: 251,
        odometer: 184220,
        engineHours: 6120,
        ambientTemp: 26,
        payloadRatio: 0.72
      }
    })
  });
  if (!prediction.res.ok || !prediction.data?.ok) {
    fail(`prediction failed with HTTP ${prediction.res.status}`, prediction.data || prediction.text);
  }
  const data = prediction.data.data || {};
  if (!data.predictionSource || !data.riskLevel) {
    fail("prediction response missing expected fields", data);
  }
  console.log(`[internal-ml-smoke] predict ok source=${data.predictionSource} risk=${data.riskLevel} model=${data.modelVersion || "--"}`);
}

main().catch((err) => fail(err.stack || err.message));
