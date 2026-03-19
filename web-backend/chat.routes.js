import { Router } from 'express';
import { connectedLlmRegistry } from './llm.routes.js';
import { activeClients } from './mcp.routes.js';

const router = Router();
const ts = () => new Date().toISOString();

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

/** Extract readable text from an MCP callTool result object. */
function extractToolText(result) {
  // MCP result: { content: [{ type: 'text', text: '...' }] }
  if (Array.isArray(result?.content)) {
    return result.content.map(c => c.text ?? JSON.stringify(c)).join('\n');
  }
  return JSON.stringify(result ?? '');
}

// ─── Provider handlers ─────────────────────────────────────────────────────────

async function handleGemini({ apiKey, model, message, history, toolDefs, executeTool, toolsUsed }) {
  const { GoogleGenerativeAI } = await import('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(apiKey);

  const functionDeclarations = toolDefs.map(t => ({
    name: t.name,
    description: t.description ?? '',
    parameters: toGeminiSchema(t.inputSchema),
  }));

  const genModel = genAI.getGenerativeModel({
    model,
    ...(functionDeclarations.length > 0 && { tools: [{ functionDeclarations }] }),
  });

  // Gemini uses role 'model' for assistant turns
  const geminiHistory = history.map(h => ({
    role: h.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: h.content }],
  }));

  const chat = genModel.startChat({ history: geminiHistory });
  let result = await chat.sendMessage(message);
  let response = result.response;

  // ── Agentic tool loop ────────────────────────────────────────────────────────
  while (true) {
    const calls = response.functionCalls?.() ?? [];
    if (calls.length === 0) break;

    const responseParts = [];
    for (const fc of calls) {
      toolsUsed.push(fc.name);
      console.log(`[INIT] ${ts()} Gemini → tool: ${fc.name} | args: ${JSON.stringify(fc.args)}`);
      try {
        const raw = await executeTool(fc.name, fc.args);
        const output = extractToolText(raw);
        responseParts.push({ functionResponse: { name: fc.name, response: { output } } });
        console.log(`[SUCCESS] ${ts()} Tool "${fc.name}" returned`);
      } catch (err) {
        responseParts.push({ functionResponse: { name: fc.name, response: { error: err.message } } });
        console.log(`[ERROR] ${ts()} Tool "${fc.name}" failed: ${err.message}`);
      }
    }

    result = await chat.sendMessage(responseParts);
    response = result.response;
  }

  return response.text();
}

// ─────────────────────────────────────────────────────────────────────────────

async function handleOpenAI({ apiKey, model, message, history, toolDefs, executeTool, toolsUsed }) {
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
    ...history.map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: message },
  ];

  let response = await openai.chat.completions.create({
    model,
    messages,
    ...(tools.length > 0 && { tools, tool_choice: 'auto' }),
  });

  // ── Agentic tool loop ────────────────────────────────────────────────────────
  while (response.choices[0].finish_reason === 'tool_calls') {
    const assistantMsg = response.choices[0].message;
    messages.push(assistantMsg);

    for (const tc of assistantMsg.tool_calls) {
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
    });
  }

  return response.choices[0].message.content ?? '';
}

// ─────────────────────────────────────────────────────────────────────────────

async function handleClaude({ apiKey, model, message, history, toolDefs, executeTool, toolsUsed }) {
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

  let response = await client.messages.create({
    model,
    max_tokens: 4096,
    ...(tools.length > 0 && { tools }),
    messages,
  });

  // ── Agentic tool loop ────────────────────────────────────────────────────────
  while (response.stop_reason === 'tool_use') {
    const assistantContent = response.content;
    messages.push({ role: 'assistant', content: assistantContent });

    const toolResults = [];
    for (const block of assistantContent) {
      if (block.type !== 'tool_use') continue;
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
    });
  }

  return response.content.find(b => b.type === 'text')?.text ?? '';
}

// ─────────────────────────────────────────────────────────────────────────────

async function handleOllama({ baseUrl, model, message, history, toolDefs, executeTool, toolsUsed }) {
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
    ...history.map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: message },
  ];

  let response = await openai.chat.completions.create({
    model,
    messages,
    ...(tools.length > 0 && { tools, tool_choice: 'auto' }),
  });

  // ── Agentic tool loop ────────────────────────────────────────────────────────
  while (response.choices[0].finish_reason === 'tool_calls') {
    const assistantMsg = response.choices[0].message;
    messages.push(assistantMsg);

    for (const tc of assistantMsg.tool_calls) {
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
    });
  }

  return response.choices[0].message.content ?? '';
}

// ─── POST /api/chat/send ──────────────────────────────────────────────────────
// Body: { message, providerId, activeTools: [{ connectionId, toolName }] }
router.post('/send', async (req, res) => {
  const { message, providerId, activeTools } = req.body;

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

  // ── Build tool definitions and executor lookup ────────────────────────────
  const toolLookup = {};   // toolName → connectionId
  const toolDefs = [];

  for (const { connectionId, toolName } of (activeTools ?? [])) {
    const mcpEntry = activeClients.get(connectionId);
    if (!mcpEntry) continue;
    const tool = mcpEntry.tools.find(t => t.name === toolName);
    if (!tool) continue;
    toolLookup[toolName] = connectionId;
    toolDefs.push(tool);
  }

  const executeTool = async (toolName, toolArgs) => {
    const connectionId = toolLookup[toolName];
    if (!connectionId) throw new Error(`No MCP connection for tool "${toolName}"`);
    const mcpEntry = activeClients.get(connectionId);
    if (!mcpEntry) throw new Error(`MCP connection "${connectionId}" is no longer active`);
    return mcpEntry.client.callTool({ name: toolName, arguments: toolArgs ?? {} });
  };

  console.log(`[INIT] ${ts()} /chat/send | provider: ${provider} | model: ${model} | tools: ${toolDefs.length} | history: ${chatHistory.length}`);

  const toolsUsed = [];
  const commonArgs = { apiKey, model, message, history: [...chatHistory], toolDefs, executeTool, toolsUsed };

  try {
    let reply = '';
    if      (provider === 'gemini') reply = await handleGemini(commonArgs);
    else if (provider === 'openai') reply = await handleOpenAI(commonArgs);
    else if (provider === 'claude') reply = await handleClaude(commonArgs);
    else if (provider === 'ollama') reply = await handleOllama({ ...commonArgs, baseUrl });
    else return res.status(400).json({ error: `Unknown provider: "${provider}"` });

    // Persist to session history
    chatHistory.push({ role: 'user',      content: message });
    chatHistory.push({ role: 'assistant', content: reply });

    console.log(`[SUCCESS] ${ts()} Chat complete | toolsUsed: [${toolsUsed.join(', ')}]`);
    return res.json({ reply, toolsUsed });

  } catch (err) {
    console.error(`[ERROR] ${ts()} Chat failed | ${err.message}`);
    return res.status(500).json({ error: err.message });
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
