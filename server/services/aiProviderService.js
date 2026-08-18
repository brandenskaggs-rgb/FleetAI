const https = require("https");

const DEFAULT_GROQ_MODEL = "openai/gpt-oss-120b";
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
const RETIRED_GROQ_MODELS = new Set([
  "llama-3.1-8b-instant",
  "llama-3.3-70b-versatile",
  "meta-llama/llama-4-scout-17b-16e-instruct",
  "qwen/qwen3-32b"
]);

class AiProviderError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "AiProviderError";
    this.code = code;
    this.status = options.status || 0;
    this.retryable = Boolean(options.retryable);
  }
}

function normalizeProvider(value) {
  const provider = String(value || "").trim().toLowerCase();
  return provider === "openai" ? "openai" : "groq";
}

function resolveProviderConfig(providerOverride, env = process.env) {
  const provider = normalizeProvider(providerOverride || env.AI_PROVIDER || (env.GROQ_API_KEY ? "groq" : "openai"));
  if (provider === "groq") {
    const explicitModel = String(env.GROQ_MODEL || "").trim();
    const legacyModel = String(env.AI_MODEL || "").trim();
    const model = explicitModel || (RETIRED_GROQ_MODELS.has(legacyModel) ? DEFAULT_GROQ_MODEL : legacyModel) || DEFAULT_GROQ_MODEL;
    return {
      provider,
      enabled: String(env.AI_ENABLED || "").toLowerCase() === "true",
      configured: Boolean(String(env.GROQ_API_KEY || "").trim()),
      apiKey: String(env.GROQ_API_KEY || "").trim(),
      hostname: "api.groq.com",
      path: "/openai/v1/chat/completions",
      model
    };
  }
  return {
    provider,
    enabled: String(env.AI_ENABLED || "").toLowerCase() === "true",
    configured: Boolean(String(env.OPENAI_API_KEY || "").trim()),
    apiKey: String(env.OPENAI_API_KEY || "").trim(),
    hostname: "api.openai.com",
    path: "/v1/chat/completions",
    model: String(env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL).trim()
  };
}

function getAiProviderStatus(providerOverride, env = process.env) {
  const config = resolveProviderConfig(providerOverride, env);
  return {
    enabled: config.enabled,
    configured: config.configured,
    available: config.enabled && config.configured,
    provider: config.provider,
    model: config.model
  };
}

function parseProviderResponse(statusCode, raw) {
  let parsed;
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch (_) {
    throw new AiProviderError("AI_INVALID_RESPONSE", "AI provider returned invalid JSON", {
      status: statusCode,
      retryable: statusCode >= 500
    });
  }
  if (statusCode < 200 || statusCode >= 300 || parsed?.error) {
    const providerMessage = String(parsed?.error?.message || "AI provider request failed").slice(0, 300);
    throw new AiProviderError("AI_PROVIDER_ERROR", providerMessage, {
      status: statusCode,
      retryable: statusCode === 429 || statusCode >= 500
    });
  }
  const content = parsed?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new AiProviderError("AI_EMPTY_RESPONSE", "AI provider returned no message", { status: statusCode });
  }
  return content.trim();
}

function completeChat(messages, options = {}) {
  const config = resolveProviderConfig(options.provider, options.env || process.env);
  if (!config.enabled) {
    return Promise.reject(new AiProviderError("AI_DISABLED", "AI features are disabled"));
  }
  if (!config.configured) {
    return Promise.reject(new AiProviderError("AI_NOT_CONFIGURED", `${config.provider} API key is not configured`));
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return Promise.reject(new AiProviderError("AI_INVALID_REQUEST", "At least one AI message is required"));
  }

  const maxTokens = Math.max(1, Math.min(Number(options.maxTokens || 600), 2000));
  const temperature = Math.max(0, Math.min(Number(options.temperature ?? 0.3), 1));
  const payload = {
    model: config.model,
    messages,
    temperature
  };
  if (config.provider === "groq") payload.max_completion_tokens = maxTokens;
  else payload.max_tokens = maxTokens;
  if (config.provider === "groq" && config.model.startsWith("openai/gpt-oss-")) {
    payload.reasoning_effort = options.reasoningEffort || "low";
    payload.include_reasoning = false;
  }

  const body = JSON.stringify(payload);
  const timeoutMs = Math.max(1000, Math.min(Number(options.timeoutMs || 20_000), 60_000));
  return new Promise((resolve, reject) => {
    const request = https.request({
      hostname: config.hostname,
      path: config.path,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        Authorization: `Bearer ${config.apiKey}`
      }
    }, (response) => {
      let raw = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        raw += chunk;
        if (raw.length > 1_000_000) request.destroy(new Error("AI response exceeded size limit"));
      });
      response.on("end", () => {
        try {
          resolve({
            content: parseProviderResponse(response.statusCode || 0, raw),
            provider: config.provider,
            model: config.model
          });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("error", (error) => {
      if (error instanceof AiProviderError) return reject(error);
      reject(new AiProviderError("AI_NETWORK_ERROR", "Unable to reach AI provider", { retryable: true }));
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy();
      reject(new AiProviderError("AI_TIMEOUT", "AI provider timed out", { retryable: true }));
    });
    request.write(body);
    request.end();
  });
}

module.exports = {
  AiProviderError,
  DEFAULT_GROQ_MODEL,
  RETIRED_GROQ_MODELS,
  completeChat,
  getAiProviderStatus,
  parseProviderResponse,
  resolveProviderConfig
};
