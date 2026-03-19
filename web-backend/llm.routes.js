import { Router } from 'express';
import { randomUUID } from 'crypto';

const router = Router();
const ts = () => new Date().toISOString();

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
// Body:    { provider: 'gemini'|'openai'|'claude', model: string, apiKey: string }
// Returns: { success: true, id, provider, model, latency, verifiedAt }
router.post('/verify', async (req, res) => {
  const { provider, model, apiKey } = req.body;

  if (!provider || !model || !apiKey) {
    return res.status(400).json({ error: 'provider, model, and apiKey are required' });
  }

  const start = Date.now();
  console.log(`[INIT] ${ts()} Verifying LLM | provider: ${provider} | model: ${model}`);

  try {
    if (provider === 'gemini') {
      const { GoogleGenerativeAI } = await import('@google/generative-ai');
      const genAI = new GoogleGenerativeAI(apiKey);
      const genModel = genAI.getGenerativeModel({ model });
      // countTokens is a lightweight read-only call — no output tokens charged
      await genModel.countTokens('ping');

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

    } else {
      return res.status(400).json({ error: `Unknown provider: "${provider}"` });
    }

    const latency = Date.now() - start;
    const id = randomUUID();
    const verifiedAt = new Date().toISOString();

    connectedLlmRegistry.set(id, { id, provider, model, apiKey, latency, verifiedAt });

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

export default router;
