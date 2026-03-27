import { Component, OnInit, AfterViewChecked, ViewChild, ElementRef, HostListener, Output, EventEmitter } from '@angular/core';
import { forkJoin, of, Subscription } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { ChatService, ChatMessage, ActiveTool } from '../../services/chat.service';
import { LlmService, LlmRegistryEntry } from '../../services/llm.service';
import { McpService } from '../../services/mcp.service';
import { WorkspaceService } from '../../services/workspace.service';
import { UsageCalculatorService } from '../../services/usage-calculator.service';

// ─── System Instruction Builder ─────────────────────────────────────────────

const quotePromptPath = (path: string): string => JSON.stringify(path ?? '');

/**
 * Builds a universal system instruction that covers:
 *  - General knowledge / coding questions (no tools needed)
 *  - Workspace / filesystem questions (filesystem MCP tools)
 *  - Any other MCPs configured (Zomato, GitHub, DB, etc.)
 *
 * The instruction adapts at runtime based on what is actually available.
 */
function buildSystemInstruction(
  workspacePath: string,
  contextFiles: string[],
  mcpConnections: Array<{ label: string; tools: Array<{ name: string; description: string; enabled: boolean }>; enabled: boolean }>,
  isProjectMode: boolean,
): string {
  const lines: string[] = [
    'You are a highly capable AI assistant integrated into BlueOrch Studio.',
    'You can answer general questions, coding questions, and also interact with',
    'real external services and the local filesystem via MCP tools.',
    '',
    '## General Behaviour',
    '- For general or coding questions that need no external data, answer directly.',
    '- Whenever the user asks something that an available MCP tool can answer',
    '  (files, live data, APIs, databases, etc.) — ALWAYS call that tool.',
    '- Never guess, hallucinate, or fabricate data that a tool can fetch.',
    '- After calling tools, synthesise the results into a helpful, concise reply.',
    '- If the user asks to "show", "give", "print", or "display" a file or its code:',
    '  output the COMPLETE raw file content inside a fenced code block (``` ... ```).',
    '  Do NOT describe or summarise — show the actual text exactly as returned by the tool.',
    '',
    '## Multi-Step Folder Exploration (CRITICAL)',
    '- When the user asks about logic, code, or content INSIDE a folder:',
    '  STEP 1 — call list_directory on that folder to get the file names.',
    '  STEP 2 — for EACH source file returned (e.g. .js, .ts, .html, .css, .py)',
    '           construct its FULL absolute path as: folder_path + "/" + filename.',
    '           Example: workspace is "/Users/me/Projects", folder is "Drawing Board",',
    '           file is "script.js" → full path = "/Users/me/Projects/Drawing Board/script.js".',
    '           You may call read_file individually OR read_multiple_files with an array of',
    '           full absolute paths. NEVER pass bare filenames without the folder prefix.',
    '  STEP 3 — after reading ALL relevant files, synthesise and explain.',
    '- NEVER stop after list_directory alone — you must read the actual file contents.',
    '- NEVER call read_file on a directory path itself — only on individual files.',
    '- Folder names and file names may contain spaces; pass paths verbatim, do not encode them.',
  ];

  // ── Workspace context (only when a path is set) ──────────────────────────
  if (workspacePath) {
    lines.push(
      '',
      '## Local Workspace',
      `Active workspace root (exact literal — preserve spaces): ${quotePromptPath(workspacePath)}`,
      '- For any file, folder, or code question: use filesystem MCP tools first.',
      '- Resolve relative paths as: workspace_root + "/" + relative_path.',
      '- Pass the workspace path verbatim — never encode, shorten, or split on spaces.',
      '- Do NOT fall back to the backend server folder or home directory as the workspace root.',
    );

    if (contextFiles.length > 0) {
      const fileList = contextFiles.map(f => `  - ${quotePromptPath(f)}`).join('\n');
      lines.push('', '### Pinned Context Files (read these first)', fileList);
    }
  }

  // ── Enumerate active MCP connections & their tools ───────────────────────
  const activeMcps = mcpConnections.filter(c => c.enabled);
  if (activeMcps.length > 0) {
    lines.push('', '## Configured MCP Tools');
    lines.push(
      'The following MCP servers and tools are connected and ready to call.',
      'Use the right tool for the right job — do not limit yourself to filesystem tools.',
    );
    for (const conn of activeMcps) {
      const enabledTools = conn.tools.filter(t => t.enabled);
      if (enabledTools.length === 0) continue;
      lines.push(``, `### ${conn.label}`);
      for (const tool of enabledTools) {
        const desc = tool.description ? ` — ${tool.description}` : '';
        lines.push(`- \`${tool.name}\`${desc}`);
      }
    }
    lines.push(
      '',
      'When a user question maps to any of these tools, call the tool immediately.',
      'Do not ask the user for permission to call tools — just call them.',
    );
  }

  // ── Project mode addendum ────────────────────────────────────────────────
  if (isProjectMode && workspacePath) {
    lines.push(
      '',
      '## Project Mode Active',
      'The user is working on their local codebase. Treat every file/code question',
      'as requiring a live filesystem tool read — never use recalled or invented content.',
    );
  }

  return lines.join('\n');
}

