import { Router } from 'express';
import { isAbsolute, join } from 'path';
import { connectedLlmRegistry } from './llm.routes.js';
import { activeClients } from './mcp.routes.js';
import { getOrCreateCache, truncateIfLarge } from './cache-manager.js';
import { mapProviderUsage } from './usage-normalizer.js';

const router = Router();
const ts = () => new Date(Date.now() + (5 * 60 + 30) * 60000).toISOString().replace('Z', '+05:30');
const PATH_KEY_PATTERN = /(path|file|dir|directory|folder|filename)$/i;
const PATH_TEXT_PATTERN = /(absolute path|relative path|file path|directory path|folder path|workspace path|file name|filename|directory|folder|path)/i;

// ─── In-memory chat session (Phase 3: single session) ─────────────────────────
// Format: [{ role: 'user' | 'assistant', content: string }]
const chatHistory = [];

// ─── Schema helpers ────────────────────────────────────────────────────────────

/** Convert JSON Schema type string to Gemini's uppercase schema type. */
function toGeminiType(jsType) {
  const map = {
    string: 'STRING', number: 'NUMBER', integer: 'INTEGER',
    boolean: 'BOOLEAN', array: 'ARRAY', object: 'OBJECT',
  };
  return map[(jsType || 'string').toLowerCase()] ?? 'STRING';
}

/** Recursively convert a JSON Schema object to Gemini FunctionDeclarationSchema. */
function toGeminiSchema(schema) {
  if (!schema) return { type: 'OBJECT', properties: {} };
  const out = { type: toGeminiType(schema.type) };
  if (schema.description) out.description = schema.description;
  if (schema.enum)        out.enum = schema.enum;
  if (schema.properties) {
    out.properties = {};
    for (const [k, v] of Object.entries(schema.properties)) {
      out.properties[k] = toGeminiSchema(v);
    }
  }
  if (schema.required) out.required = schema.required;
  if (schema.items)    out.items = toGeminiSchema(schema.items);
  return out;
}

/** Extract readable text from an MCP callTool result object.
 * Applies token-safety truncation if the output exceeds 10 000 chars. */
function extractToolText(result) {
  // MCP result: { content: [{ type: 'text', text: '...' }] }
  let text;
  if (Array.isArray(result?.content)) {
    text = result.content.map(c => c.text ?? JSON.stringify(c)).join('\n');
  } else {
    text = JSON.stringify(result ?? '');
  }
  return truncateIfLarge(text);
}

/** Race an async operation against an AbortSignal.
 * This prevents long-running provider calls from continuing app flow after client stop. */
function withAbort(promise, abortSignal) {
  if (!abortSignal) return promise;
  if (abortSignal.aborted) throw new Error('Request cancelled by client');

  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error('Request cancelled by client'));
    abortSignal.addEventListener('abort', onAbort, { once: true });

    promise.then(
      (value) => {
        abortSignal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        abortSignal.removeEventListener('abort', onAbort);
        reject(err);
      }
    );
  });
}

function isPathLikeSchemaProperty(key, schemaProperty) {
  const normalizedKey = (key ?? '').replace(/[_-]/g, '').toLowerCase();
  const descriptionText = [
    schemaProperty?.description,
    schemaProperty?.title,
  ].filter(Boolean).join(' ');
  const schemaType = schemaProperty?.type;

  if (schemaType && schemaType !== 'string') {
    return false;
  }

  if (normalizedKey === 'content') {
    return false;
  }

  return PATH_KEY_PATTERN.test(normalizedKey) || PATH_TEXT_PATTERN.test(descriptionText);
}

function getPathArgumentKeys(toolArgs, inputSchema) {
  const schemaProperties = inputSchema?.properties ?? {};
  const keys = new Set();

  for (const [key, schemaProperty] of Object.entries(schemaProperties)) {
    if (isPathLikeSchemaProperty(key, schemaProperty)) {
      keys.add(key);
    }
  }

  for (const [key, value] of Object.entries(toolArgs ?? {})) {
    if (typeof value !== 'string') continue;
    if (isPathLikeSchemaProperty(key, schemaProperties[key])) {
      keys.add(key);
    }
  }

  return [...keys];
}

