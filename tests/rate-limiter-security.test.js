const assert = require("assert");
const { hashRateLimitValue, trustedIpKey } = require("../server/middleware/rateLimiter");

function testApiKeyHeaderCannotChangePublicIdentity() {
  const base = { ip: "203.0.113.25", socket: {}, headers: {} };
  const forged = { ...base, headers: { "x-api-key": "attacker-rotated-value" } };
  assert.strictEqual(trustedIpKey(base), trustedIpKey(forged));
}

function testAccountKeysDoNotExposeEmails() {
  const email = "customer@example.test";
  const key = hashRateLimitValue(email);
  assert.strictEqual(key.length, 32);
  assert(!key.includes("customer"));
  assert.strictEqual(key, hashRateLimitValue(email));
  assert.notStrictEqual(key, hashRateLimitValue("other@example.test"));
}

testApiKeyHeaderCannotChangePublicIdentity();
testAccountKeysDoNotExposeEmails();
console.log("Rate limiter security tests: 2 passed, 0 failed");