// ─── Local view model ────────────────────────────────────────────────────────

interface McpConnectionView {
  connectionId: string;
  label: string;
  enabled: boolean;
  tools: { name: string; description: string; enabled: boolean }[];
}

// ─── Component ────────────────────────────────────────────────────────────────

@Component({
  selector: 'app-chat',
  templateUrl: './chat.component.html',
  styleUrls: ['./chat.component.scss'],
})
export class ChatComponent implements OnInit, AfterViewChecked {
  @ViewChild('chatBody') chatBodyRef!: ElementRef<HTMLDivElement>;
  @Output() navigateToWorkspace = new EventEmitter<void>();

  // ── Sidebar
  providers: LlmRegistryEntry[] = [];
  selectedProviderId = '';
  mcpConnections: McpConnectionView[] = [];

  // ── Chat
  messages: ChatMessage[] = [];
  inputMessage = '';
  isThinking = false;
  errorMessage = '';
  showError = false;

  // ── Token / Cost tracking
  totalSessionCost = 0;

  // ── Copy response feedback
  copiedTimestamp: string | null = null;

  // ── Project Mode (off by default — user opts in explicitly)
  isProjectModeActive = false;

  private shouldScroll = false;
  private chatSub: Subscription | null = null;

  constructor(
    private chatService: ChatService,
    private llmService: LlmService,
    private mcpService: McpService,
    public workspaceService: WorkspaceService,
    private usageCalc: UsageCalculatorService,
  ) {
    console.log(`[INIT] ${new Date().toISOString()} ChatComponent initialized`);
  }

  ngOnInit(): void {
    this.loadSidebar();
    this.loadHistory();
  }

  ngAfterViewChecked(): void {
    if (this.shouldScroll) {
      this.scrollToBottom();
      this.shouldScroll = false;
    }
  }

  ngOnDestroy(): void {
    if (this.chatSub) {
      this.chatSub.unsubscribe();
      this.chatSub = null;
    }
  }

  // ── Sidebar data ──────────────────────────────────────────────────────────────

  /** Called once on init and again each time the Chat tab is activated. */
  loadSidebar(): void {
    console.log(`[INIT] ${new Date().toISOString()} ChatComponent.loadSidebar()`);
    this.loadProviders();
    this.loadMcpConnections();
  }

  private loadProviders(): void {
    const currentId = this.selectedProviderId;
    this.llmService.getRegistry().subscribe({
      next: (res) => {
        this.providers = res.registry;
        // Preserve current selection if it's still in the registry
        const stillValid = res.registry.some(p => p.id === currentId);
        if (!stillValid) {
          this.selectedProviderId = res.activeId ?? (res.registry[0]?.id ?? '');
        }
        console.log(`[SUCCESS] ${new Date().toISOString()} Providers loaded | ${res.registry.length}`);
      },
      error: err => console.log(`[ERROR] ${new Date().toISOString()} Failed to load providers | ${err.message}`),
    });
  }

