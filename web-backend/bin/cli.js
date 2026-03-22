#!/usr/bin/env node
/**
 * BlueOrch Studio — CLI entry point
 * Usage:  npx blueorch [--port 3000]
 *         blueorch --port 5000
 */

import { program } from 'commander';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import open from 'open';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const require    = createRequire(import.meta.url);
const pkg        = require(join(__dirname, '../package.json'));

const ts = () =>
  new Date(Date.now() + (5 * 60 + 30) * 60000).toISOString().replace('Z', '+05:30');

// ─── CLI definition ───────────────────────────────────────────────────────────
program
  .name('blueorch')
  .description(pkg.description)
  .version(pkg.version)
  .option('-p, --port <number>', 'Port to run the server on', '3000')
  .parse();

const { port: portStr } = program.opts();
const port = Number(portStr);

if (isNaN(port) || port < 1 || port > 65535) {
  console.error(`[ERROR] ${ts()} Invalid port: "${portStr}"`);
  process.exit(1);
}

// ─── Set env vars BEFORE importing server.js ─────────────────────────────────
// dotenv (loaded inside server.js) does not override existing env vars, so
// these CLI values win over any .env file values.
process.env.PORT     = String(port);
process.env.NODE_ENV = process.env.NODE_ENV || 'production';

console.log(`[INIT] ${ts()} BlueOrch Studio | port=${port} | NODE_ENV=${process.env.NODE_ENV}`);

// ─── Start the Express server ─────────────────────────────────────────────────
await import(join(__dirname, '../server.js'));

// ─── Open browser once server is healthy ─────────────────────────────────────
const appUrl = `http://localhost:${port}`;

const pollAndOpen = async (retries = 25) => {
  try {
    const res = await fetch(`${appUrl}/api/system/health`);
    if (res.ok) {
      console.log(`[SUCCESS] ${ts()} Server is up — opening ${appUrl}`);
      await open(appUrl);
    }
  } catch {
    if (retries > 0) {
      setTimeout(() => pollAndOpen(retries - 1), 400);
    } else {
      console.warn(`[WARN] ${ts()} Could not confirm server health — please open ${appUrl} manually`);
    }
  }
};

// Give the event-loop a tick for the server to bind its port before polling
setTimeout(() => pollAndOpen(), 600);
