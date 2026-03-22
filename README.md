# BlueOrch Studio <img src="blueorch-ui/src/favicon.svg" alt="terminal" width="22" height="22" style="vertical-align:middle;background:#1a73e8;border-radius:4px;padding:2px;"> 🔵

> **A Modular MCP Orchestrator** — Bridging multiple LLM providers with Model Context Protocol (MCP) tools through a sleek full-stack web interface.

---

## Table of Contents

1. [Overview](#overview)
2. [Features](#features)
3. [Architecture](#architecture)
4. [Repository Structure](#repository-structure)
5. [Tech Stack](#tech-stack)
6. [Prerequisites](#prerequisites)
7. [Installation](#installation)
8. [Running the Application](#running-the-application)
9. [Environment Variables](#environment-variables)
10. [Module Reference](#module-reference)
    - [blueorch-ui](#blueorch-ui-angular-17-frontend)
    - [blueorch-server](#blueorch-server-nodejs-express-api)
    - [mcp-server](#mcp-server-standalone-mcp-server)
    - [mcp-client-cli](#mcp-client-cli)
    - [llm-cli](#llm-cli)
11. [API Reference](#api-reference)
12. [Key Concepts](#key-concepts)
13. [Contributing](#contributing)

---

## Overview

**BlueOrch Studio** is a full-stack application that acts as an orchestration layer between:

- **You** (the user, via a browser-based chat interface)
- **Multiple LLM providers** (Google Gemini, OpenAI, Anthropic Claude, Ollama, LM Studio)
- **MCP tools** (Model Context Protocol servers — filesystem, product/order management, custom tools)

The system lets you configure providers, connect MCP tool servers, explore your local workspace, and run AI-powered chat sessions with automatic tool calling — all from one unified UI.

---

## Features

| Feature | Description |
|---------|-------------|
| 🤖 **Multi-Provider LLM Support** | Verify & switch between Gemini, OpenAI, Claude, Ollama, and LM Studio |
| 🔧 **MCP Tool Integration** | Connect to stdio-based MCP servers, list tools, execute them, view live logs |
| 💬 **Agentic Chat** | Multi-turn conversations with automatic tool-calling loop |
| 📁 **Workspace Explorer** | Browse, read, and write local files from the UI |
| 📌 **Context Pinning** | Pin files as context so the AI always has them in scope |
| 🏗️ **Project Mode** | Workspace-aware AI using Gemini context caching to reduce costs |
| 🎓 **Expert Mode** | Direct AI chat without workspace context |
| 📊 **Token & Cost Tracking** | Standardized usage badges per message across all providers |
| 📡 **Real-time Logs** | Server-Sent Events (SSE) stream for live backend log monitoring |
| 🔄 **Hot Server Restart** | Restart the backend process without losing UI state |
| 🌙 **Dark Mode** | Theme toggle with `localStorage` persistence |
| ❌ **Request Cancellation** | Stop a running AI request mid-flight |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Browser (Angular 17)                     │
│  ┌─────────┐  ┌──────────┐  ┌─────────────┐  ┌──────────┐  │
│  │  Chat   │  │ LLM Cfg  │  │  MCP Config │  │Workspace │  │
│  │Component│  │Component │  │  Component  │  │  Tab     │  │
│  └────┬────┘  └─────┬────┘  └──────┬──────┘  └────┬─────┘  │
│       │             │              │               │        │
│  ┌────▼─────────────▼──────────────▼───────────────▼─────┐  │
│  │        Angular Services (HTTP calls to :3500)         │  │
│  └────────────────────────┬──────────────────────────────┘  │
└───────────────────────────│─────────────────────────────────┘
                            │ HTTP/REST + SSE
┌───────────────────────────▼─────────────────────────────────┐
│                  Express Server (:3500)                      │
│  ┌────────────┐  ┌───────────┐  ┌──────────┐  ┌──────────┐  │
│  │chat.routes │  │llm.routes │  │mcp.routes│  │sys.routes│  │
│  └─────┬──────┘  └─────┬─────┘  └────┬─────┘  └────┬─────┘  │
│        │               │             │              │        │
│  ┌─────▼───────────┐   │      ┌──────▼──────┐       │        │
│  │ Provider Router │   │      │ MCP Client  │  ┌────▼──────┐ │
│  │(Gemini/OpenAI/  │   │      │(stdio child │  │Filesystem │ │
│  │ Claude/Ollama/  │   │      │ processes)  │  │  Access   │ │
│  │ LMStudio)       │   │      └──────┬──────┘  └───────────┘ │
│  └─────────────────┘   │             │                       │
└────────────────────────│─────────────│───────────────────────┘
                         │             │ stdio / JSON-RPC
                 LLM Cloud/Local  ┌────▼──────────────────────┐
                   Provider APIs  │   MCP Server (Node.js)    │
                                  │  tools: getProducts,      │
                                  │  getOrders, readFile, …   │
                                  └───────────────────────────┘
```

**Data flow for a chat message with tool calling:**

1. User sends message in Angular Chat UI
2. `ChatService` POSTs to `/api/chat/send` with message + selected tools
3. Express calls the active LLM provider SDK with tool definitions
4. If the LLM returns tool calls → backend executes them via the connected MCP client
5. Tool results are appended to history and the LLM is called again (agentic loop)
6. When the LLM returns a plain text response → it is returned to the frontend
7. Angular renders the response with Markdown and syntax-highlighted code blocks

---

## Repository Structure

```
blueorch-studio/
├── blueorch-ui/               # Angular 17 frontend SPA
│   ├── src/
│   │   ├── app/
│   │   │   ├── components/
│   │   │   │   ├── chat/            # Chat interface
│   │   │   │   ├── dashboard/       # Main layout & tab navigation
│   │   │   │   ├── llm-config/      # LLM provider registry
│   │   │   │   ├── mcp-config/      # MCP server connections
│   │   │   │   ├── workspace-tab/   # File explorer & editor
│   │   │   │   ├── token-badge/     # Per-message token display
│   │   │   │   └── usage-badge/     # Per-message cost display
│   │   │   ├── services/
│   │   │   │   ├── chat.service.ts
│   │   │   │   ├── llm.service.ts
│   │   │   │   ├── mcp.service.ts
│   │   │   │   ├── workspace.service.ts
│   │   │   │   ├── logs.service.ts
│   │   │   │   └── usage-calculator.service.ts
│   │   │   └── directives/
│   │   │       └── bs-tooltip.directive.ts
│   │   └── environments/
│   │       ├── environment.ts          # Dev: apiUrl = http://localhost:3500
│   │       └── environment.prod.ts     # Prod: override apiUrl here
│   └── package.json
│
├── blueorch-server/           # Node.js / Express API server
│   ├── server.js          # App entry point; route registration
│   ├── logger.js          # Winston logger + SSE EventEmitter
│   ├── cache-manager.js   # Gemini context cache builder
│   ├── usage-normalizer.js# Standardize token usage across providers
│   └── routes/
│       ├── chat.routes.js    # POST /api/chat/send and history
│       ├── llm.routes.js     # LLM provider registry & verification
│       ├── mcp.routes.js     # MCP connection lifecycle & tool execution
│       ├── system.routes.js  # Filesystem access & server management
│       └── log.routes.js     # Log fetch & SSE streaming
│
├── mcp-server/            # Standalone MCP server (stdio protocol)
│   ├── server.js          # MCP server entry; tool definitions
│   └── package.json
│
├── mcp-client-cli/        # Node.js CLI MCP client for testing
│   └── package.json
│
├── llm-cli/               # CLI for testing LLMs directly with MCP
│   ├── main.js
│   └── package.json
│
└── .gitignore
```

---

## Tech Stack

### Frontend (`blueorch-ui`)

| Category | Technology | Version |
|----------|-----------|---------|
| Framework | Angular | 17.3.17 |
| Language | TypeScript | 5.4.2 |
| Reactive | RxJS | 7.8.0 |
| UI Framework | Bootstrap | 5.3.3 |
| Icons | Bootstrap Icons | 1.11.3 |
| Code Editor | Monaco Editor | 0.55.1 |
| Markdown | ngx-markdown + marked | 17.2.1 / 12.0.2 |
| Syntax Highlighting | highlight.js | 11.11.1 |
| Tree Widget | Angular CDK | 17.3.10 |

> **Convention**: Traditional Angular syntax only — constructor injection, Observables. No Signals, no `inject()`.

### Backend (`blueorch-server`)

| Category | Technology | Version |
|----------|-----------|---------|
| Runtime | Node.js (ESM) | 18+ |
| Framework | Express | 4.18.0 |
| CORS | cors | 2.8.5 |
| Logging | Winston | 3.19.0 |
| Env Vars | dotenv | 17.3.1 |
| MCP SDK | @modelcontextprotocol/sdk | 1.0.0 |
| **Gemini** | @google/genai | 1.46.0 |
| **OpenAI** | openai | 6.32.0 |
| **Claude** | @anthropic-ai/sdk | 0.80.0 |
| **Ollama** | ollama | 0.5.0 |

---

## Prerequisites

- **Node.js 18+** (LTS recommended)
- **npm 9+**
- **Angular CLI** (optional, for scaffolding): `npm install -g @angular/cli@17`
- **API keys** for any cloud LLM provider you wish to use (Gemini, OpenAI, Claude)
- *(Optional)* **Ollama** running on `localhost:11434`
- *(Optional)* **LM Studio** running on `localhost:1234`

---

## Installation

Clone the repository and install dependencies for each module:

```bash
git clone https://github.com/makesh-kumar/blueorch-studio.git
cd blueorch-studio

# Install all modules
(cd blueorch-ui && npm install)
(cd blueorch-server && npm install)
(cd mcp-server && npm install)
(cd mcp-client-cli && npm install)
(cd llm-cli && npm install)
```

---

## Running the Application

### Development Mode

Open **two terminals** and run the following commands:

**Terminal 1 — Backend API Server**

```bash
cd blueorch-server

# Create a .env file (see Environment Variables section)
# Then start the backend:
PORT=3500 npm run dev
# Alternatively: PORT=3500 node --watch server.js
```

The API will be available at `http://localhost:3500`.

**Terminal 2 — Angular Frontend**

```bash
cd blueorch-ui
# or: npx ng serve
```

Open your browser at **[http://localhost:4200](http://localhost:4200)**.

---

### Optional Modules

**MCP Server** (needed to connect BlueOrch to sample MCP tools):

```bash
cd mcp-server
npm start
# Spawned by the backend automatically when you connect via the UI
```

**LLM CLI** (for testing LLM calls directly from the terminal):

```bash
cd llm-cli
npm run gemini   # Test Gemini
npm run ollama   # Test Ollama
```

**MCP Client CLI** (for testing MCP tool calls from the terminal):

```bash
cd mcp-client-cli
npm start
```

---

### Production Build

```bash
# 1. Build the Angular SPA
cd blueorch-ui
npm run build
# Output: blueorch-ui/dist/blueorch-ui/

# 2. Optionally serve the built SPA with the backend or via nginx
# 3. Start backend in production
cd blueorch-server
NODE_ENV=production PORT=3500 npm start
```

---

## Environment Variables

Create a `.env` file in the `blueorch-server/` directory:

```dotenv
# Server
PORT=3500
CORS_ORIGIN=http://localhost:4200

# Cloud LLM Providers (add the keys you need)
GEMINI_API_KEY=your_google_gemini_api_key
OPENAI_API_KEY=your_openai_api_key
ANTHROPIC_API_KEY=your_anthropic_claude_api_key

# Local LLM Providers (default URLs shown)
OLLAMA_BASE=http://localhost:11434
LMSTUDIO_BASE=http://localhost:1234
```

For the `llm-cli` module, create a `.env` file in `llm-cli/`:

```dotenv
GEMINI_API_KEY=your_google_gemini_api_key
OLLAMA_BASE=http://localhost:11434
```

> **Note**: API keys are never stored on disk by the application. They are held in memory only for the lifetime of the server process.

---

## Module Reference

### `blueorch-ui` — Angular 17 Frontend

The single-page application served at `localhost:4200`.

| Component | Route | Purpose |
|-----------|-------|---------|
| `DashboardComponent` | `/` | Main shell; tab navigation; dark-mode toggle; server restart |
| `LlmConfigComponent` | `/llm` | Add / verify / set active / delete LLM providers |
| `McpConfigComponent` | `/mcp` | Connect MCP servers; browse tools; view connection logs |
| `ChatComponent` | `/chat` | AI chat with Project/Expert modes; tool selection |
| `WorkspaceTabComponent` | `/workspace` | File tree; read/write files; pin context files |
| `TokenBadgeComponent` | (shared) | Token count display per message |
| `UsageBadgeComponent` | (shared) | Estimated cost display per message |

**Key Services:**

| Service | Responsibilities |
|---------|----------------|
| `ChatService` | Send/clear messages; manage chat history |
| `LlmService` | Provider registry; verify credentials; list models |
| `McpService` | Connect/disconnect MCP servers; execute tools; fetch logs |
| `WorkspaceService` | Active workspace path; file tree; read/write; context pinning |
| `UsageCalculatorService` | Normalize token usage; estimate costs across providers |
| `LogsService` | Fetch logs; SSE subscription for real-time log streaming |

---

### `blueorch-server` — Node.js Express API

REST API server on `localhost:3500`.

**Entry Point:** `blueorch-server/server.js`

**Supporting Modules:**

| File | Purpose |
|------|---------|
| `logger.js` | Winston structured logging; EventEmitter for SSE log events |
| `cache-manager.js` | Build workspace snapshots; manage Gemini context cache objects |
| `usage-normalizer.js` | Translate provider-specific usage objects to a standard shape |

---

### `mcp-server` — Standalone MCP Server

A stdio-based MCP server you can connect to from the UI for testing. It exposes sample tools such as:

- `getProducts` — Return a list of products
- `getOrders` — Return a list of orders
- `readFile` — Read a file from the workspace

Start it manually or let the backend spawn it via the MCP connection command:

```bash
node /path/to/mcp-server/server.js
```

From the **MCP Config** tab in the UI, enter the command above and click **Connect**.

---

### `mcp-client-cli`

A minimal Node.js command-line client for testing MCP server connections outside the UI. Useful for verifying that a custom MCP server is exposing the correct tools.

---

### `llm-cli`

A command-line interface for direct LLM interaction with optional MCP tool calling. Useful for quickly testing provider configurations:

```bash
cd llm-cli
npm run gemini   # Gemini provider
npm run ollama   # Ollama provider
```

---

## API Reference

All endpoints are prefixed with `/api` and served from `localhost:3500`.

### LLM Provider Routes — `/api/llm`

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/llm/verify` | Verify provider credentials & list models |
| `GET` | `/api/llm/registry` | List all registered LLM providers |
| `GET` | `/api/llm/active` | Get the currently active provider |
| `PUT` | `/api/llm/active/:id` | Set a provider as active |
| `DELETE` | `/api/llm/:id` | Remove a provider from the registry |
| `POST` | `/api/llm/models` | Fetch available models (Gemini / OpenAI / Claude) |
| `GET` | `/api/llm/ollama/models` | List locally available Ollama models |
| `GET` | `/api/llm/lmstudio/models` | List locally available LM Studio models |

### MCP Routes — `/api/mcp`

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/mcp/connect` | Connect to an MCP server via stdio command |
| `GET` | `/api/mcp/clients` | List all active MCP connections |
| `GET` | `/api/mcp/tools/:connectionId` | List tools available on a connection |
| `POST` | `/api/mcp/execute` | Execute a tool by name with arguments |
| `POST` | `/api/mcp/proxy` | Execute a tool with workspace path injection |
| `DELETE` | `/api/mcp/disconnect/:connectionId` | Close an MCP connection |
| `GET` | `/api/mcp/logs/:connectionId` | Fetch logs for a connection |
| `DELETE` | `/api/mcp/logs/:connectionId/clear` | Clear logs for a connection |

### Chat Routes — `/api/chat`

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/chat/send` | Send a message; runs agentic tool-calling loop |
| `GET` | `/api/chat/history` | Fetch the full conversation history |
| `DELETE` | `/api/chat/history` | Clear conversation history |
| `POST` | `/api/chat/stop` | Abort an in-progress chat request |

### System Routes — `/api/system`

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/system/health` | Health check (returns `{ status: 'ok' }`) |
| `GET` | `/api/system/env` | Get machine home directory |
| `GET` | `/api/system/files/tree` | List directory contents (lazy-load, one level) |
| `GET` | `/api/system/files/read` | Read file content (max 2 MB) |
| `PUT` | `/api/system/files/write` | Write content to a file |
| `POST` | `/api/system/files/create` | Create a file or directory |
| `POST` | `/api/system/restart` | Hot-restart the backend process |

### Log Routes — `/api/logs`

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/logs` | Fetch recent log entries (supports `?level=` and `?limit=`) |
| `GET` | `/api/logs/stream` | SSE stream — push new log entries in real time |

---

## Key Concepts

### Agentic Tool-Calling Loop

When you send a message with tools selected, the backend enters a loop:

```
Send message + tool definitions to LLM
       │
       ▼
LLM responds with tool calls?
       ├── YES → Execute each tool via MCP client
       │          Append tool results to history
       │          Call LLM again ───────────────┐
       │                                        │ (repeat)
       └── NO  → Return text response to UI ◄──┘
```

This continues until the LLM produces a final text response.

### Project Mode vs Expert Mode

| | Project Mode | Expert Mode |
|---|---|---|
| **Context** | Active workspace files + pinned files injected into system prompt | Plain chat, no workspace context |
| **Caching** | Gemini context cache used to reduce token costs | No caching |
| **Best for** | Workspace-aware coding/analysis tasks | General-purpose questions |

### Provider Abstraction

The backend provides a unified `sendMessage(provider, messages, tools)` interface. Internally, it dispatches to the correct SDK call for each provider:

| Provider | SDK | Notes |
|----------|-----|-------|
| `gemini` | `@google/genai` | Supports context caching (Project Mode) |
| `openai` | `openai` | Standard chat completions with tools |
| `claude` | `@anthropic-ai/sdk` | Messages API with tool_use blocks |
| `ollama` | `ollama` | Local inference; OpenAI-compatible tool format |
| `lmstudio` | `openai` (base URL override) | Local inference via LM Studio REST API |

### Logging Convention

All backend functions emit structured console logs:

```
[2026-01-15T10:30:00.000Z] [INIT]    chat.routes: Processing chat request
[2026-01-15T10:30:01.234Z] [SUCCESS] chat.routes: Response generated, tokens: 512
[2026-01-15T10:30:01.500Z] [ERROR]   llm.routes: Gemini verification failed – Invalid API key
```

These logs are captured by Winston, stored in a rolling in-memory buffer, and streamed to the UI via SSE.

---

## Contributing

1. **Branch naming**: `feature/<short-description>` or `fix/<issue-id>`
2. **Angular style**: Use constructor injection and Observables only. No Signals, no `inject()`.
3. **Backend style**: Plain JavaScript ESM modules (`.js`). No TypeScript in the backend.
4. **Logging**: Every function must log `[INIT]`, `[SUCCESS]`, or `[ERROR]` with an ISO timestamp.
5. **UI**: Bootstrap 5 components and Bootstrap Icons. White and blue professional theme.
6. **Modularity**: Follow the 6-step isolated module plan. Do not cross module boundaries unnecessarily.

---

## License

This project is privately maintained. See repository settings for access and licensing details.