function resolveWorkspacePathValue(pathValue, activeWorkspacePath) {
  console.log(`[INIT] ${ts()} resolveWorkspacePathValue()`);

  if (!activeWorkspacePath || typeof pathValue !== 'string') {
    console.log(`[SUCCESS] ${ts()} resolveWorkspacePathValue() | no rewrite`);
    return pathValue;
  }

  const trimmedPath = pathValue.trim();

  if (!trimmedPath || trimmedPath === '.' || trimmedPath === './') {
    console.log(`[SUCCESS] ${ts()} resolveWorkspacePathValue() | workspace root injected`);
    return activeWorkspacePath;
  }

  if (isAbsolute(trimmedPath)) {
    console.log(`[SUCCESS] ${ts()} resolveWorkspacePathValue() | absolute path preserved`);
    return trimmedPath;
  }

  const resolvedPath = join(activeWorkspacePath, trimmedPath);
  console.log(`[SUCCESS] ${ts()} resolveWorkspacePathValue() | resolved: "${resolvedPath}"`);
  return resolvedPath;
}

function resolveWorkspaceToolArgs(toolName, toolArgs, activeWorkspacePath, inputSchema) {
  console.log(`[INIT] ${ts()} resolveWorkspaceToolArgs() | tool: ${toolName}`);

  const finalArgs = { ...(toolArgs ?? {}) };

  if (!activeWorkspacePath) {
    console.log(`[SUCCESS] ${ts()} resolveWorkspaceToolArgs() | no active workspace`);
    return finalArgs;
  }

  const keysToResolve = getPathArgumentKeys(finalArgs, inputSchema);

  let didRewrite = false;

  for (const key of keysToResolve) {
    const nextValue = resolveWorkspacePathValue(finalArgs[key], activeWorkspacePath);
    if (nextValue !== undefined && nextValue !== finalArgs[key]) {
      finalArgs[key] = nextValue;
      didRewrite = true;
    }
  }

  console.log(
    `[SUCCESS] ${ts()} resolveWorkspaceToolArgs() | tool: ${toolName} | rewritten: ${didRewrite}`
  );
  return finalArgs;
}

// ─── Provider handlers ─────────────────────────────────────────────────────────

/**
 * Unified Gemini handler.
 * - Expert Mode  : pass systemContext, leave cacheName null.
 * - Project Mode : pass cacheName (system prompt is baked into the cache).
 */
async function handleGemini({ apiKey, model, message, history, toolDefs, executeTool, toolsUsed, systemContext, cacheName, abortSignal, ensureNotCancelled }) {
  const startMs = Date.now();
  console.log(`[INIT] ${ts()} handleGemini() | model: ${model} | cached: ${!!cacheName}`);

  const { GoogleGenAI } = await import('@google/genai');
  const ai = new GoogleGenAI({ apiKey });

  const functionDeclarations = toolDefs.map(t => ({
    name: t.name,
    description: t.description ?? '',
    parameters: toGeminiSchema(t.inputSchema),
  }));

  // ── Build request contents ────────────────────────────────────────────────
  const contents = [
    ...history.map(h => ({
      role: h.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: h.content }],
    })),
    { role: 'user', parts: [{ text: message }] },
  ];

  // ── Build generation config ───────────────────────────────────────────────
  const config = {};

  if (cacheName) {
    // Project Mode: system prompt is already inside the cache — do NOT repeat it
    config.cachedContent = cacheName;
  } else if (systemContext) {
    // Expert Mode: send system prompt directly
    config.systemInstruction = systemContext;
  }

  if (functionDeclarations.length > 0) {
    config.tools = [{ functionDeclarations }];
  }

  // ── Agentic tool loop ────────────────────────────────────────────────────────
  while (true) {
    ensureNotCancelled();
    const response = await withAbort(
      ai.models.generateContent({ model, contents, config }),
      abortSignal
    );
    ensureNotCancelled();
    const parts     = response.candidates?.[0]?.content?.parts ?? [];
    const funcCalls = parts.filter(p => p.functionCall);

    if (funcCalls.length === 0) {
      const text = parts.find(p => p.text)?.text ?? '';
      const latencyMs = Date.now() - startMs;
      const standardizedUsage = mapProviderUsage(response.usageMetadata, 'gemini', { model, latencyMs });
      console.log(`[SUCCESS] ${ts()} handleGemini() complete | latencyMs: ${latencyMs}`);
      return { text, standardizedUsage };
    }

    // Append model's tool-call turn and continue loop
    contents.push({ role: 'model', parts });

    const responseParts = [];
    for (const part of funcCalls) {
      ensureNotCancelled();
      const { name, args } = part.functionCall;
      toolsUsed.push(name);
      console.log(`[INIT] ${ts()} Gemini → tool: ${name} | args: ${JSON.stringify(args)}`);
      try {
        const raw    = await executeTool(name, args);
        const output = extractToolText(raw);
        responseParts.push({ functionResponse: { name, response: { output } } });
        console.log(`[SUCCESS] ${ts()} Tool "${name}" returned`);
      } catch (err) {
        responseParts.push({ functionResponse: { name, response: { error: err.message } } });
        console.log(`[ERROR] ${ts()} Tool "${name}" failed: ${err.message}`);
      }
    }

    contents.push({ role: 'user', parts: responseParts });
  }
}

