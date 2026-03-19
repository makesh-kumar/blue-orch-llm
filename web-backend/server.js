import express from 'express';
import cors from 'cors';
import llmRouter from './llm.routes.js';
import mcpRouter from './mcp.routes.js';
import chatRouter from './chat.routes.js';

const app = express();
const PORT = 3000;

const ts = () => new Date().toISOString();

// Allow requests from the Angular dev server
app.use(cors({ origin: 'http://localhost:4200' }));
app.use(express.json());

// ─── Route modules ────────────────────────────────────────────────────────────
app.use('/api/llm', llmRouter);
app.use('/api/mcp', mcpRouter);
app.use('/api/chat', chatRouter);

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[INIT] ${ts()} BlueOrch backend ready on port ${PORT}`);
  console.log(`[INIT] ${ts()} Routes: /api/mcp/* | /api/llm/* | /api/chat/*`);
});
