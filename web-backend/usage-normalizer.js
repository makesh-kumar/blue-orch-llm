/**
 * usage-normalizer.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Maps raw LLM provider usage objects into a single StandardizedUsage shape.
 *
 * StandardizedUsage JSDoc typedef:
 *
 * @typedef {Object} StandardizedUsage
 * @property {number} input      - Total prompt tokens INCLUDING cached portion
 * @property {number} output     - Output / completion tokens
 * @property {number} cached     - Tokens served from provider-side cache
 * @property {string} model      - Model identifier string
 * @property {string} provider   - 'gemini' | 'openai' | 'claude' | 'ollama'
 * @property {number} latencyMs  - Wall-clock request latency in milliseconds
 */

const ts = () => new Date(Date.now() + (5 * 60 + 30) * 60000).toISOString().replace('Z', '+05:30');

/**
 * Normalise a raw provider usage object into a StandardizedUsage object.
 *
 * Convention: `input` = TOTAL prompt tokens (cached + non-cached combined).
 * Cost calculation should derive non-cached as (input − cached).
 *
 * @param {object|null} rawUsage   Raw usage / stats from the provider SDK
 * @param {string}      provider   'gemini' | 'openai' | 'claude' | 'ollama'
 * @param {{ model?: string, latencyMs?: number }} [meta]
 * @returns {StandardizedUsage}
 */
export function mapProviderUsage(rawUsage, provider, meta = {}) {
  console.log(`[INIT] ${ts()} mapProviderUsage() | provider: ${provider}`);

  const model     = meta.model     ?? '';
  const latencyMs = meta.latencyMs ?? 0;

  let result;

  if (provider === 'gemini') {
    // ── Gemini SDK (@google/genai) ─────────────────────────────────────────
    // promptTokenCount includes cached tokens; cachedContentTokenCount is the subset.
    const u = rawUsage ?? {};
    result = {
      input:     u.promptTokenCount        ?? 0,
      output:    u.candidatesTokenCount    ?? 0,
      cached:    u.cachedContentTokenCount ?? 0,
      model, provider, latencyMs,
    };
  }

  else if (provider === 'openai') {
    // ── OpenAI SDK ─────────────────────────────────────────────────────────
    // prompt_tokens includes cached tokens; prompt_tokens_details.cached_tokens is the subset.
    const u = rawUsage ?? {};
    result = {
      input:     u.prompt_tokens                          ?? 0,
      output:    u.completion_tokens                      ?? 0,
      cached:    u.prompt_tokens_details?.cached_tokens   ?? 0,
      model, provider, latencyMs,
    };
  }

  else if (provider === 'claude') {
    // ── Anthropic SDK ──────────────────────────────────────────────────────
    // input_tokens = non-cached billed input.
    // cache_creation_input_tokens = tokens written to cache (billed at input rate).
    // cache_read_input_tokens = tokens read from cache (billed at cached rate).
    // Normalise to: input = total (all three summed), cached = cache reads only.
    const u = rawUsage ?? {};
    const cacheCreate = u.cache_creation_input_tokens ?? 0;
    const cacheRead   = u.cache_read_input_tokens    ?? 0;
    result = {
      input:  (u.input_tokens ?? 0) + cacheCreate + cacheRead,
      output:  u.output_tokens ?? 0,
      cached:  cacheRead,
      model, provider, latencyMs,
    };
  }

  else if (provider === 'ollama') {
    // ── Ollama ─────────────────────────────────────────────────────────────
    // Native Ollama fields: prompt_eval_count, eval_count, total_duration (ns).
    // OpenAI-compat fallback: usage.prompt_tokens, usage.completion_tokens.
    const u = rawUsage ?? {};
    const nativeLatencyMs = u.total_duration
      ? Math.round(u.total_duration / 1_000_000) // nanoseconds → ms
      : latencyMs;
    result = {
      input:     u.prompt_eval_count ?? u.prompt_tokens     ?? 0,
      output:    u.eval_count        ?? u.completion_tokens ?? 0,
      cached:    0,
      model, provider,
      latencyMs: nativeLatencyMs,
    };
  }

  else if (provider === 'lmstudio') {
    // ── LM Studio (OpenAI-compatible) ──────────────────────────────────────
    // Standard OpenAI usage fields.  LM Studio also sends a `stats` object
    // with hardware telemetry — capture tokens_per_second if present.
    const u = rawUsage ?? {};
    const tokensPerSecond = meta.stats?.tokens_per_second ?? null;
    result = {
      input:     u.prompt_tokens     ?? 0,
      output:    u.completion_tokens ?? 0,
      cached:    0,
      model, provider, latencyMs,
      ...(tokensPerSecond !== null && { tokensPerSecond }),
    };
  }

  else {
    result = { input: 0, output: 0, cached: 0, model, provider, latencyMs };
  }

  console.log(`[SUCCESS] ${ts()} mapProviderUsage() | ${JSON.stringify(result)}`);
  return result;
}
