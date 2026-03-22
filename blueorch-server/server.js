import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';

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
const PORT = Number(process.env.PORT) || 3000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const IS_PROD    = process.env.NODE_ENV === 'production';

const ts = () => new Date(Date.now() + (5 * 60 + 30) * 60000).toISOString().replace('Z', '+05:30');

// Allow requests from the Angular dev server
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());

// ─── Route modules ────────────────────────────────────────────────────────────
app.use('/api/llm',    llmRouter);
app.use('/api/mcp',    mcpRouter);
app.use('/api/chat',   chatRouter);
app.use('/api/system', systemRouter);
app.use('/api/logs',   logRouter);

// ─── Static UI (production / npx mode) ────────────────────────────────────────
if (IS_PROD) {
  const publicDir = join(__dirname, 'public/browser');
  if (existsSync(publicDir)) {
    console.log(`[INIT] ${ts()} Serving static UI from: ${publicDir}`);
    app.use(express.static(publicDir));
    // SPA catch-all — must be AFTER all API routes
    app.get('*', (_req, res) => res.sendFile(join(publicDir, 'index.html')));
  } else {
    console.warn(`[WARN] ${ts()} NODE_ENV=production but /public directory not found — UI not served. Run build:prod first.`);
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[INIT] ${ts()} BlueOrch Studio backend ready on port ${PORT}`);
  console.log(`[INIT] ${ts()} Routes: /api/mcp/* | /api/llm/* | /api/chat/* | /api/system/* | /api/logs/*`);
});
