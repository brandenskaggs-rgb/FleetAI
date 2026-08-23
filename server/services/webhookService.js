/**
 * Webhook delivery service.
 *
 * Fires POST requests to partner-registered URLs when fleet events occur.
 * Retries up to 3 times with exponential backoff on failure.
 * Signs payloads with HMAC-SHA256 when a webhook secret is configured.
 */

const crypto = require("crypto");
const https = require("https");
const { getPrisma } = require("../db");
const { validateOutboundHttpsUrl, pinnedLookup } = require("../lib/outboundUrlPolicy");

const MAX_RETRIES = 3;
const TIMEOUT_MS = 8000;

// Events that can trigger webhooks
const WEBHOOK_EVENTS = {
  RISK_THRESHOLD_CROSSED: "risk_threshold_crossed",
  STAGE2_CONFIRMED:       "stage2_confirmed",
  DTC_CRITICAL:           "dtc_critical",
  MODEL_READY:            "model_ready",
};

/**
 * Sign a payload with HMAC-SHA256 using the webhook secret.
 * Partners verify: X-FleetAI-Signature header matches.
 */
function signPayload(secret, body) {
  return "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
}

/**
 * Fire a single HTTP POST to a webhook URL.
 * Returns { ok, statusCode, error }.
 */
async function deliverOne(url, payload, secret) {
  let target;
  try {
    target = await validateOutboundHttpsUrl(url);
  } catch (error) {
    return { ok: false, error: error.message };
  }
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const parsed = target.parsed;
    const headers = {
      "Content-Type":   "application/json",
      "Content-Length": Buffer.byteLength(body),
      "User-Agent":     "FleetAI-Webhook/1.0",
      "X-FleetAI-Event": payload.event,
    };
    if (secret) {
      headers["X-FleetAI-Signature"] = signPayload(secret, body);
    }

    const req = https.request(
      {
        hostname: parsed.hostname,
        port:     443,
        path:     parsed.pathname + parsed.search,
        method:   "POST",
        headers,
        timeout:  TIMEOUT_MS,
        lookup: pinnedLookup(target.addresses),
        servername: parsed.hostname,
      },
      (res) => {
        res.resume();
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, statusCode: res.statusCode });
      }
    );
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: "timeout" }); });
    req.on("error", (err) => resolve({ ok: false, error: err.message }));
    req.write(body);
    req.end();
  });
}

/**
 * Deliver a webhook with retries. Fire-and-forget — does not throw.
 */
async function deliver(webhook, payload) {
  let delay = 1000;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const result = await deliverOne(webhook.url, payload, webhook.secret);
    if (result.ok) return;
    if (attempt < MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, delay));
      delay *= 2;
    }
  }
}

/**
 * Fire webhooks for all active registrations matching an event + partner.
 *
 * @param {string} partner          - Partner name (from API key)
 * @param {string} apiKeyId         - API key ID
 * @param {string} event            - One of WEBHOOK_EVENTS
 * @param {object} payload          - Data to send
 * @param {number} [riskProbability] - Current risk score; compared against per-hook threshold
 */
async function fireWebhooks(partner, apiKeyId, event, payload, riskProbability) {
  try {
    const prisma = getPrisma();
    const hooks = await prisma.partnerWebhook.findMany({
      where: { apiKeyId, active: true },
    });

    for (const hook of hooks) {
      const events = Array.isArray(hook.events) ? hook.events : [];
      if (!events.includes(event) && !events.includes("*")) continue;

      // Respect the per-webhook threshold the partner configured at registration
      const hookThreshold = parseFloat(hook.threshold) || 0.35;
      if (riskProbability != null && riskProbability < hookThreshold) continue;

      const fullPayload = {
        event,
        deliveredAt: new Date().toISOString(),
        partner,
        ...payload,
      };

      // Non-blocking delivery
      deliver(hook, fullPayload).catch(() => {});
    }
  } catch (_) {
    // Never let webhook failure affect the main response
  }
}

/**
 * Check a prediction result and fire appropriate webhooks.
 * Call this after every predict response.
 */
async function notifyPrediction(partner, apiKeyId, vehicleId, prediction) {
  const { riskProbability, stageSystem, activeFaults } = prediction;

  const threshold = 0.35;
  if (!riskProbability || riskProbability < threshold) return;

  const base = { vehicleId, riskProbability, prediction: prediction.prediction };

  // Build all applicable webhook tasks and fire them in parallel
  const tasks = [
    fireWebhooks(partner, apiKeyId, WEBHOOK_EVENTS.RISK_THRESHOLD_CROSSED, {
      ...base,
      threshold,
      advisoryText: prediction.advisoryText,
    }, riskProbability),
  ];

  if (stageSystem?.confirmed) {
    tasks.push(fireWebhooks(partner, apiKeyId, WEBHOOK_EVENTS.STAGE2_CONFIRMED, {
      ...base,
      stage2Score:        stageSystem.stage2Score,
      signalAgreement:    stageSystem.signalAgreement,
      confirmationReason: stageSystem.confirmationReason,
    }, riskProbability));
  }

  if (activeFaults?.riskScore >= 0.7) {
    tasks.push(fireWebhooks(partner, apiKeyId, WEBHOOK_EVENTS.DTC_CRITICAL, {
      ...base,
      codes:           activeFaults.codes,
      systemsAffected: activeFaults.systemsAffected,
    }, riskProbability));
  }

  await Promise.all(tasks);
}

module.exports = { fireWebhooks, notifyPrediction, WEBHOOK_EVENTS };
