import express from 'express';
import cors from 'cors';

// ─── Logger must be imported first so console is overridden before routes load ─
import { logger } from './logger.js';

// Override console.* globally → all existing route console.log/error calls
// are automatically captured by Winston without touching any route file.
console.log   = (...args) => logger.info(args.map(String).join(' '));
console.error = (...args) => logger.error(args.map(String).join(' '));
console.warn  = (...args) => logger.warn(args.map(String).join(' '));

import llmRouter    from './llm.routes.js';
import mcpRouter    from './mcp.routes.js';
import chatRouter   from './chat.routes.js';
import systemRouter from './system.routes.js';
import logRouter    from './log.routes.js';

const app  = express();
const PORT = 3000;

const ts = () => new Date(Date.now() + (5 * 60 + 30) * 60000).toISOString().replace('Z', '+05:30');

// Allow requests from the Angular dev server
app.use(cors({ origin: 'http://localhost:4200' }));
app.use(express.json());

// ─── Route modules ────────────────────────────────────────────────────────────
app.use('/api/llm',    llmRouter);
app.use('/api/mcp',    mcpRouter);
app.use('/api/chat',   chatRouter);
app.use('/api/system', systemRouter);
app.use('/api/logs',   logRouter);

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[INIT] ${ts()} BlueOrch Studio backend ready on port ${PORT}`);
  console.log(`[INIT] ${ts()} Routes: /api/mcp/* | /api/llm/* | /api/chat/* | /api/system/* | /api/logs/*`);
});
