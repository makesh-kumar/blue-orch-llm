import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ts = () => new Date().toISOString();

// ─── SharedMCPClient ──────────────────────────────────────────────────────────
// Wraps the MCP SDK Client with a clean connect / getTools / callTool API.
// Exported as a singleton so all LLM providers share the same server connection.

class SharedMCPClient {
  constructor() {
    this._client = null;
    this._connected = false;
  }

  async connect() {
    console.log(`[INIT] ${ts()} SharedMCPClient connecting to ../mcp-server/server.js...`);

    // Spawns the MCP server as a child process; communication is over stdio
    const transport = new StdioClientTransport({
      command: 'node',
      args: ['../mcp-server/server.js'],
    });

    this._client = new Client(
      { name: 'BlueOrch-Studio-LLM-CLI', version: '1.0.0' },
      { capabilities: {} }
    );

    try {
      await this._client.connect(transport);
      this._connected = true;
      console.log(`[SUCCESS] ${ts()} SharedMCPClient connected to MCP server`);
    } catch (err) {
      console.error(`[ERROR] ${ts()} SharedMCPClient connection failed: ${err.message}`);
      throw err;
    }
  }

  // Returns the raw MCP tool array (JSON Schema format)
  async getTools() {
    console.log(`[INIT] ${ts()} Fetching tool list from MCP server...`);
    try {
      const { tools } = await this._client.listTools();
      console.log(`[SUCCESS] ${ts()} Fetched ${tools.length} tool(s) from MCP server`);
      return tools;
    } catch (err) {
      console.error(`[ERROR] ${ts()} Failed to fetch tools: ${err.message}`);
      throw err;
    }
  }

  // Calls a named tool with the given args object; returns the raw MCP response
  async callTool(name, args = {}) {
    console.log(`[INIT] ${ts()} Calling MCP tool "${name}" | args: ${JSON.stringify(args)}`);
    try {
      const result = await this._client.callTool({ name, arguments: args });
      console.log(`[SUCCESS] ${ts()} Tool "${name}" responded`);
      return result;
    } catch (err) {
      console.error(`[ERROR] ${ts()} Tool "${name}" failed: ${err.message}`);
      throw err;
    }
  }

  async disconnect() {
    if (this._client && this._connected) {
      try {
        await this._client.close();
        this._connected = false;
        console.log(`[SUCCESS] ${ts()} SharedMCPClient disconnected cleanly`);
      } catch (_) {
        // Suppress — server process may have already exited
      }
    }
  }
}

// Singleton — import this in any LLM provider file
export const mcpClient = new SharedMCPClient();
