import { Router } from 'express';
import { randomUUID } from 'crypto';
import { homedir } from 'os';
import { isAbsolute, join } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const router = Router();
// Matches both singular and plural path-like argument keys, e.g. "path", "paths", "file", "files"
const PATH_KEY_PATTERN = /(paths?|files?|dir|directory|folder|filename)$/i;
const PATH_TEXT_PATTERN = /(absolute path|relative path|file path|directory path|folder path|workspace path|file name|filename|directory|folder|path)/i;

// ─── Active Clients Map ───────────────────────────────────────────────────────
// Key:   connectionId (UUID)
// Value: { client, transport, tools, command, args, label, logs, connectedAt }
// Exported so chat.routes.js can call tools on active connections.
export const activeClients = new Map();

const ts = () => new Date(Date.now() + (5 * 60 + 30) * 60000).toISOString().replace('Z', '+05:30');

function isPathLikeSchemaProperty(key, schemaProperty) {
  const normalizedKey = (key ?? '').replace(/[_-]/g, '').toLowerCase();
  const descriptionText = [
    schemaProperty?.description,
    schemaProperty?.title,
  ].filter(Boolean).join(' ');
  const schemaType = schemaProperty?.type;

  if (schemaType && schemaType !== 'string') {
    return false;
  }

  if (normalizedKey === 'content') {
    return false;
  }

  return PATH_KEY_PATTERN.test(normalizedKey) || PATH_TEXT_PATTERN.test(descriptionText);
}

function getPathArgumentKeys(toolArgs, inputSchema) {
  const schemaProperties = inputSchema?.properties ?? {};
  const keys = new Set();

  for (const [key, schemaProperty] of Object.entries(schemaProperties)) {
    if (isPathLikeSchemaProperty(key, schemaProperty)) {
      keys.add(key);
    }
  }

  for (const [key, value] of Object.entries(toolArgs ?? {})) {
    const isStr = typeof value === 'string';
    // e.g. read_multiple_files sends { paths: ["file1.js", "file2.js"] }
    const isStrArr = Array.isArray(value) && value.length > 0 && typeof value[0] === 'string';
    if (!isStr && !isStrArr) continue;

    if (isStrArr) {
      // The MCP schema for array params says type:'array', which isPathLikeSchemaProperty
      // rejects. Bypass the type check and match solely on key name / description.
      const normalizedKey = (key ?? '').replace(/[_-]/g, '').toLowerCase();
      if (normalizedKey === 'content') continue;
      const sp = schemaProperties[key];
      const descText = [sp?.description, sp?.title].filter(Boolean).join(' ');
      if (PATH_KEY_PATTERN.test(normalizedKey) || PATH_TEXT_PATTERN.test(descText)) {
        keys.add(key);
      }
    } else if (isPathLikeSchemaProperty(key, schemaProperties[key])) {
      keys.add(key);
    }
  }

  return [...keys];
}

function resolveWorkspacePathValue(pathValue, activeWorkspacePath) {
  console.log(`[INIT] ${ts()} resolveWorkspacePathValue()`);

  if (!activeWorkspacePath || typeof pathValue !== 'string') {
    console.log(`[SUCCESS] ${ts()} resolveWorkspacePathValue() | no rewrite`);
    return pathValue;
  }

  const trimmedPath = pathValue.trim();

  if (!trimmedPath || trimmedPath === '.' || trimmedPath === './') {
    console.log(`[SUCCESS] ${ts()} resolveWorkspacePathValue() | workspace root injected`);
    return activeWorkspacePath;
  }

  if (isAbsolute(trimmedPath)) {
    console.log(`[SUCCESS] ${ts()} resolveWorkspacePathValue() | absolute path preserved`);
    return trimmedPath;
  }

  const resolvedPath = join(activeWorkspacePath, trimmedPath);
  console.log(`[SUCCESS] ${ts()} resolveWorkspacePathValue() | resolved: "${resolvedPath}"`);
  return resolvedPath;
}

function resolveWorkspaceToolArgs(toolName, toolArgs, activeWorkspacePath, inputSchema) {
  console.log(`[INIT] ${ts()} resolveWorkspaceToolArgs() | tool: ${toolName}`);

  const finalArgs = { ...(toolArgs ?? {}) };

  // Only resolve paths when an explicit workspace path is supplied.
  // Falling back to homedir() was causing relative paths to resolve against
  // the home directory instead of the user's active workspace.
  if (!activeWorkspacePath) {
    console.log(`[SUCCESS] ${ts()} resolveWorkspaceToolArgs() | no activeWorkspacePath — skipping resolution | tool: ${toolName}`);
    return finalArgs;
  }

  const keysToResolve = getPathArgumentKeys(finalArgs, inputSchema);

  let didRewrite = false;
  for (const key of keysToResolve) {
    const val = finalArgs[key];
    if (Array.isArray(val)) {
      // e.g. read_multiple_files: { paths: ["Chess Board/script.js", ...] }
      const resolvedArr = val.map(item =>
        typeof item === 'string' ? resolveWorkspacePathValue(item, activeWorkspacePath) : item
      );
      if (resolvedArr.some((v, i) => v !== val[i])) {
        finalArgs[key] = resolvedArr;
        didRewrite = true;
      }
    } else {
      const nextValue = resolveWorkspacePathValue(val, activeWorkspacePath);
      if (nextValue !== undefined && nextValue !== val) {
        finalArgs[key] = nextValue;
        didRewrite = true;
      }
    }
  }

  console.log(
    `[SUCCESS] ${ts()} resolveWorkspaceToolArgs() | tool: ${toolName} | rewritten: ${didRewrite}`
  );
  return finalArgs;
}

