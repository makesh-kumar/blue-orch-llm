import { GoogleGenerativeAI } from '@google/generative-ai';
import * as readline from 'readline';
import { mcpClient } from './mcp-common.js';

const ts = () => new Date().toISOString();

// ─── Schema Conversion ────────────────────────────────────────────────────────
// MCP tools use { name, description, inputSchema } (JSON Schema).
// Gemini expects { name, description, parameters } — just a key rename.

function toGeminiFunctionDeclaration(tool) {
  const { name, description, inputSchema } = tool;
  const decl = { name, description };
  // Only attach parameters if the tool accepts arguments
  if (inputSchema && Object.keys(inputSchema.properties ?? {}).length > 0) {
    decl.parameters = inputSchema;
  }
  return decl;
}

// ─── Gemini Chat Session ──────────────────────────────────────────────────────

export async function startGeminiChat() {
  console.log(`[INIT] ${ts()} Starting Gemini chat session...`);

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'your_gemini_api_key_here') {
    console.error(`[ERROR] ${ts()} GEMINI_API_KEY is not set. Edit llm-cli/.env and add your key.`);
    process.exit(1);
  }

  // ── 1. Connect MCP and fetch tools ─────────────────────────────────────────
  await mcpClient.connect();
  const mcpTools = await mcpClient.getTools();
  const functionDeclarations = mcpTools.map(toGeminiFunctionDeclaration);
  console.log(`[SUCCESS] ${ts()} Converted ${functionDeclarations.length} tools to Gemini function declarations`);

  // ── 2. Initialize Gemini model with tools ───────────────────────────────────
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.0-flash-lite',
    tools: [{ functionDeclarations }],
  });

  const chat = model.startChat({ history: [] });

  // ── 3. Terminal input loop ──────────────────────────────────────────────────
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log('\n── Gemini + BlueOrch MCP ───────────────────────────────────────');
  console.log('Try asking: "What products are in stock?" or "What is alice@example.com\'s order history?"');
  console.log('Type "exit" to quit.\n');

  const prompt = () => {
    rl.question('You: ', async (userInput) => {
      const input = userInput.trim();

      if (input.toLowerCase() === 'exit') {
        console.log(`[SUCCESS] ${ts()} Exiting Gemini chat`);
        rl.close();
        await mcpClient.disconnect();
        process.exit(0);
      }

      if (!input) { prompt(); return; }

      try {
        let result = await chat.sendMessage(input);
        let response = result.response;

        // ── Function calling loop ────────────────────────────────────────────
        // Gemini may request one or more tool calls before giving a final answer
        while (response.candidates?.[0]?.content?.parts?.some(p => p.functionCall)) {
          const parts = response.candidates[0].content.parts;
          const functionResponseParts = [];

          for (const part of parts) {
            if (!part.functionCall) continue;

            const { name, args } = part.functionCall;
            console.log(`[TOOL_RESULT] ${ts()} Gemini calling tool: "${name}"`);

            const toolResult = await mcpClient.callTool(name, args ?? {});
            // MCP returns content[0].text — use that as the function response
            const toolText = toolResult.content?.[0]?.text ?? JSON.stringify(toolResult);

            console.log(`[TOOL_RESULT] ${ts()} "${name}" result received`);

            functionResponseParts.push({
              functionResponse: { name, response: { result: toolText } },
            });
          }

          // Feed all tool results back to Gemini in a single message
          result = await chat.sendMessage(functionResponseParts);
          response = result.response;
        }

        const text = response.text();
        console.log(`\nGemini: ${text}\n`);
      } catch (err) {
        console.error(`[ERROR] ${ts()} Gemini error: ${err.message}`);
      }

      prompt();
    });
  };

  prompt();
}
