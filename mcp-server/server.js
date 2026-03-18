import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFile, writeFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_PATH = join(__dirname, 'data.json');

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function readData() {
  const raw = await readFile(DATA_PATH, 'utf-8');
  return JSON.parse(raw);
}

async function writeData(data) {
  await writeFile(DATA_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

// ─── Tool Handlers ─────────────────────────────────────────────────────────────

async function getProductCatalog() {
  const ts = new Date().toISOString();
  console.log(`[TOOL_CALL] ${ts} get_product_catalog called`);
  const data = await readData();
  console.log(`[SUCCESS] ${ts} Returning ${data.products.length} products`);
  return data.products;
}

async function processReturn({ orderId }) {
  const ts = new Date().toISOString();
  console.log(`[TOOL_CALL] ${ts} process_return called | orderId: ${orderId}`);

  const data = await readData();
  const order = data.orders.find(o => o.orderId === orderId);

  if (!order) {
    throw new Error(`Order "${orderId}" not found`);
  }

  order.status = 'Returned';

  order.productIds.forEach(pid => {
    const product = data.products.find(p => p.productId === pid);
    if (product) {
      product.stockLevel += 1;
    }
  });

  await writeData(data);
  console.log(`[SUCCESS] ${ts} Order ${orderId} set to Returned; stock incremented for: ${order.productIds.join(', ')}`);

  return {
    orderId,
    newStatus: 'Returned',
    productsRestocked: order.productIds,
  };
}

async function calculateOrderTotal({ productNames }) {
  const ts = new Date().toISOString();
  console.log(`[TOOL_CALL] ${ts} calculate_order_total called | products: ${productNames.join(', ')}`);

  const data = await readData();
  let subtotal = 0;
  let hasImported = false;
  const notFound = [];

  productNames.forEach(name => {
    const product = data.products.find(
      p => p.name.toLowerCase() === name.toLowerCase()
    );
    if (!product) {
      notFound.push(name);
    } else {
      subtotal += product.price;
      if (product.isImported) hasImported = true;
    }
  });

  if (notFound.length > 0) {
    throw new Error(`Product(s) not found: ${notFound.join(', ')}`);
  }

  const internationalShippingFee = hasImported ? 50 : 0;
  const total = subtotal + internationalShippingFee;

  console.log(`[SUCCESS] ${ts} Total: $${total} (subtotal: $${subtotal}, shipping: $${internationalShippingFee})`);

  return { subtotal, internationalShippingFee, total };
}

async function getUserDashboard({ email }) {
  const ts = new Date().toISOString();
  console.log(`[TOOL_CALL] ${ts} get_user_dashboard called | email: ${email}`);

  const data = await readData();
  const user = data.users.find(
    u => u.email.toLowerCase() === email.toLowerCase()
  );

  if (!user) {
    throw new Error(`No user found with email "${email}"`);
  }

  const userOrders = data.orders.filter(o => o.userId === user.userId);
  let lifetimeSpend = 0;

  const enrichedOrders = userOrders.map(order => {
    const products = order.productIds
      .map(pid => data.products.find(p => p.productId === pid))
      .filter(Boolean);

    const orderTotal = products.reduce((sum, p) => sum + p.price, 0);

    // Returned orders do not count toward lifetime spend
    if (order.status !== 'Returned') {
      lifetimeSpend += orderTotal;
    }

    return {
      orderId: order.orderId,
      status: order.status,
      products: products.map(p => p.name),
      orderTotal,
    };
  });

  console.log(`[SUCCESS] ${ts} Dashboard for ${user.name} | orders: ${userOrders.length} | lifetime spend: $${lifetimeSpend}`);

  return { user, orders: enrichedOrders, lifetimeSpend };
}

// ─── Server Setup ──────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'blueorch-mcp-server', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'get_product_catalog',
      description: 'Returns the full product catalog with all products and their details.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'process_return',
      description: 'Marks an order as Returned and increments the stockLevel for each product in that order.',
      inputSchema: {
        type: 'object',
        properties: {
          orderId: { type: 'string', description: 'The ID of the order to return (e.g., "o1").' },
        },
        required: ['orderId'],
      },
    },
    {
      name: 'calculate_order_total',
      description: 'Calculates the total price for a list of product names. Adds a flat $50 international shipping fee if any item is imported.',
      inputSchema: {
        type: 'object',
        properties: {
          productNames: {
            type: 'array',
            items: { type: 'string' },
            description: 'List of exact product names to include in the order.',
          },
        },
        required: ['productNames'],
      },
    },
    {
      name: 'get_user_dashboard',
      description: "Returns a user's profile, full order history, and total lifetime spend (excluding returned orders).",
      inputSchema: {
        type: 'object',
        properties: {
          email: { type: 'string', description: "The user's email address." },
        },
        required: ['email'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const ts = new Date().toISOString();

  try {
    let result;

    switch (name) {
      case 'get_product_catalog':
        result = await getProductCatalog();
        break;
      case 'process_return':
        result = await processReturn(args);
        break;
      case 'calculate_order_total':
        result = await calculateOrderTotal(args);
        break;
      case 'get_user_dashboard':
        result = await getUserDashboard(args);
        break;
      default:
        throw new Error(`Unknown tool: "${name}"`);
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    console.error(`[ERROR] ${ts} Tool "${name}" failed: ${err.message}`);
    return {
      content: [{ type: 'text', text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

// ─── Start ─────────────────────────────────────────────────────────────────────

async function main() {
  const ts = new Date().toISOString();
  console.log(`[INIT] ${ts} BlueOrch MCP Server Starting...`);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.log(`[SUCCESS] ${ts} BlueOrch MCP Server running on stdio`);
}

main().catch(err => {
  console.error(`[ERROR] ${new Date().toISOString()} Fatal: ${err.message}`);
  process.exit(1);
});
