import { Router } from 'express';
import { randomUUID } from 'crypto';

const router = Router();
const ts = () => new Date(Date.now() + (5 * 60 + 30) * 60000).toISOString().replace('Z', '+05:30');

// ─── LLM Registry ─────────────────────────────────────────────────────────────
// Map<id, { id, provider, model, apiKey, latency, verifiedAt }>
// Exported so Phase 3 chat routes can call getActiveConfig() to get the full
// config (including apiKey) for the currently selected provider.
export const connectedLlmRegistry = new Map();

const llmState = { activeLlmId: null };

/** Returns the full config (incl. apiKey) for the active provider, or null. */
export const getActiveConfig = () => {
  if (!llmState.activeLlmId) return null;
  return connectedLlmRegistry.get(llmState.activeLlmId) ?? null;
};

// ─── POST /api/llm/verify ─────────────────────────────────────────────────────
// Body:    { provider, model, apiKey?, baseUrl? }
// Returns: { success: true, id, provider, model, latency, verifiedAt }
router.post('/verify', async (req, res) => {
  const { provider, model, apiKey, baseUrl } = req.body;
  const ollamaBase   = (baseUrl ?? 'http://localhost:11434').replace(/\/$/, '');
  const lmstudioBase = (baseUrl ?? 'http://localhost:1234').replace(/\/$/, '');

  if (!provider || !model) {
    return res.status(400).json({ error: 'provider and model are required' });
  }
  if (provider !== 'ollama' && provider !== 'lmstudio' && !apiKey) {
    return res.status(400).json({ error: 'apiKey is required for cloud providers' });
  }

  const start = Date.now();
  console.log(`[INIT] ${ts()} Verifying LLM | provider: ${provider} | model: ${model}`);

  try {
    if (provider === 'ollama') {
      // Ping /api/tags — lists local models, confirms Ollama is running
      const resp = await fetch(`${ollamaBase}/api/tags`);
      if (!resp.ok) throw new Error(`Ollama responded with HTTP ${resp.status}`);
      const data = await resp.json();
      const available = (data.models ?? []).map(m => m.name);
      if (!available.includes(model)) {
        throw new Error(`Model "${model}" not found in Ollama. Available: ${available.join(', ') || 'none'}`);
      }

    } else if (provider === 'gemini') {
      const { GoogleGenAI } = await import('@google/genai');
      const ai = new GoogleGenAI({ apiKey });
      // generateContent with a minimal prompt validates key + model without significant cost
      await ai.models.generateContent({ model, contents: [{ role: 'user', parts: [{ text: 'ping' }] }] });

    } else if (provider === 'openai') {
      const OpenAI = (await import('openai')).default;
      const openai = new OpenAI({ apiKey });
      // models.list() validates the key without incurring inference cost
      await openai.models.list();

    } else if (provider === 'claude') {
      const Anthropic = (await import('@anthropic-ai/sdk')).default;
      const client = new Anthropic({ apiKey });
      // Minimal 1-token message to confirm key validity
      await client.messages.create({
        model,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      });

    } else if (provider === 'lmstudio') {
      // ── LM Studio — OpenAI-compatible local server ──────────────────────────
      const OpenAI = (await import('openai')).default;
      const lmstudio = new OpenAI({ baseURL: `${lmstudioBase}/v1`, apiKey: 'lm-studio' });
      let modelsRes;
      try {
        modelsRes = await lmstudio.models.list();
      } catch (connectErr) {
        const isRefused = connectErr.cause?.code === 'ECONNREFUSED' || connectErr.code === 'ECONNREFUSED';
        throw new Error(
          isRefused
            ? 'LM Studio Server Not Found. Enable Developer Mode and Start Server in LM Studio.'
            : connectErr.message
        );
      }
      const available = (modelsRes.data ?? []).map(m => m.id);
      if (available.length > 0 && !available.includes(model)) {
        throw new Error(
          `Model "${model}" is not loaded in LM Studio. Loaded: ${available.join(', ') || 'none'}`
        );
      }

    } else {
      return res.status(400).json({ error: `Unknown provider: "${provider}"` });
    }

    const latency = Date.now() - start;
    const id = randomUUID();
    const verifiedAt = ts();

    connectedLlmRegistry.set(id, {
      id, provider, model,
      apiKey: provider === 'lmstudio' ? 'lm-studio' : (apiKey ?? ''),
      ...(provider === 'ollama'   && { baseUrl: ollamaBase }),
      ...(provider === 'lmstudio' && { baseUrl: lmstudioBase }),
      latency, verifiedAt,
    });

    // Auto-promote to active if this is the first entry in the registry
    if (!llmState.activeLlmId) {
      llmState.activeLlmId = id;
    }

    console.log(`[SUCCESS] ${ts()} LLM verified | id: ${id} | provider: ${provider} | model: ${model} | latency: ${latency}ms`);
    return res.json({ success: true, id, provider, model, latency, verifiedAt });

  } catch (err) {
    const latency = Date.now() - start;
    console.error(`[ERROR] ${ts()} LLM verification failed | provider: ${provider} | ${err.message}`);
    return res.status(400).json({ success: false, latency, error: err.message });
  }
});

