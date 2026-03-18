import ollama from 'ollama';
import * as readline from 'readline';
import { mcpClient } from './mcp-common.js';

const ts = () => new Date().toISOString();

// Model preference: try llama3.2 first; override via OLLAMA_MODEL env var
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'llama3.2';

// ─── Schema Conversion ────────────────────────────────────────────────────────
// MCP tools use { name, description, inputSchema } (JSON Schema).
// Ollama uses the OpenAI-compatible tools format: { type, function: { name, description, parameters } }

function toOllamaTool(tool) {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema ?? { type: 'object', properties: {} },
    },
  };
}

// ─── Ollama Chat Session ──────────────────────────────────────────────────────

export async function startOllamaChat() {
  console.log(`[INIT] ${ts()} Starting Ollama chat session (model: ${OLLAMA_MODEL})...`);

  // ── 1. Connect MCP and fetch tools ─────────────────────────────────────────
  await mcpClient.connect();
  const mcpTools = await mcpClient.getTools();
  const ollamaTools = mcpTools.map(toOllamaTool);
  console.log(`[SUCCESS] ${ts()} Converted ${ollamaTools.length} tools to Ollama format`);

  // ── 2. Conversation history ─────────────────────────────────────────────────
  const messages = [
    {
      role: 'system',
      content:
        'You are BlueOrch, a helpful shopping assistant. ' +
        'Use the provided tools to answer questions about products, orders, and users accurately.',
    },
  ];

  // ── 3. Terminal input loop ──────────────────────────────────────────────────
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log('\n── Ollama + BlueOrch MCP ───────────────────────────────────────');
  console.log(`Model: ${OLLAMA_MODEL}  (set OLLAMA_MODEL env var to switch)`);
  console.log('Try asking: "What products are in stock?" or "Show bob@example.com\'s orders"');
  console.log('Type "exit" to quit.\n');

  const prompt = () => {
    rl.question('You: ', async (userInput) => {
      const input = userInput.trim();

      if (input.toLowerCase() === 'exit') {
        console.log(`[SUCCESS] ${ts()} Exiting Ollama chat`);
        rl.close();
        await mcpClient.disconnect();
        process.exit(0);
      }

      if (!input) { prompt(); return; }

      messages.push({ role: 'user', content: input });

      try {
        let response = await ollama.chat({
          model: OLLAMA_MODEL,
          messages,
          tools: ollamaTools,
        });

        // ── Tool call loop ───────────────────────────────────────────────────
        // Ollama (like OpenAI) may return tool_calls before giving a final reply
        while (response.message?.tool_calls?.length > 0) {
          // Add the assistant's tool-call message to history
          messages.push(response.message);

          for (const toolCall of response.message.tool_calls) {
            const { name, arguments: args } = toolCall.function;
            console.log(`[TOOL_RESULT] ${ts()} Ollama calling tool: "${name}"`);

            const toolResult = await mcpClient.callTool(name, args ?? {});
            const toolText = toolResult.content?.[0]?.text ?? JSON.stringify(toolResult);

            console.log(`[TOOL_RESULT] ${ts()} "${name}" result received`);

            // Append tool response to history so Ollama can synthesize the answer
            messages.push({ role: 'tool', content: toolText });
          }

          // Continue the conversation with tool results injected
          response = await ollama.chat({
            model: OLLAMA_MODEL,
            messages,
            tools: ollamaTools,
          });
        }

        const assistantText = response.message?.content ?? '(no response)';
        messages.push({ role: 'assistant', content: assistantText });
        console.log(`\nOllama: ${assistantText}\n`);
      } catch (err) {
        console.error(`[ERROR] ${ts()} Ollama error: ${err.message}`);
        // Pop the last user message on error to avoid polluting history
        messages.pop();
      }

      prompt();
    });
  };

  prompt();
}