  private loadMcpConnections(): void {
    this.mcpService.getClients().subscribe({
      next: (connections) => {
        if (connections.length === 0) { this.mcpConnections = []; return; }

        const toolFetches = connections.map(c =>
          this.mcpService.getTools(c.connectionId).pipe(
            catchError(() => of({ connectionId: c.connectionId, tools: [] }))
          )
        );

        forkJoin(toolFetches).subscribe({
          next: (toolResponses) => {
            this.mcpConnections = connections.map((c, i) => {
              // Preserve user's toggle state for connections already in the list
              const existing = this.mcpConnections.find(m => m.connectionId === c.connectionId);
              return {
                connectionId: c.connectionId,
                label: c.label,
                enabled: existing?.enabled ?? true,
                tools: (toolResponses[i].tools ?? []).map(t => {
                  const existingTool = existing?.tools.find(et => et.name === t.name);
                  return {
                    name: t.name,
                    description: t.description,
                    enabled: existingTool?.enabled ?? true,
                  };
                }),
              };
            });
            console.log(`[SUCCESS] ${new Date().toISOString()} MCP connections loaded | ${connections.length}`);
          },
          error: err => console.log(`[ERROR] ${new Date().toISOString()} Failed to load MCP tools | ${err.message}`),
        });
      },
      error: err => console.log(`[ERROR] ${new Date().toISOString()} Failed to load MCP connections | ${err.message}`),
    });
  }

  // ── Sidebar helpers ───────────────────────────────────────────────────────────

  providerLabel(entry: LlmRegistryEntry): string {
    const names: Record<string, string> = { gemini: 'Gemini', openai: 'OpenAI', claude: 'Claude' };
    return `${names[entry.provider] ?? entry.provider} — ${entry.model}`;
  }

  providerIconClass(provider: string): string {
    const icons: Record<string, string> = {
      gemini: 'bi-google', openai: 'bi-robot', claude: 'bi-cpu',
      ollama: 'bi-hdd-stack', lmstudio: 'bi-pc-display',
    };
    return icons[provider] ?? 'bi-box';
  }

  getSelectedProvider(): LlmRegistryEntry | undefined {
    return this.providers.find(p => p.id === this.selectedProviderId);
  }

  toggleServer(conn: McpConnectionView): void {
    conn.enabled = !conn.enabled;
    conn.tools.forEach(t => (t.enabled = conn.enabled));
  }

  getActiveTools(): ActiveTool[] {
    const tools: ActiveTool[] = [];
    for (const conn of this.mcpConnections) {
      if (!conn.enabled) continue;
      for (const tool of conn.tools) {
        if (tool.enabled) tools.push({ connectionId: conn.connectionId, toolName: tool.name });
      }
    }
    return tools;
  }

  get activeToolCount(): number {
    return this.getActiveTools().length;
  }

  get inputPlaceholder(): string {
    return this.isProjectModeActive
      ? 'Ask about your project...'
      : 'Ask a general coding question...';
  }

  get systemInstruction(): string {
    return buildSystemInstruction(
      this.workspaceService.currentPath,
      this.workspaceService.contextFiles,
      this.mcpConnections,
      this.isProjectModeActive,
    );
  }

  // ── Chat ──────────────────────────────────────────────────────────────────────

  loadHistory(): void {
    this.chatService.getHistory().subscribe({
      next: (res) => {
        this.messages = res.history.map(h => ({
          role: h.role as 'user' | 'assistant',
          content: h.content,
          timestamp: new Date().toISOString(),
          toolsUsed: h.toolsUsed,
          standardizedUsage: h.standardizedUsage ?? null,
          turnCost: h.standardizedUsage
            ? this.usageCalc.calculateCost(h.standardizedUsage)
            : 0,
        }));
        if (this.messages.length > 0) this.shouldScroll = true;
        console.log(`[SUCCESS] ${new Date().toISOString()} Chat history loaded | ${this.messages.length} messages`);
      },
      error: err => console.log(`[ERROR] ${new Date().toISOString()} Failed to load history | ${err.message}`),
    });
  }

