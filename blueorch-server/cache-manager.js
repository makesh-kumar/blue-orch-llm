/**
 * cache-manager.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Gemini Context Cache Manager using @google/genai SDK.
 *
 * Responsibilities:
 *   • Build a compact "signature-only" workspace snapshot (file tree, no content)
 *   • Create / reuse Gemini cached contexts keyed by workspace path
 *   • Auto-delete expired caches every 10 minutes
 *   • Provide token-safety truncation for oversized tool outputs
 */

import { readdirSync } from 'fs';
import { join, extname } from 'path';

// ─── Constants ────────────────────────────────────────────────────────────────

const CACHE_TTL_SECONDS     = 3600;           // 1 hour
const MIN_CACHE_CHARS       = 4096 * 4;       // ~4 096 tokens × 4 chars/token
const TOKEN_TRUNCATION_LIMIT = 10_000;        // chars before truncation kicks in
const CLEANUP_INTERVAL_MS   = 10 * 60 * 1000; // 10 minutes

const CODE_EXTENSIONS = new Set([
  '.ts', '.js', '.mjs', '.jsx', '.tsx',
  '.py', '.java', '.go', '.rs', '.vue',
  '.css', '.scss', '.less',
  '.html', '.json', '.md', '.yaml', '.yml', '.toml',
]);

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.angular',
  '__pycache__', '.next', 'coverage', '.cache', 'vendor', 'out',
]);

const ts = () => new Date(Date.now() + (5 * 60 + 30) * 60000).toISOString().replace('Z', '+05:30');

// ─── Cache Store ──────────────────────────────────────────────────────────────
// Map: workspacePath → { cacheName: string, expiresAt: number, apiKey: string }

const cacheStore = new Map();

// ─── Workspace Snapshot ───────────────────────────────────────────────────────

/**
 * Build a compact signature-only directory tree showing file names only.
 * No file contents are read — keeps the cached context token-efficient.
 * Max depth prevents runaway recursion on deep mono-repos.
 *
 * @param {string} rootPath    Absolute workspace path
 * @param {number} [maxDepth=5]
 * @returns {string}           Formatted directory listing
 */
export function buildWorkspaceSnapshot(rootPath, maxDepth = 5) {
  console.log(`[INIT] ${ts()} buildWorkspaceSnapshot() | root: "${rootPath}"`);

  const lines = [`# Workspace: ${rootPath}`, ''];

  function walk(dir, depth, indent) {
    if (depth > maxDepth) { lines.push(`${indent}...`); return; }

    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch { return; }

    // Directories first, then alphabetical
    entries.sort((a, b) => {
      if (a.isDirectory() === b.isDirectory()) return a.name.localeCompare(b.name);
      return a.isDirectory() ? -1 : 1;
    });

    for (const e of entries) {
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name)) continue;
        lines.push(`${indent}${e.name}/`);
        walk(join(dir, e.name), depth + 1, indent + '  ');
      } else if (CODE_EXTENSIONS.has(extname(e.name))) {
        lines.push(`${indent}${e.name}`);
      }
    }
  }

  walk(rootPath, 0, '');

  const snapshot = lines.join('\n');
  console.log(`[SUCCESS] ${ts()} buildWorkspaceSnapshot() | ${lines.length} lines (~${Math.ceil(snapshot.length / 4)} tokens)`);
  return snapshot;
}

// ─── Token Safety Valve ───────────────────────────────────────────────────────

/**
 * Truncate text if it exceeds TOKEN_TRUNCATION_LIMIT characters.
 * Keeps the first 3 000 and last 3 000 chars; inserts a placeholder in the middle.
 * Prevents "token spikes" when an MCP tool reads a huge file.
 *
 * @param {string} text
 * @returns {string}
 */
export function truncateIfLarge(text) {
  if (!text || text.length <= TOKEN_TRUNCATION_LIMIT) return text;

  const keep    = 3000;
  const head    = text.slice(0, keep);
  const tail    = text.slice(-keep);
  const removed = text.length - keep * 2;

  console.log(`[INIT] ${ts()} truncateIfLarge: ${text.length} chars → truncated (${removed} chars removed)`);
  return `${head}\n\n[... TRUNCATED FOR OPTIMIZATION (${removed} chars removed) ...]\n\n${tail}`;
}

// ─── Auto-Cleanup ─────────────────────────────────────────────────────────────

async function runCleanup() {
  const now = Date.now();
  for (const [path, entry] of cacheStore.entries()) {
    if (entry.expiresAt > now) continue;

    console.log(`[INIT] ${ts()} CacheManager cleanup: deleting expired cache | path: "${path}"`);
    try {
      const { GoogleGenAI } = await import('@google/genai');
      const ai = new GoogleGenAI({ apiKey: entry.apiKey });
      await ai.caches.delete({ name: entry.cacheName });
      console.log(`[SUCCESS] ${ts()} CacheManager: deleted remote cache "${entry.cacheName}"`);
    } catch (err) {
      console.log(`[ERROR] ${ts()} CacheManager cleanup: remote delete failed | ${err.message}`);
    }
    cacheStore.delete(path);
  }
}

setInterval(runCleanup, CLEANUP_INTERVAL_MS);
console.log(`[INIT] ${ts()} CacheManager: auto-cleanup interval registered (every 10 min)`);

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Return a valid Gemini cacheName for the given workspace path.
 * Creates a new cache if none exists or the existing one has expired.
 * Returns null if the workspace snapshot is too small to be worth caching.
 *
 * @param {string} apiKey
 * @param {string} model          Gemini model ID (must support context caching)
 * @param {string} workspacePath  Absolute path of the active workspace
 * @param {string} systemContext  System instruction to bake into the cache
 * @returns {Promise<string|null>} cacheName or null
 */
export async function getOrCreateCache(apiKey, model, workspacePath, systemContext) {
  console.log(`[INIT] ${ts()} CacheManager.getOrCreateCache() | path: "${workspacePath}"`);

  // 1 ─ Return existing valid cache
  const existing = cacheStore.get(workspacePath);
  if (existing && existing.expiresAt > Date.now()) {
    console.log(`[SUCCESS] ${ts()} CacheManager: CACHE HIT | name: ${existing.cacheName}`);
    return existing.cacheName;
  }

  // 2 ─ Build compact workspace snapshot (signature-only: names, no content)
  const snapshot    = buildWorkspaceSnapshot(workspacePath);
  const contextText = `${systemContext}\n\n${snapshot}`;

  if (contextText.length < MIN_CACHE_CHARS) {
    console.log(`[SUCCESS] ${ts()} CacheManager: context too small (${contextText.length} chars) — skipping cache`);
    return null;
  }

  // 3 ─ Create remote cache via @google/genai SDK
  try {
    const { GoogleGenAI } = await import('@google/genai');
    const ai = new GoogleGenAI({ apiKey });

    const cache = await ai.caches.create({
      model,
      config: {
        systemInstruction: systemContext,
        contents: [{ role: 'user', parts: [{ text: snapshot }] }],
        ttl: `${CACHE_TTL_SECONDS}s`,
      },
    });

    const cacheName  = cache.name;
    const expiresAt  = Date.now() + CACHE_TTL_SECONDS * 1000;
    cacheStore.set(workspacePath, { cacheName, expiresAt, apiKey });

    console.log(`[SUCCESS] ${ts()} CacheManager: cache CREATED | name: ${cacheName}`);
    return cacheName;

  } catch (err) {
    console.log(`[ERROR] ${ts()} CacheManager.getOrCreateCache() failed: ${err.message}`);
    return null;
  }
}
