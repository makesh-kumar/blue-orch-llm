import { Router } from 'express';
import { homedir } from 'os';

const router = Router();
const ts = () => new Date().toISOString();

// ─── GET /api/system/env ──────────────────────────────────────────────────────
// Returns environment information for the current machine.
router.get('/env', (_req, res) => {
  const homeDir = homedir();
  console.log(`[SUCCESS] ${ts()} /system/env | homeDir: ${homeDir}`);
  return res.json({ homeDir });
});

export default router;