async function handleOpenAI({ apiKey, model, message, history, toolDefs, executeTool, toolsUsed, systemContext, abortSignal, ensureNotCancelled }) {
  const startMs = Date.now();
  console.log(`[INIT] ${ts()} handleOpenAI() | model: ${model}`);
  const OpenAI = (await import('openai')).default;
  const openai = new OpenAI({ apiKey });

  const tools = toolDefs.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description ?? '',
      parameters: t.inputSchema ?? { type: 'object', properties: {} },
    },
  }));

  const messages = [
    ...(systemContext ? [{ role: 'system', content: systemContext }] : []),
    ...history.map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: message },
  ];

  ensureNotCancelled();
  let response = await openai.chat.completions.create({
    model,
    messages,
    ...(tools.length > 0 && { tools, tool_choice: 'auto' }),
  }, { signal: abortSignal });
  ensureNotCancelled();

  // ── Agentic tool loop ────────────────────────────────────────────────────────
  while (response.choices[0].finish_reason === 'tool_calls') {
    ensureNotCancelled();
    const assistantMsg = response.choices[0].message;
    messages.push(assistantMsg);

    for (const tc of assistantMsg.tool_calls) {
      ensureNotCancelled();
      toolsUsed.push(tc.function.name);
      console.log(`[INIT] ${ts()} OpenAI → tool: ${tc.function.name}`);
      let content;
      try {
        const args = JSON.parse(tc.function.arguments);
        const raw = await executeTool(tc.function.name, args);
        content = extractToolText(raw);
        console.log(`[SUCCESS] ${ts()} Tool "${tc.function.name}" returned`);
      } catch (err) {
        content = JSON.stringify({ error: err.message });
        console.log(`[ERROR] ${ts()} Tool "${tc.function.name}" failed: ${err.message}`);
      }
      messages.push({ role: 'tool', tool_call_id: tc.id, content });
    }

    response = await openai.chat.completions.create({
      model, messages, tools, tool_choice: 'auto',
    }, { signal: abortSignal });
    ensureNotCancelled();
  }

  const text = response.choices[0].message.content ?? '';
  const latencyMs = Date.now() - startMs;
  const standardizedUsage = mapProviderUsage(response.usage, 'openai', { model, latencyMs });
  console.log(`[SUCCESS] ${ts()} handleOpenAI() complete | latencyMs: ${latencyMs}`);
  return { text, standardizedUsage };
}

// ─────────────────────────────────────────────────────────────────────────────

