const assert = require("assert");
const fs = require("fs");
const path = require("path");
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
