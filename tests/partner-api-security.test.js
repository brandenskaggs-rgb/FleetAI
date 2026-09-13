const assert = require("assert");
const fs = require("fs");
const path = require("path");
const db = require("../server/db");
const { requireApiKey, issueStreamTicket } = require("../server/middleware/apiKeyAuth");

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

async function runMiddleware(req) {
  const res = response();
  let passed = false;
  await requireApiKey(req, res, () => { passed = true; });
  return { res, passed, apiKey: req.apiKey };
}

(async () => {
  const queryKey = await runMiddleware({
    method: "GET",
    path: "/api/partner/stream",
    query: { apiKey: "must-not-work" },
    headers: {}
  });
  assert.strictEqual(queryKey.passed, false);
  assert.strictEqual(queryKey.res.statusCode, 401);

  const identity = { id: "KEY_A", orgId: "ORG_A", partner: "Partner A", tier: "partner_ml" };
  const originalGetPrisma = db.getPrisma;
  let enabled = true;
  db.getPrisma = () => ({ apiKey: { findUnique: async () => ({ ...identity, partnerName: identity.partner, enabled }) } });
  const issued = issueStreamTicket(identity);
  const first = await runMiddleware({
    method: "GET",
    path: "/api/partner/stream",
    query: { streamTicket: issued.ticket },
    headers: {}
  });
  assert.strictEqual(first.passed, true);
  assert.deepStrictEqual(first.apiKey, identity);
  const replay = await runMiddleware({
    method: "GET",
    path: "/api/partner/stream",
    query: { streamTicket: issued.ticket },
    headers: {}
  });
  assert.strictEqual(replay.passed, false);
  assert.strictEqual(replay.res.statusCode, 403);

  const revokedTicket = issueStreamTicket(identity);
  enabled = false;
  const revoked = await runMiddleware({ method: "GET", path: "/api/partner/stream", query: { streamTicket: revokedTicket.ticket }, headers: {} });
  assert.strictEqual(revoked.passed, false, "revoking an API key must invalidate issued tickets");
  assert.strictEqual(revoked.res.statusCode, 403);
  enabled = true;
  const scopedTicket = issueStreamTicket(identity, "TRUCK_A");
  const wrongVehicle = await runMiddleware({ method: "GET", path: "/api/partner/stream", query: { streamTicket: scopedTicket.ticket, vehicleId: "TRUCK_B" }, headers: {} });
  assert.strictEqual(wrongVehicle.passed, false, "a vehicle-specific ticket must not grant another vehicle or fleet access");
  db.getPrisma = originalGetPrisma;

  const source = fs.readFileSync(path.join(__dirname, "..", "server", "routes", "partnerRoutes.js"), "utf8");
  assert.match(source, /function partnerScope/);
  assert.match(source, /vehicleHash/);
  assert.match(source, /partnerPredictionLimiter/);
  assert.match(source, /partnerBatchLimiter/);
  assert.match(source, /OEM_ALLOWED_HOSTS/);
  assert.doesNotMatch(source, /req\.query\.apiKey/);

  console.log("Partner API security tests passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
