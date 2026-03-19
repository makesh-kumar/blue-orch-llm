import { Router } from 'express';
import { randomUUID } from 'crypto';
import { homedir } from 'os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const router = Router();

// ─── Active Clients Map ───────────────────────────────────────────────────────
// Key:   connectionId (UUID)
// Value: { client, transport, tools, command, args, label, logs, connectedAt }
// Exported so chat.routes.js can call tools on active connections.
export const activeClients = new Map();

const ts = () => new Date().toISOString();

// ─── POST /api/mcp/connect ────────────────────────────────────────────────────
// Body: { command: string, args: string[] }
router.post('/connect', async (req, res) => {
  const { command, args } = req.body;

  if (!command || typeof command !== 'string') {
    return res.status(400).json({ error: '"command" (string) is required, e.g. "node" or "uvx"' });
  }
  if (!Array.isArray(args)) {
    return res.status(400).json({ error: '"args" (array of strings) is required' });
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

  const label = resolvedArgs[0]
    ? `${command} ${resolvedArgs[0].split('/').pop()}`
    : command;

  console.log(`[INIT] ${ts()} Connecting | command: ${command} | args: ${args.join(' ')} | id: ${connectionId}`);

  const transport = new StdioClientTransport({ command, args: resolvedArgs, stderr: 'pipe' });

  const client = new Client(
    { name: 'BlueOrch-Web-Bridge', version: '1.0.0' },
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
      label,
      logs,
      connectedAt: new Date().toISOString(),
    });

    // Capture spawned server's stderr as log entries
    transport.stderr?.on('data', (chunk) => {
      const entry = activeClients.get(connectionId);
      if (!entry) return;
      chunk.toString().split('\n').forEach(line => {
        const trimmed = line.trim();
        if (trimmed) {
          entry.logs.push(`[SERVER] ${new Date().toISOString()} ${trimmed}`);
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

  const finalArgs = { ...(toolArgs ?? {}) };

  // Inject workspace path when tool operates on files and no explicit path given
  const PATH_TOOLS = ['list_directory', 'read_file'];
  if (PATH_TOOLS.includes(toolName)) {
    const p = (finalArgs.path ?? '').trim();
    if (!p || p === '.' || p === './') {
      finalArgs.path = activeWorkspacePath || homedir();
      console.log(`[INIT] ${ts()} Proxy path injected: "${finalArgs.path}" for tool "${toolName}"`);
    }
  }

  entry.logs.push(`[BRIDGE] ${ts()} Proxy tool: ${toolName} | args: ${JSON.stringify(finalArgs)}`);
  console.log(`[INIT] ${ts()} /mcp/proxy | tool: ${toolName} | connection: ${connectionId}`);

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