  sendMessage(): void {
    const text = this.inputMessage.trim();
    if (!text || this.isThinking) return;

    if (!this.selectedProviderId) {
      this.showAlert('Please select a model before sending a message.');
      return;
    }

    this.messages.push({ role: 'user', content: text, timestamp: new Date().toISOString() });
    this.inputMessage = '';
    this.isThinking = true;
    this.showError = false;
    this.shouldScroll = true;

    console.log(`[INIT] ${new Date().toISOString()} ChatComponent.sendMessage() | provider: ${this.selectedProviderId}`);

    // Always send tools (both modes) — Expert mode also needs filesystem access.
    // Always send workspacePath — critical for correct path resolution in tool args.
    const activeTools = this.getActiveTools();
    const workspacePath = this.workspaceService.currentPath || undefined;

    this.chatSub = this.chatService.send({
      message: text,
      providerId: this.selectedProviderId,
      activeTools,
      systemContext: this.systemInstruction,
      activeWorkspacePath: workspacePath,
    }).subscribe({
      next: (res) => {
        const turnCost = this.usageCalc.calculateCost(res.standardizedUsage);
        this.totalSessionCost += turnCost;
        this.messages.push({
          role: 'assistant',
          content: res.reply,
          toolsUsed: res.toolsUsed,
          timestamp: new Date().toISOString(),
          standardizedUsage: res.standardizedUsage,
          turnCost,
        });
        this.isThinking = false;
        this.chatSub = null;
        this.shouldScroll = true;
        console.log(`[SUCCESS] ${new Date().toISOString()} Reply received | toolsUsed: [${res.toolsUsed.join(', ')}] | turnCost: $${turnCost.toFixed(6)} | sessionCost: $${this.totalSessionCost.toFixed(6)}`);
      },
      error: (err) => {
        this.isThinking = false;
        this.chatSub = null;
        const msg = err.error?.error ?? err.message ?? 'An unexpected error occurred.';
        this.showAlert(`Chat error: ${msg}`);
        console.log(`[ERROR] ${new Date().toISOString()} sendMessage failed | ${msg}`);
      },
    });
  }

  stopGeneration(): void {
    if (!this.chatSub || !this.isThinking) return;
    this.chatSub.unsubscribe();
    this.chatSub = null;
    this.isThinking = false;
    this.showAlert('Response stopped by user.');
    console.log(`[SUCCESS] ${new Date().toISOString()} ChatComponent: generation stopped by user`);
  }

  onEnter(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.sendMessage();
    }
  }

  clearChat(): void {
    this.chatService.clearHistory().subscribe({
      next: () => {
        this.messages = [];
        this.totalSessionCost = 0;
        console.log(`[SUCCESS] ${new Date().toISOString()} Chat history cleared`);
      },
      error: err => console.log(`[ERROR] ${new Date().toISOString()} Failed to clear history | ${err.message}`),
    });
  }

  resetSessionCost(): void {
    this.totalSessionCost = 0;
    console.log(`[SUCCESS] ${new Date().toISOString()} Session cost reset`);
  }

  showAlert(msg: string): void {
    this.errorMessage = msg;
    this.showError = true;
  }

  dismissError(): void {
    this.showError = false;
  }

  private scrollToBottom(): void {
    try {
      const el = this.chatBodyRef?.nativeElement;
      if (el) el.scrollTop = el.scrollHeight;
    } catch (_) {}
  }

  // ── Code block copy — event delegation (onclick stripped by DomSanitizer) ───
  @HostListener('click', ['$event'])
  onCopyClick(event: MouseEvent): void {
    const btn = (event.target as HTMLElement).closest('.code-copy-btn') as HTMLButtonElement | null;
    if (!btn) return;

    const codeEl = btn.closest('.code-block')?.querySelector('code');
    if (!codeEl) return;

    // textContent gives raw code text; ::before pseudo-elements are excluded
    const text = (codeEl.textContent ?? '').trim();
    const orig = btn.textContent ?? 'Copy';

    navigator.clipboard.writeText(text).then(() => {
      btn.textContent = 'Copied!';
      console.log(`[SUCCESS] ${new Date().toISOString()} Code block copied to clipboard`);
      setTimeout(() => { btn.textContent = orig; }, 2000);
    }).catch(err => {
      btn.textContent = 'Error';
      console.log(`[ERROR] ${new Date().toISOString()} Clipboard write failed | ${err.message}`);
      setTimeout(() => { btn.textContent = orig; }, 2000);
    });
  }

  copyResponse(msg: ChatMessage): void {
    navigator.clipboard.writeText(msg.content).then(() => {
      this.copiedTimestamp = msg.timestamp;
      console.log(`[SUCCESS] ${new Date().toISOString()} AI response copied to clipboard`);
      setTimeout(() => { this.copiedTimestamp = null; }, 2000);
    }).catch(err => {
      console.log(`[ERROR] ${new Date().toISOString()} Clipboard write failed | ${err.message}`);
    });
  }

  truncatePath(path: string): string {
    if (!path) return '—';
    const sep = path.includes('/') ? '/' : '\\';
    const parts = path.split(sep).filter(p => p.length > 0);
    if (parts.length <= 4) return path;
    const prefix = path.startsWith('/') ? '/' : '';
    const head = parts.slice(0, 2).join(sep);
    const tail = parts.slice(-2).join(sep);
    return `${prefix}${head}${sep}…${sep}${tail}`;
  }
}