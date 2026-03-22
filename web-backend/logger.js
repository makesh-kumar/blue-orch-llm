import winston from 'winston';
import { EventEmitter } from 'events';
import { mkdirSync } from 'fs';

// Ensure logs directory exists
mkdirSync('./logs', { recursive: true });

const ts = () => new Date(Date.now() + (5 * 60 + 30) * 60000).toISOString().replace('Z', '+05:30');

// ─── SSE broadcast bus ────────────────────────────────────────────────────────
export const logBus = new EventEmitter();
logBus.setMaxListeners(200); // allow many concurrent SSE clients

// ─── In-memory ring buffer (last 300 entries) ──────────────────────────────────
const MAX_BUFFER = 300;
const logBuffer = [];

export const getRecentLogs = (limit = 200, level = null) => {
  let entries = logBuffer;
  if (level && level !== 'all') entries = entries.filter(e => e.level === level);
  return entries.slice(-Math.min(limit, MAX_BUFFER));
};

// ─── Custom transport: feeds the SSE bus + ring buffer ────────────────────────
class LiveTransport extends winston.Transport {
  constructor(opts) {
    super(opts);
    this.name = 'live';
  }

  log(info, callback) {
    const entry = {
      level:     info.level,
      message:   info.message,
      timestamp: info.timestamp ?? ts(),
    };
    logBuffer.push(entry);
    if (logBuffer.length > MAX_BUFFER) logBuffer.shift();
    logBus.emit('entry', entry);
    callback();
  }
}

// ─── Winston logger ────────────────────────────────────────────────────────────
export const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: () => new Date(Date.now() + (5 * 60 + 30) * 60000).toISOString().replace('Z', '+05:30') }),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    // File: errors only — max 2 MB, keep 3 rotated files
    new winston.transports.File({
      filename: './logs/error.log',
      level:    'error',
      maxsize:  2 * 1024 * 1024, // 2 MB
      maxFiles: 3,
      tailable: true,
    }),
    // File: all levels — max 5 MB, keep 3 rotated files
    new winston.transports.File({
      filename: './logs/combined.log',
      maxsize:  5 * 1024 * 1024, // 5 MB
      maxFiles: 3,
      tailable: true,
    }),
    // Console: colourised plain text
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      ),
    }),
    // Live SSE broadcast + ring buffer
    new LiveTransport(),
  ],
});

console.log(`[INIT] ${ts()} logger.js loaded | transports: file(error) + file(combined) + console + live`);