// ─── GET /api/llm/lmstudio/models ────────────────────────────────────────────
// Returns the list of models currently loaded in LM Studio.
// Optional query param: ?baseUrl=http://localhost:1234
router.get('/lmstudio/models', async (req, res) => {
  const lmstudioBase = ((req.query.baseUrl ?? 'http://localhost:1234') + '').replace(/\/$/, '');
  console.log(`[INIT] ${ts()} Fetching LM Studio models | baseUrl: ${lmstudioBase}`);
  try {
    const OpenAI = (await import('openai')).default;
    const lmstudio = new OpenAI({ baseURL: `${lmstudioBase}/v1`, apiKey: 'lm-studio' });
    const modelsRes = await lmstudio.models.list();
    const models = (modelsRes.data ?? []).map(m => ({ id: m.id }));
    console.log(`[SUCCESS] ${ts()} LM Studio models fetched | ${models.length} models`);
    return res.json({ models });
  } catch (err) {
    const isRefused = err.cause?.code === 'ECONNREFUSED' || err.code === 'ECONNREFUSED';
    console.error(`[ERROR] ${ts()} Failed to fetch LM Studio models | ${err.message}`);
    return res.status(isRefused ? 503 : 500).json({
      error: isRefused
        ? 'LM Studio Server Not Found. Enable Developer Mode and Start Server in LM Studio.'
        : err.message,
    });
  }
});

// ─── GET /api/llm/registry ────────────────────────────────────────────────────
// Returns all verified entries (without apiKeys) and the current activeId.
router.get('/registry', (_req, res) => {
  const registry = Array.from(connectedLlmRegistry.values()).map(
    ({ id, provider, model, latency, verifiedAt }) => ({ id, provider, model, latency, verifiedAt })
  );
  console.log(`[SUCCESS] ${ts()} LLM registry listed | ${registry.length} entries | activeId: ${llmState.activeLlmId}`);
  return res.json({ registry, activeId: llmState.activeLlmId });
});

// ─── PUT /api/llm/active/:id ──────────────────────────────────────────────────
// Sets which registry entry is the active provider for chat (Phase 3).
router.put('/active/:id', (req, res) => {
  const { id } = req.params;
  if (!connectedLlmRegistry.has(id)) {
    return res.status(404).json({ error: `LLM entry "${id}" not found in registry` });
  }
  llmState.activeLlmId = id;
  const { provider, model } = connectedLlmRegistry.get(id);
  console.log(`[SUCCESS] ${ts()} Active LLM set | id: ${id} | provider: ${provider} | model: ${model}`);
  return res.json({ success: true, activeId: id });
});

// ─── DELETE /api/llm/:id ──────────────────────────────────────────────────────
// Removes an entry from the registry. Falls back to the last remaining entry.
router.delete('/:id', (req, res) => {
  const { id } = req.params;
  if (!connectedLlmRegistry.has(id)) {
    return res.status(404).json({ error: `LLM entry "${id}" not found` });
  }
  connectedLlmRegistry.delete(id);
  if (llmState.activeLlmId === id) {
    const remaining = Array.from(connectedLlmRegistry.keys());
    llmState.activeLlmId = remaining.length > 0 ? remaining[remaining.length - 1] : null;
  }
  console.log(`[SUCCESS] ${ts()} LLM registry entry deleted | id: ${id} | new activeId: ${llmState.activeLlmId}`);
  return res.json({ success: true, activeId: llmState.activeLlmId });
});

