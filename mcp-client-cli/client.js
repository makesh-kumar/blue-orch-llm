import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ts = () => new Date().toISOString();

// ─── Demo Runner ──────────────────────────────────────────────────────────────

async function runDemo() {
  console.log(`[CLIENT_START] ${ts()} BlueOrch-CLI starting`);

  // Transport spawns the MCP server as a child process over stdio
  // Note: ../mcp-server/server.js is the server entry point
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['../mcp-server/server.js'],
  });

  const client = new Client(
    { name: 'BlueOrch-CLI', version: '1.0.0' },
    { capabilities: {} }
  );

  try {
    // ── 1. Connect ─────────────────────────────────────────────────────────
    console.log(`[CLIENT_START] ${ts()} Connecting to MCP server via stdio...`);
    await client.connect(transport);
    console.log(`[SERVER_CONNECTED] ${ts()} Connected to MCP server successfully`);

    // ── 2. List available tools ────────────────────────────────────────────
    console.log(`\n[CLIENT_START] ${ts()} Calling listTools()...`);
    const { tools } = await client.listTools();
    console.log(`[TOOL_RESULT] ${ts()} ${tools.length} tool(s) available:`);
    tools.forEach(tool => {
      console.log(`  • ${tool.name} — ${tool.description}`);
    });

    // ── 3. get_product_catalog ─────────────────────────────────────────────
    console.log(`\n[CLIENT_START] ${ts()} Calling get_product_catalog...`);
    const catalogResult = await client.callTool({
      name: 'get_product_catalog',
      arguments: {},
    });
    console.log(`[TOOL_RESULT] ${ts()} get_product_catalog response:`);
    console.log(JSON.stringify(catalogResult, null, 2));

    // ── 4. calculate_order_total (includes one imported item) ──────────────
    // "Japanese Matcha Set" has isImported: true → triggers the $50 fee
    const testProducts = ['Wireless Headphones', 'Japanese Matcha Set', 'Running Shoes'];
    console.log(`\n[CLIENT_START] ${ts()} Calling calculate_order_total with: [${testProducts.join(', ')}]`);
    const orderResult = await client.callTool({
      name: 'calculate_order_total',
      arguments: { productNames: testProducts },
    });
    console.log(`[TOOL_RESULT] ${ts()} calculate_order_total response:`);
    console.log(JSON.stringify(orderResult, null, 2));

  } catch (err) {
    console.error(`[ERROR] ${ts()} Demo failed: ${err.message}`);
    process.exit(1);
  } finally {
    try {
      await client.close();
      console.log(`\n[CLIENT_START] ${ts()} Connection closed cleanly`);
    } catch (_) {
      // Suppress close errors — server process may have already exited
    }
  }

  process.exit(0);
}

runDemo();
