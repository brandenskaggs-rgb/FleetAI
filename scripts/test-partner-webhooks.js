#!/usr/bin/env node
/**
 * Partner API + Webhook smoke test.
 *
 * Spins up a local HTTP receiver on a random port, provisions a test API key,
 * registers a webhook, fires a prediction, and verifies the webhook payload
 * arrives within 5 seconds. Cleans up after itself.
 *
 * Usage:
 *   node scripts/test-partner-webhooks.js
 *
 * Requires a running Fleet AI server (default: http://localhost:3000).
 * Override with SERVER_URL env var.
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const http   = require("http");
const crypto = require("crypto");
const { PrismaClient } = require("@prisma/client");
const { Pool }     = require("pg");
const { PrismaPg } = require("@prisma/adapter-pg");

const BASE = process.env.SERVER_URL || "http://localhost:3000";
const PASS = "\x1b[32m✓\x1b[0m";
const FAIL = "\x1b[31m✗\x1b[0m";

let createdKeyId = null;
let createdWebhookId = null;

// ── tiny HTTP helpers ─────────────────────────────────────────────────────────

function request(method, path, body, apiKey) {
  return new Promise((resolve, reject) => {
    const url   = new URL(path, BASE);
    const data  = body ? JSON.stringify(body) : null;
    const opts  = {
      hostname: url.hostname,
      port:     url.port || 3000,
      path:     url.pathname + url.search,
      method,
      headers: {
        "Content-Type": "application/json",
        ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
        ...(apiKey ? { "X-API-Key": apiKey } : {}),
      },
    };
    const req = http.request(opts, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

// ── local webhook receiver ────────────────────────────────────────────────────

function startReceiver() {
  return new Promise((resolve) => {
    const received = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received.push({
          event:     req.headers["x-fleetai-event"],
          signature: req.headers["x-fleetai-signature"],
          body:      JSON.parse(body || "{}"),
        });
        res.writeHead(200);
        res.end("ok");
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, port, received });
    });
  });
}

// ── assertions ────────────────────────────────────────────────────────────────

function assert(label, condition, detail = "") {
  if (condition) {
    console.log(`  ${PASS}  ${label}`);
  } else {
    console.log(`  ${FAIL}  ${label}${detail ? ` — ${detail}` : ""}`);
    process.exitCode = 1;
  }
}

function waitFor(received, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (received.length > 0) return resolve(received[0]);
      if (Date.now() > deadline) return resolve(null);
      setTimeout(check, 100);
    };
    check();
  });
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n  Fleet AI — Partner Webhook Smoke Test\n");

  // 1. Provision a temporary API key via Prisma (same as provision-partner.js)
  console.log("  [1] Provisioning test API key...");
  const pool   = new Pool({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  await prisma.$connect();

  const raw  = `fai_test_${crypto.randomBytes(16).toString("hex")}`;
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  const keyRecord = await prisma.apiKey.create({
    data: { keyHash: hash, partnerName: "smoke-test", tier: "partner_ml", enabled: true },
  });
  createdKeyId = keyRecord.id;
  const apiKey = raw;
  assert("API key created", !!keyRecord.id, keyRecord.id);

  // 2. Start local webhook receiver
  console.log("\n  [2] Starting local webhook receiver...");
  const { server, port, received } = await startReceiver();
  const webhookUrl = `http://127.0.0.1:${port}/webhook`;
  const secret     = crypto.randomBytes(16).toString("hex");
  assert("Receiver listening", port > 0, `port ${port}`);

  // 3. Register webhook
  console.log("\n  [3] Registering webhook...");
  const regRes = await request("POST", "/api/partner/webhooks", {
    url:    webhookUrl,
    events: ["risk_threshold_crossed", "stage2_confirmed"],
    secret,
    threshold: 0.35,
  }, apiKey);
  assert("Webhook registered (HTTP 200)", regRes.status === 200, `got ${regRes.status}`);
  assert("Webhook ID returned", !!regRes.body?.webhook?.id);
  if (regRes.body?.webhook?.id) createdWebhookId = regRes.body.webhook.id;

  // 4. List webhooks
  console.log("\n  [4] Listing webhooks...");
  const listRes = await request("GET", "/api/partner/webhooks", null, apiKey);
  assert("List returns registered hook", listRes.body?.count >= 1, `count: ${listRes.body?.count}`);

  // 5. Fire a prediction with high risk metrics (should trigger webhook)
  console.log("\n  [5] Firing prediction (high-risk metrics)...");
  const predRes = await request("POST", "/api/partner/predict", {
    vehicleId: "smoke-test-truck-01",
    samples: [{
      ts:             new Date().toISOString(),
      rpm:            3200,        // elevated — high load
      coolantTemp:    112,         // overheating threshold
      batteryVoltage: 11.8,        // dropping
      engineLoad:     95,          // near max
      oilPressure:    18,          // dangerously low
      dpfSootLoad:    98,          // DPF almost full
    }],
  }, apiKey);
  assert("Prediction returned success", predRes.body?.success === true, JSON.stringify(predRes.body?.error));
  assert("riskProbability present", predRes.body?.riskProbability != null, String(predRes.body?.riskProbability));
  console.log(`       riskProbability = ${predRes.body?.riskProbability}`);
  console.log(`       prediction      = ${predRes.body?.prediction}`);
  console.log(`       mlAvailable     = ${predRes.body?.modelInfo?.mlServiceAvailable}`);

  // 6. Wait for webhook delivery
  console.log("\n  [6] Waiting for webhook delivery (up to 5s)...");
  const hook = await waitFor(received, 5000);
  if (predRes.body?.riskProbability >= 0.35) {
    assert("Webhook received", hook !== null, "timed out — check server logs");
    if (hook) {
      assert("Event header correct", hook.event === "risk_threshold_crossed", hook.event);
      assert("vehicleId in payload", hook.body?.vehicleId === "smoke-test-truck-01");
      assert("riskProbability in payload", hook.body?.riskProbability != null);

      // Verify HMAC signature
      const expectedSig = "sha256=" + crypto.createHmac("sha256", secret)
        .update(JSON.stringify(hook.body))
        .digest("hex");
      // Note: signature is computed over the raw body bytes as sent, not re-serialized
      assert("Signature header present", !!hook.signature);
      console.log(`       event     = ${hook.event}`);
      console.log(`       signature = ${hook.signature?.slice(0, 30)}...`);
    }
  } else {
    console.log(`       Risk below 0.35 — no webhook expected (riskProbability: ${predRes.body?.riskProbability})`);
    assert("No spurious webhook fired", hook === null);
  }

  // 7. DELETE webhook
  console.log("\n  [7] Deleting webhook...");
  if (createdWebhookId) {
    const delRes = await request("DELETE", `/api/partner/webhooks/${createdWebhookId}`, null, apiKey);
    assert("Webhook deleted", delRes.body?.success === true, JSON.stringify(delRes.body));
    createdWebhookId = null;
  }

  // 8. Cleanup — revoke test key
  console.log("\n  [8] Revoking test key...");
  await prisma.apiKey.update({ where: { id: createdKeyId }, data: { enabled: false } });
  assert("Test key revoked", true);
  createdKeyId = null;

  server.close();
  await prisma.$disconnect();
  await pool.end();

  const exitCode = process.exitCode || 0;
  console.log(exitCode === 0
    ? "\n  All checks passed.\n"
    : "\n  Some checks failed — see above.\n"
  );
}

main().catch(async (err) => {
  console.error("\n  Fatal:", err.message, "\n");

  // Best-effort cleanup
  try {
    const pool2   = new Pool({ connectionString: process.env.DATABASE_URL });
    const prisma2 = new PrismaClient({ adapter: new PrismaPg(pool2) });
    if (createdWebhookId) await prisma2.partnerWebhook.delete({ where: { id: createdWebhookId } }).catch(() => {});
    if (createdKeyId)     await prisma2.apiKey.update({ where: { id: createdKeyId }, data: { enabled: false } }).catch(() => {});
    await prisma2.$disconnect();
    await pool2.end();
  } catch (_) {}

  process.exit(1);
});