async function handleClaude({ apiKey, model, message, history, toolDefs, executeTool, toolsUsed, systemContext, abortSignal, ensureNotCancelled }) {
  const startMs = Date.now();
  console.log(`[INIT] ${ts()} handleClaude() | model: ${model}`);
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const client = new Anthropic({ apiKey });

  const tools = toolDefs.map(t => ({
    name: t.name,
    description: t.description ?? '',
    input_schema: t.inputSchema ?? { type: 'object', properties: {} },
  }));

  const messages = [
    ...history.map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: message },
  ];

  ensureNotCancelled();
  let response = await client.messages.create({
    model,
    max_tokens: 4096,
    ...(systemContext && { system: systemContext }),
    ...(tools.length > 0 && { tools }),
    messages,
  }, { signal: abortSignal });
  ensureNotCancelled();

  // ── Agentic tool loop ────────────────────────────────────────────────────────
  while (response.stop_reason === 'tool_use') {
    ensureNotCancelled();
    const assistantContent = response.content;
    messages.push({ role: 'assistant', content: assistantContent });

    const toolResults = [];
    for (const block of assistantContent) {
      if (block.type !== 'tool_use') continue;
      ensureNotCancelled();
      toolsUsed.push(block.name);
      console.log(`[INIT] ${ts()} Claude → tool: ${block.name}`);
      let content;
      try {
        const raw = await executeTool(block.name, block.input);
        content = extractToolText(raw);
        console.log(`[SUCCESS] ${ts()} Tool "${block.name}" returned`);
      } catch (err) {
        content = JSON.stringify({ error: err.message });
        console.log(`[ERROR] ${ts()} Tool "${block.name}" failed: ${err.message}`);
      }
      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content });
    }

    messages.push({ role: 'user', content: toolResults });
    response = await client.messages.create({
      model, max_tokens: 4096, tools, messages,
    }, { signal: abortSignal });
    ensureNotCancelled();
  }

  const text = response.content.find(b => b.type === 'text')?.text ?? '';
  const latencyMs = Date.now() - startMs;
  const standardizedUsage = mapProviderUsage(response.usage, 'claude', { model, latencyMs });
  console.log(`[SUCCESS] ${ts()} handleClaude() complete | latencyMs: ${latencyMs}`);
  return { text, standardizedUsage };
}

// ─────────────────────────────────────────────────────────────────────────────

async function handleOllama({ baseUrl, model, message, history, toolDefs, executeTool, toolsUsed, systemContext, abortSignal, ensureNotCancelled }) {
  const startMs = Date.now();
  console.log(`[INIT] ${ts()} handleOllama() | model: ${model}`);
  const OpenAI = (await import('openai')).default;
  const openai = new OpenAI({
    baseURL: `${baseUrl ?? 'http://localhost:11434'}/v1`,
    apiKey: 'ollama',
  });

  const tools = toolDefs.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description ?? '',
      parameters: t.inputSchema ?? { type: 'object', properties: {} },
    },
  }));

  const messages = [
    ...(systemContext ? [{ role: 'system', content: systemContext }] : []),
    ...history.map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: message },
  ];

  ensureNotCancelled();
  let response = await openai.chat.completions.create({
    model,
    messages,
    ...(tools.length > 0 && { tools, tool_choice: 'auto' }),
  }, { signal: abortSignal });
  ensureNotCancelled();

  // ── Agentic tool loop ────────────────────────────────────────────────────────
  while (response.choices[0].finish_reason === 'tool_calls') {
    ensureNotCancelled();
    const assistantMsg = response.choices[0].message;
    messages.push(assistantMsg);

    for (const tc of assistantMsg.tool_calls) {
      ensureNotCancelled();
      toolsUsed.push(tc.function.name);
      console.log(`[INIT] ${ts()} Ollama → tool: ${tc.function.name}`);
      let content;
      try {
        const args = JSON.parse(tc.function.arguments);
        const raw = await executeTool(tc.function.name, args);
        content = extractToolText(raw);
        console.log(`[SUCCESS] ${ts()} Tool "${tc.function.name}" returned`);
      } catch (err) {
        content = JSON.stringify({ error: err.message });
        console.log(`[ERROR] ${ts()} Tool "${tc.function.name}" failed: ${err.message}`);
      }
      messages.push({ role: 'tool', tool_call_id: tc.id, content });
    }

    response = await openai.chat.completions.create({
      model, messages, tools, tool_choice: 'auto',
    }, { signal: abortSignal });
    ensureNotCancelled();
  }

  const text = response.choices[0].message.content ?? '';
  const latencyMs = Date.now() - startMs;
  const standardizedUsage = mapProviderUsage(response.usage, 'ollama', { model, latencyMs });
  console.log(`[SUCCESS] ${ts()} handleOllama() complete | latencyMs: ${latencyMs}`);
  return { text, standardizedUsage };
}

// ─────────────────────────────────────────────────────────────────────────────

