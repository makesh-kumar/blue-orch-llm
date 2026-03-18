import express from 'express';
import cors from 'cors';
import { randomUUID } from 'crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const app = express();
const PORT = 3000;

// Allow requests from the Angular dev server
app.use(cors({ origin: 'http://localhost:4200' }));
app.use(express.json());

// ─── Active Clients Map ───────────────────────────────────────────────────────
// Key:   connectionId (UUID)
// Value: { client, tools, command, args, label, connectedAt }
const activeClients = new Map();

const ts = () => new Date().toISOString();

// ─── POST /api/connect ────────────────────────────────────────────────────────
// Body: { command: string, args: string[] }
// Spawns any MCP server process, connects via stdio, caches tools.
app.post('/api/connect', async (req, res) => {
  const { command, args } = req.body;

  if (!command || typeof command !== 'string') {
    return res.status(400).json({ error: '"command" (string) is required, e.g. "node" or "uvx"' });
  }
  if (!Array.isArray(args)) {
    return res.status(400).json({ error: '"args" (array of strings) is required' });
  }

  const connectionId = randomUUID();
  const label = args[0]
    ? `${command} ${args[0].split('/').pop()}`
    : command;

  console.log(`[INIT] ${ts()} Connecting | command: ${command} | args: ${args.join(' ')} | id: ${connectionId}`);

  // stderr: 'pipe' lets us capture the spawned server's own log output
  const transport = new StdioClientTransport({ command, args, stderr: 'pipe' });

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
      args,
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
    return res.json({ connectionId, label, command, args, tools });
  } catch (err) {
    console.error(`[ERROR] ${ts()} Connection failed: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/clients ─────────────────────────────────────────────────────────
// Returns a summary list of all active connections.
app.get('/api/clients', (_req, res) => {
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

// ─── GET /api/tools/:connectionId ─────────────────────────────────────────────
app.get('/api/tools/:connectionId', (req, res) => {
  const { connectionId } = req.params;
  const entry = activeClients.get(connectionId);

  if (!entry) {
    return res.status(404).json({ error: `Connection "${connectionId}" not found` });
  }

  console.log(`[SUCCESS] ${ts()} Tools for ${connectionId}: ${entry.tools.length}`);
  return res.json({ connectionId, tools: entry.tools });
});

// ─── POST /api/execute ────────────────────────────────────────────────────────
// Body: { connectionId, toolName, arguments }
app.post('/api/execute', async (req, res) => {
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

// ─── DELETE /api/disconnect/:connectionId ─────────────────────────────────────
app.delete('/api/disconnect/:connectionId', async (req, res) => {
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

// ─── GET /api/logs/:connectionId ─────────────────────────────────────────────
app.get('/api/logs/:connectionId', (req, res) => {
  const entry = activeClients.get(req.params.connectionId);
  if (!entry) return res.status(404).json({ error: 'Connection not found' });
  return res.json({ connectionId: req.params.connectionId, logs: entry.logs });
});

// ─── DELETE /api/logs/:connectionId/clear ─────────────────────────────────────
app.delete('/api/logs/:connectionId/clear', (req, res) => {
  const entry = activeClients.get(req.params.connectionId);
  if (!entry) return res.status(404).json({ error: 'Connection not found' });
  entry.logs.length = 0;
  console.log(`[SUCCESS] ${ts()} Logs cleared for ${req.params.connectionId}`);
  return res.json({ success: true });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[SUCCESS] ${ts()} BlueOrch Web Backend running on http://localhost:${PORT}`);
  console.log(`[INIT] ${ts()} Ready — accepts any { command, args[] } MCP server`);
});