// ─── GET /api/llm/active ──────────────────────────────────────────────────────
// Returns the active entry metadata (no apiKey). Used by Phase 3 UI status.
router.get('/active', (_req, res) => {
  if (!llmState.activeLlmId || !connectedLlmRegistry.has(llmState.activeLlmId)) {
    return res.status(404).json({ error: 'No active LLM configured' });
  }
  const { id, provider, model, latency, verifiedAt } = connectedLlmRegistry.get(llmState.activeLlmId);
  console.log(`[SUCCESS] ${ts()} Active LLM retrieved | id: ${id} | provider: ${provider} | model: ${model}`);
  return res.json({ id, provider, model, latency, verifiedAt });
});

// ─── POST /api/llm/models ─────────────────────────────────────────────────────
// Body:    { provider, apiKey }
// Returns: { models: [{ label, value }] }
// Fetches the available models for cloud providers (gemini, openai, claude).
router.post('/models', async (req, res) => {
  const { provider, apiKey } = req.body;
  if (!provider || !apiKey) {
    return res.status(400).json({ error: 'provider and apiKey are required' });
  }
  console.log(`[INIT] ${ts()} Fetching models from provider API | provider: ${provider}`);
  try {
    let models = [];

    if (provider === 'gemini') {
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`
      );
      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({}));
        throw new Error(errData.error?.message ?? `HTTP ${resp.status}`);
      }
      const data = await resp.json();
      models = (data.models ?? [])
        .filter(m => (m.supportedGenerationMethods ?? []).includes('generateContent'))
        .map(m => ({
          label: m.displayName ?? m.name.split('/').pop(),
          value: m.name.split('/').pop(),
        }));

    } else if (provider === 'openai') {
      const OpenAI = (await import('openai')).default;
      const openai = new OpenAI({ apiKey });
      const modelsRes = await openai.models.list();
      models = (modelsRes.data ?? [])
        .filter(m => /^(gpt|o1|o3|o4|chatgpt)/.test(m.id))
        .sort((a, b) => b.created - a.created)
        .map(m => ({ label: m.id, value: m.id }));

    } else if (provider === 'claude') {
      const resp = await fetch('https://api.anthropic.com/v1/models', {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
      });
      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({}));
        throw new Error(errData.error?.message ?? `HTTP ${resp.status}`);
      }
      const data = await resp.json();
      models = (data.data ?? []).map(m => ({
        label: m.display_name ?? m.id,
        value: m.id,
      }));

    } else {
      return res.status(400).json({ error: `Model listing not supported for provider: ${provider}` });
    }

    console.log(`[SUCCESS] ${ts()} Models fetched | provider: ${provider} | ${models.length} model(s)`);
    return res.json({ models });
  } catch (err) {
    console.error(`[ERROR] ${ts()} Failed to fetch models | provider: ${provider} | ${err.message}`);
    return res.status(400).json({ error: err.message });
  }
});

// ─── GET /api/llm/ollama/models ───────────────────────────────────────────────
// Query: ?baseUrl=http://localhost:11434
// Returns the list of locally pulled models from Ollama.
router.get('/ollama/models', async (req, res) => {
  const baseUrl = ((req.query.baseUrl ?? 'http://localhost:11434')).replace(/\/$/, '');
  console.log(`[INIT] ${ts()} Fetching Ollama models | baseUrl: ${baseUrl}`);
  try {
    const resp = await fetch(`${baseUrl}/api/tags`);
    if (!resp.ok) throw new Error(`Ollama responded with HTTP ${resp.status}`);
    const data = await resp.json();
    const models = (data.models ?? []).map(m => ({ name: m.name, size: m.size }));
    console.log(`[SUCCESS] ${ts()} Ollama models fetched | ${models.length} model(s)`);
    return res.json({ models });
  } catch (err) {
    console.error(`[ERROR] ${ts()} Failed to fetch Ollama models | ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

export default router;