async function handleLmStudio({ baseUrl, model, message, history, toolDefs, executeTool, toolsUsed, systemContext, abortSignal, ensureNotCancelled }) {
  const startMs = Date.now();
  console.log(`[INIT] ${ts()} handleLmStudio() | model: ${model}`);
  const OpenAI = (await import('openai')).default;
  const lmBase = (baseUrl ?? 'http://localhost:1234').replace(/\/$/, '');
  const openai = new OpenAI({ baseURL: `${lmBase}/v1`, apiKey: 'lm-studio' });

  const tools = toolDefs.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description ?? '',
      parameters: t.inputSchema ?? { type: 'object', properties: {} },
    },
  }));

  const messages = [
    ...(systemContext ? [{ role: 'system', content: systemContext }] : []),
    ...history.map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: message },
  ];

  const callLmStudio = async (payload) => {
    try {
      return await openai.chat.completions.create(payload, { signal: abortSignal });
    } catch (err) {
      const isRefused = err.cause?.code === 'ECONNREFUSED' || err.code === 'ECONNREFUSED';
      if (isRefused) throw new Error('LM Studio Server Not Found. Enable Developer Mode and Start Server in LM Studio.');
      throw err;
    }
  };

  ensureNotCancelled();
  let response = await callLmStudio({
    model,
    messages,
    ...(tools.length > 0 && { tools, tool_choice: 'auto' }),
  });
  ensureNotCancelled();

  // ── Agentic tool loop ────────────────────────────────────────────────────────
  while (response.choices[0].finish_reason === 'tool_calls') {
    ensureNotCancelled();
    const assistantMsg = response.choices[0].message;
    messages.push(assistantMsg);

    for (const tc of assistantMsg.tool_calls) {
      ensureNotCancelled();
      toolsUsed.push(tc.function.name);
      console.log(`[INIT] ${ts()} LMStudio → tool: ${tc.function.name}`);
      let content;
      try {
        const args = JSON.parse(tc.function.arguments);
        const raw = await executeTool(tc.function.name, args);
        content = extractToolText(raw);
        console.log(`[SUCCESS] ${ts()} Tool "${tc.function.name}" returned`);
      } catch (err) {
        content = JSON.stringify({ error: err.message });
        console.log(`[ERROR] ${ts()} Tool "${tc.function.name}" failed: ${err.message}`);
      }
      messages.push({ role: 'tool', tool_call_id: tc.id, content });
    }

    response = await callLmStudio({ model, messages, tools, tool_choice: 'auto' });
    ensureNotCancelled();
  }

  const text = response.choices[0].message.content ?? '';
  const latencyMs = Date.now() - startMs;
  // LM Studio appends a `stats` object alongside the standard `usage` field
  const stats = response.stats ?? null;
  const standardizedUsage = mapProviderUsage(response.usage, 'lmstudio', { model, latencyMs, stats });
  console.log(`[SUCCESS] ${ts()} handleLmStudio() complete | latencyMs: ${latencyMs}`);
  return { text, standardizedUsage };
}

