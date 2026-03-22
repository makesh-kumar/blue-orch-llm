import { Router } from 'express';
import { logBus, getRecentLogs } from './logger.js';

const router = Router();
const ts = () => new Date(Date.now() + (5 * 60 + 30) * 60000).toISOString().replace('Z', '+05:30');

// ─── GET /api/logs ─────────────────────────────────────────────────────────────
// Query params: ?limit=200  ?level=info|error|warn|all
router.get('/', (req, res) => {
  const limit = parseInt(req.query.limit) || 200;
  const level = req.query.level   || 'all';
  const logs  = getRecentLogs(limit, level);
  return res.json({ logs, total: logs.length });
});

// ─── GET /api/logs/stream ──────────────────────────────────────────────────────
// Server-Sent Events (SSE) — pushes each new log entry in real-time.
// Clients connect once and receive a stream; connection stays open.
router.get('/stream', (req, res) => {
  // SSE headers
  res.setHeader('Content-Type',      'text/event-stream');
  res.setHeader('Cache-Control',     'no-cache');
  res.setHeader('Connection',        'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // nginx compat
  res.flushHeaders();

  const onEntry = (entry) => {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  };

  logBus.on('entry', onEntry);

  // Keep-alive heartbeat every 20s (prevents proxy timeouts)
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 20_000);

  req.on('close', () => {
    logBus.off('entry', onEntry);
    clearInterval(heartbeat);
  });
});

export default router;
