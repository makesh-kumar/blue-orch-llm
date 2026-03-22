import { Router } from 'express';
import { homedir } from 'os';
import { readdir, readFile, writeFile, mkdir } from 'fs/promises';
import { resolve, join } from 'path';

const router = Router();
const ts = () => new Date(Date.now() + (5 * 60 + 30) * 60000).toISOString().replace('Z', '+05:30');

// ─── GET /api/system/env ──────────────────────────────────────────────────────
// Returns environment information for the current machine.
router.get('/env', (_req, res) => {
  const homeDir = homedir();
  console.log(`[SUCCESS] ${ts()} /system/env | homeDir: ${homeDir}`);
  return res.json({ homeDir });
});

// ─── GET /api/system/files/tree ───────────────────────────────────────────────
// Returns ONE level of children for the given directory path.
// Query param: ?path=/absolute/path
// Lazy: the UI calls this once per expand click — never walks the full tree.
router.get('/files/tree', async (req, res) => {
  const rawPath = typeof req.query.path === 'string' ? req.query.path.trim() : '';
  if (!rawPath) {
    return res.status(400).json({ error: '?path query param is required' });
  }
  const safePath = resolve(rawPath);   // normalise + make absolute
  console.log(`[INIT] ${ts()} GET /files/tree | path: ${safePath}`);
  try {
    const entries = await readdir(safePath, { withFileTypes: true });
    const children = entries
      .filter(e => !e.name.startsWith('.'))     // hide dotfiles
      .map(e => ({
        name: e.name,
        type: e.isDirectory() ? 'directory' : 'file',
        path: join(safePath, e.name),
      }))
      .sort((a, b) => {
        if (a.type === b.type) return a.name.localeCompare(b.name);
        return a.type === 'directory' ? -1 : 1;   // dirs first
      });
    console.log(`[SUCCESS] ${ts()} GET /files/tree | ${children.length} entries at "${safePath}"`);
    return res.json({ children });
  } catch (err) {
    const status = err.code === 'ENOENT' ? 404 : err.code === 'EACCES' ? 403 : 500;
    console.error(`[ERROR] ${ts()} GET /files/tree | ${err.message}`);
    return res.status(status).json({ error: err.message });
  }
});

// ─── GET /api/system/files/read ──────────────────────────────────────────────
// Returns the text content of a single file.
// Query param: ?path=/absolute/path/to/file
// Capped at 2 MB to prevent accidental huge reads.
const MAX_BYTES = 2 * 1024 * 1024; // 2 MB
router.get('/files/read', async (req, res) => {
  const rawPath = typeof req.query.path === 'string' ? req.query.path.trim() : '';
  if (!rawPath) {
    return res.status(400).json({ error: '?path query param is required' });
  }
  const safePath = resolve(rawPath);
  console.log(`[INIT] ${ts()} GET /files/read | path: ${safePath}`);
  try {
    const buf = await readFile(safePath);
    if (buf.length > MAX_BYTES) {
      return res.status(413).json({ error: 'File too large to preview (>2 MB)' });
    }
    const content = buf.toString('utf8');
    console.log(`[SUCCESS] ${ts()} GET /files/read | ${buf.length} bytes at "${safePath}"`);
    return res.json({ content, path: safePath });
  } catch (err) {
    const status = err.code === 'ENOENT' ? 404 : err.code === 'EACCES' ? 403 : 500;
    console.error(`[ERROR] ${ts()} GET /files/read | ${err.message}`);
    return res.status(status).json({ error: err.message });
  }
});

// ─── PUT /api/system/files/write ─────────────────────────────────────────────
// Overwrites a file with new text content.
// Body: { path: string, content: string }
router.put('/files/write', async (req, res) => {
  const { path: rawPath, content } = req.body ?? {};
  if (!rawPath) return res.status(400).json({ error: 'path is required' });
  const safePath = resolve(rawPath);
  console.log(`[INIT] ${ts()} PUT /files/write | path: ${safePath}`);
  try {
    await writeFile(safePath, content ?? '', 'utf8');
    console.log(`[SUCCESS] ${ts()} PUT /files/write | ${(content ?? '').length} chars at "${safePath}"`);
    return res.json({ ok: true, path: safePath });
  } catch (err) {
    const status = err.code === 'ENOENT' ? 404 : err.code === 'EACCES' ? 403 : 500;
    console.error(`[ERROR] ${ts()} PUT /files/write | ${err.message}`);
    return res.status(status).json({ error: err.message });
  }
});

// ─── POST /api/system/files/create ───────────────────────────────────────────
// Creates a new empty file or directory.
// Body: { path: string, type: 'file' | 'directory' }
router.post('/files/create', async (req, res) => {
  const { path: rawPath, type = 'file' } = req.body ?? {};
  if (!rawPath) return res.status(400).json({ error: 'path is required' });
  const safePath = resolve(rawPath);
  console.log(`[INIT] ${ts()} POST /files/create | type: ${type}, path: ${safePath}`);
  try {
    if (type === 'directory') {
      await mkdir(safePath);
    } else {
      await writeFile(safePath, '', { flag: 'wx', encoding: 'utf8' }); // wx = fail if exists
    }
    console.log(`[SUCCESS] ${ts()} POST /files/create | created "${safePath}"`);
    return res.json({ ok: true, path: safePath });
  } catch (err) {
    const status = err.code === 'EEXIST' ? 409 : err.code === 'EACCES' ? 403 : 500;
    console.error(`[ERROR] ${ts()} POST /files/create | ${err.message}`);
    return res.status(status).json({ error: err.message });
  }
});

export default router;
