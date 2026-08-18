const assert = require("assert");
const {
  DEFAULT_GROQ_MODEL,
  getAiProviderStatus,
  parseProviderResponse,
  resolveProviderConfig
} = require("../server/services/aiProviderService");

const groq = resolveProviderConfig(null, {
  AI_ENABLED: "true",
  GROQ_API_KEY: "test-key"
});
assert.strictEqual(groq.provider, "groq");
assert.strictEqual(groq.model, DEFAULT_GROQ_MODEL);

const migrated = resolveProviderConfig("groq", {
  AI_ENABLED: "true",
  GROQ_API_KEY: "test-key",
  AI_MODEL: "llama-3.3-70b-versatile"
});
assert.strictEqual(migrated.model, DEFAULT_GROQ_MODEL, "legacy retired model should migrate automatically");

const explicit = resolveProviderConfig("groq", {
  AI_ENABLED: "true",
  GROQ_API_KEY: "test-key",
  GROQ_MODEL: "qwen/qwen3.6-27b"
});
assert.strictEqual(explicit.model, "qwen/qwen3.6-27b");

const explicitLegacy = resolveProviderConfig("groq", {
  AI_ENABLED: "true",
  GROQ_API_KEY: "test-key",
  GROQ_MODEL: "llama-3.3-70b-versatile"
});
assert.strictEqual(explicitLegacy.model, "llama-3.3-70b-versatile", "explicit enterprise model choice should be preserved");

const status = getAiProviderStatus("groq", { AI_ENABLED: "true", GROQ_API_KEY: "test-key" });
assert.deepStrictEqual(
  { enabled: status.enabled, configured: status.configured, available: status.available },
  { enabled: true, configured: true, available: true }
);

assert.strictEqual(
  parseProviderResponse(200, JSON.stringify({ choices: [{ message: { content: " ready " } }] })),
  "ready"
);
assert.throws(
  () => parseProviderResponse(400, JSON.stringify({ error: { message: "model decommissioned" } })),
  (error) => error.code === "AI_PROVIDER_ERROR" && error.status === 400
);
assert.throws(
  () => parseProviderResponse(200, JSON.stringify({ choices: [] })),
  (error) => error.code === "AI_EMPTY_RESPONSE"
);

console.log("AI provider tests passed");