// ─── POST /api/mcp/connect ────────────────────────────────────────────────────
// Body: { command: string, args: string[], env?: Record<string, string> }
router.post('/connect', async (req, res) => {
  const { command, args, env } = req.body;

  if (!command || typeof command !== 'string') {
    return res.status(400).json({ error: '"command" (string) is required, e.g. "node" or "uvx"' });
  }
  if (!Array.isArray(args)) {
    return res.status(400).json({ error: '"args" (array of strings) is required' });
  }
  if (env !== undefined && (typeof env !== 'object' || Array.isArray(env))) {
    return res.status(400).json({ error: '"env" must be a plain object of string key-value pairs' });
  }

  const connectionId = randomUUID();

  // ── Default filesystem path to homedir when none is provided ────────────────
  // Detects: `npx -y @modelcontextprotocol/server-filesystem` with no trailing path
  let resolvedArgs = [...args];
  const fsIdx = args.findIndex(a => a.includes('server-filesystem'));
  if (fsIdx !== -1 && fsIdx === args.length - 1) {
    resolvedArgs = [...args, homedir()];
    console.log(`[INIT] ${ts()} Filesystem server: no path given — defaulting to ${homedir()}`);
  }

  // ── Derive a human-readable label from command + args ─────────────────────
  // Skip flag args (-y, --flag) to find the actual package/script name.
  // For scoped npm packages (@scope/name) keep "scope/name" so context isn't lost.
  // For plain path-like args (/usr/local/bin/tool) use only the last segment.
  const pkgArg = resolvedArgs.find(a => !a.startsWith('-'));
  let label = pkgArg ?? command;
  if (label.startsWith('@')) {
    label = label.slice(1);                 // "@playwright/mcp" → "playwright/mcp"
  } else if (label.includes('/')) {
    label = label.split('/').pop();         // plain path → last segment only
  }

  // ── Merge caller-supplied env with the current process env ──────────────
  // Keeping process.env ensures PATH and system vars are available to the child.
  const mergedEnv = (env && Object.keys(env).length > 0)
    ? { ...process.env, ...env }
    : undefined;

  console.log(`[INIT] ${ts()} Connecting | command: ${command} | args: ${args.join(' ')} | id: ${connectionId} | extraEnvKeys: ${env ? Object.keys(env).join(',') : 'none'}`);

  const transportOptions = { command, args: resolvedArgs, stderr: 'pipe' };
  if (mergedEnv) transportOptions.env = mergedEnv;

  const transport = new StdioClientTransport(transportOptions);

  const client = new Client(
    { name: 'BlueOrch-Studio-Web-Bridge', version: '1.0.0' },
    { capabilities: {} }
  );

  try {
    await client.connect(transport);
    const { tools } = await client.listTools();

    const logs = [`[BRIDGE] ${ts()} Connected — ${tools.length} tool(s) available`];

    activeClients.set(connectionId, {
      client,
      transport,
      tools,
      command,
      args: resolvedArgs,
      env: env ?? {},
      label,
      logs,
      connectedAt: ts(),
    });

    // Capture spawned server's stderr as log entries
    transport.stderr?.on('data', (chunk) => {
      const entry = activeClients.get(connectionId);
      if (!entry) return;
      chunk.toString().split('\n').forEach(line => {
        const trimmed = line.trim();
        if (trimmed) {
          entry.logs.push(`[SERVER] ${ts()} ${trimmed}`);
          if (entry.logs.length > 300) entry.logs.shift();
        }
      });
    });

    console.log(`[SUCCESS] ${ts()} Connected | id: ${connectionId} | tools: ${tools.length}`);
    return res.json({ connectionId, label, command, args: resolvedArgs, tools });
  } catch (err) {
    console.error(`[ERROR] ${ts()} Connection failed: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/mcp/clients ─────────────────────────────────────────────────────
router.get('/clients', (_req, res) => {
  const clientList = Array.from(activeClients.entries()).map(([id, entry]) => ({
    connectionId: id,
    label: entry.label,
    command: entry.command,
    args: entry.args,
    env: entry.env ?? {},
    toolCount: entry.tools.length,
    connectedAt: entry.connectedAt,
  }));

  console.log(`[SUCCESS] ${ts()} Listing ${clientList.length} active client(s)`);
  return res.json(clientList);
});

// ─── GET /api/mcp/tools/:connectionId ────────────────────────────────────────
router.get('/tools/:connectionId', (req, res) => {
  const { connectionId } = req.params;
  const entry = activeClients.get(connectionId);

  if (!entry) {
    return res.status(404).json({ error: `Connection "${connectionId}" not found` });
  }

  console.log(`[SUCCESS] ${ts()} Tools for ${connectionId}: ${entry.tools.length}`);
  return res.json({ connectionId, tools: entry.tools });
});

// ─── POST /api/mcp/execute ────────────────────────────────────────────────────
// Body: { connectionId, toolName, arguments }
router.post('/execute', async (req, res) => {
  const { connectionId, toolName, arguments: toolArgs } = req.body;

  if (!connectionId || !toolName) {
    return res.status(400).json({ error: 'connectionId and toolName are required' });
  }

  const entry = activeClients.get(connectionId);
  if (!entry) {
    return res.status(404).json({ error: `Connection "${connectionId}" not found` });
  }

  console.log(`[INIT] ${ts()} Executing tool "${toolName}" on ${connectionId}`);
  entry.logs.push(`[BRIDGE] ${ts()} Tool called: ${toolName} | args: ${JSON.stringify(toolArgs ?? {})}`);

  try {
    const result = await entry.client.callTool({
      name: toolName,
      arguments: toolArgs ?? {},
    });

    entry.logs.push(`[BRIDGE] ${ts()} Tool "${toolName}" completed successfully`);
    if (entry.logs.length > 300) entry.logs.shift();
    console.log(`[SUCCESS] ${ts()} Tool "${toolName}" completed`);
    return res.json({ connectionId, toolName, result });
  } catch (err) {
    entry.logs.push(`[ERROR] ${ts()} Tool "${toolName}" failed: ${err.message}`);
    console.error(`[ERROR] ${ts()} Tool "${toolName}" failed: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /api/mcp/disconnect/:connectionId ─────────────────────────────────
router.delete('/disconnect/:connectionId', async (req, res) => {
  const { connectionId } = req.params;
  const entry = activeClients.get(connectionId);

  if (!entry) {
    return res.status(404).json({ error: `Connection "${connectionId}" not found` });
  }

  try {
    await entry.client.close();
  } catch (_) {
    // Suppress — the spawned process may have already exited
  }

  activeClients.delete(connectionId);
  console.log(`[SUCCESS] ${ts()} Disconnected ${connectionId}`);
  return res.json({ success: true, connectionId });
});

// ─── GET /api/mcp/logs/:connectionId ──────────────────────────────────────────
router.get('/logs/:connectionId', (req, res) => {
  const entry = activeClients.get(req.params.connectionId);
  if (!entry) return res.status(404).json({ error: 'Connection not found' });
  return res.json({ connectionId: req.params.connectionId, logs: entry.logs });
});

// ─── DELETE /api/mcp/logs/:connectionId/clear ────────────────────────────────────────
router.delete('/logs/:connectionId/clear', (req, res) => {
  const entry = activeClients.get(req.params.connectionId);
  if (!entry) return res.status(404).json({ error: 'Connection not found' });
  entry.logs.length = 0;
  console.log(`[SUCCESS] ${ts()} Logs cleared for ${req.params.connectionId}`);
  return res.json({ success: true });
});

// ─── POST /api/mcp/proxy ────────────────────────────────────────────────────────────
// Body: { connectionId, toolName, toolArgs, activeWorkspacePath }
// Intercepts list_directory / read_file calls and injects activeWorkspacePath
// when the supplied path is empty or refers to the current directory.
router.post('/proxy', async (req, res) => {
  const { connectionId, toolName, toolArgs, activeWorkspacePath } = req.body;

  if (!connectionId || !toolName) {
    return res.status(400).json({ error: 'connectionId and toolName are required' });
  }

  const entry = activeClients.get(connectionId);
  if (!entry) {
    return res.status(404).json({ error: `Connection "${connectionId}" not found` });
  }

  const tool = entry.tools.find(t => t.name === toolName);
  const finalArgs = resolveWorkspaceToolArgs(toolName, toolArgs, activeWorkspacePath, tool?.inputSchema);
  entry.logs.push(`[BRIDGE] ${ts()} Proxy tool: ${toolName} | workspace: ${activeWorkspacePath ?? 'unset'} | args: ${JSON.stringify(finalArgs)}`);
  console.log(`[INIT] ${ts()} /mcp/proxy | tool: ${toolName} | workspace: ${activeWorkspacePath ?? 'unset'} | connection: ${connectionId}`);

  try {
    const result = await entry.client.callTool({ name: toolName, arguments: finalArgs });
    entry.logs.push(`[BRIDGE] ${ts()} Proxy tool "${toolName}" completed`);
    console.log(`[SUCCESS] ${ts()} Proxy tool "${toolName}" completed`);
    return res.json({ connectionId, toolName, result });
  } catch (err) {
    entry.logs.push(`[ERROR] ${ts()} Proxy tool "${toolName}" failed: ${err.message}`);
    console.error(`[ERROR] ${ts()} Proxy tool "${toolName}" failed: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

export default router;