// ─── POST /api/chat/send ──────────────────────────────────────────────────────
// Body: { message, providerId, activeTools, systemContext?, activeWorkspacePath? }
router.post('/send', async (req, res) => {
  const { message, providerId, activeTools, systemContext, activeWorkspacePath } = req.body;

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: '"message" (string) is required' });
  }
  if (!providerId) {
    return res.status(400).json({ error: '"providerId" is required' });
  }

  const llmConfig = connectedLlmRegistry.get(providerId);
  if (!llmConfig) {
    return res.status(404).json({ error: `Provider "${providerId}" not found in registry` });
  }

  const { provider, model, apiKey, baseUrl } = llmConfig;
  const abortController = new AbortController();
  let requestCancelled = false;

  const markCancelled = () => {
    if (requestCancelled) return;
    requestCancelled = true;
    abortController.abort();
    console.log(`[INIT] ${ts()} /chat/send cancelled by client disconnect`);
  };

  // Trigger cancellation only when client aborts or disconnects early.
  // NOTE: req "close" also fires on normal request completion, so do not use it here.
  const onAborted = () => markCancelled();
  const onResClose = () => {
    if (!res.writableEnded) markCancelled();
  };
  req.on('aborted', onAborted);
  res.on('close', onResClose);

  const ensureNotCancelled = () => {
    if (requestCancelled || abortController.signal.aborted) {
      throw new Error('Request cancelled by client');
    }
  };

  // ── Build tool definitions and executor lookup ────────────────────────────
  const toolLookup = {};   // toolName → { connectionId, tool }
  const toolDefs = [];

  for (const { connectionId, toolName } of (activeTools ?? [])) {
    const mcpEntry = activeClients.get(connectionId);
    if (!mcpEntry) continue;
    const tool = mcpEntry.tools.find(t => t.name === toolName);
    if (!tool) continue;
    toolLookup[toolName] = { connectionId, tool };
    toolDefs.push(tool);
  }

  const executeTool = async (toolName, toolArgs) => {
    ensureNotCancelled();
    const toolEntry = toolLookup[toolName];
    if (!toolEntry) throw new Error(`No MCP connection for tool "${toolName}"`);
    const { connectionId, tool } = toolEntry;
    const mcpEntry = activeClients.get(connectionId);
    if (!mcpEntry) throw new Error(`MCP connection "${connectionId}" is no longer active`);
    console.log('aaaaaaaaaaaaaaaaaaaaaa ', activeWorkspacePath);
    const finalArgs = resolveWorkspaceToolArgs(
      toolName,
      toolArgs,
      activeWorkspacePath,
      tool?.inputSchema
    );
    console.log('^^^^^^^^^^^^^^^^ ',finalArgs);
    const result = await withAbort(
      mcpEntry.client.callTool({ name: toolName, arguments: finalArgs }),
      abortController.signal
    );
    ensureNotCancelled();
    return result;
  };

  console.log(`[INIT] ${ts()} /chat/send | provider: ${provider} | model: ${model} | tools: ${toolDefs.length} | history: ${chatHistory.length}`);

  // ── 10-message sliding window (system_instruction is always in systemContext, not history) ──
  const windowedHistory = chatHistory.slice(-10);

  const toolsUsed  = [];
  const commonArgs = {
    apiKey,
    model,
    message,
    history: windowedHistory,
    toolDefs,
    executeTool,
    toolsUsed,
    systemContext: systemContext ?? '',
    abortSignal: abortController.signal,
    ensureNotCancelled,
  };

  try {
    let result;

    if (provider === 'gemini') {
      // ── Project Mode: attempt context cache ──────────────────────────────────
      let cacheName = null;
      if (activeWorkspacePath) {
        cacheName = await getOrCreateCache(apiKey, model, activeWorkspacePath, systemContext ?? '');
      }
      result = await handleGemini({ ...commonArgs, cacheName });
    }
    else if (provider === 'openai') result = await handleOpenAI(commonArgs);
    else if (provider === 'claude') result = await handleClaude(commonArgs);
    else if (provider === 'ollama') result = await handleOllama({ ...commonArgs, baseUrl });
    else if (provider === 'lmstudio') result = await handleLmStudio({ ...commonArgs, baseUrl });
    else return res.status(400).json({ error: `Unknown provider: "${provider}"` });

    const reply             = result.text;
    const standardizedUsage = result.standardizedUsage;

    // Persist to session history
    chatHistory.push({ role: 'user',      content: message });
    chatHistory.push({ role: 'assistant', content: reply, toolsUsed, standardizedUsage });

    console.log(`[SUCCESS] ${ts()} Chat complete | toolsUsed: [${toolsUsed.join(', ')}] | usage: ${JSON.stringify(standardizedUsage)}`);
    return res.json({ reply, toolsUsed, standardizedUsage });

  } catch (err) {
    if (requestCancelled || err.message === 'Request cancelled by client') {
      console.log(`[SUCCESS] ${ts()} Chat stopped by client`);
      return;
    }
    console.error(`[ERROR] ${ts()} Chat failed | ${err.message}`);
    return res.status(500).json({ error: err.message });
  } finally {
    req.off('aborted', onAborted);
    res.off('close', onResClose);
  }
});

// ─── GET /api/chat/history ────────────────────────────────────────────────────
router.get('/history', (_req, res) => {
  console.log(`[SUCCESS] ${ts()} Chat history retrieved | ${chatHistory.length} messages`);
  return res.json({ history: chatHistory });
});

// ─── DELETE /api/chat/history ─────────────────────────────────────────────────
router.delete('/history', (_req, res) => {
  chatHistory.length = 0;
  console.log(`[SUCCESS] ${ts()} Chat history cleared`);
  return res.json({ success: true });
});

export default router;
