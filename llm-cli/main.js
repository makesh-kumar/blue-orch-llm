// Load .env before anything else so GEMINI_API_KEY is available in sub-modules
import 'dotenv/config';
import { parseArgs } from 'util';

const ts = () => new Date().toISOString();

// ─── CLI Argument Parsing ─────────────────────────────────────────────────────
// Usage:
//   node main.js --model gemini
//   node main.js --model ollama
//   node main.js -m ollama
//   npm run gemini  /  npm run ollama

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    model: { type: 'string', short: 'm', default: 'gemini' },
  },
});

const model = values.model.toLowerCase();
console.log(`[INIT] ${ts()} BlueOrch LLM-CLI | model: ${model}`);

// ─── Dynamic Provider Import ───────────────────────────────────────────────────
if (model === 'gemini') {
  const { startGeminiChat } = await import('./gemini-chat.js');
  await startGeminiChat();
} else if (model === 'ollama') {
  const { startOllamaChat } = await import('./ollama-chat.js');
  await startOllamaChat();
} else {
  console.error(
    `[ERROR] ${ts()} Unknown model "${model}". ` +
    'Valid options: --model gemini | --model ollama'
  );
  process.exit(1);
}
