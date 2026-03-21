import { Component, OnInit, AfterViewChecked, ViewChild, ElementRef, HostListener } from '@angular/core';
import { forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { ChatService, ChatMessage, ActiveTool } from '../../services/chat.service';
import { LlmService, LlmRegistryEntry } from '../../services/llm.service';
import { McpService } from '../../services/mcp.service';
import { WorkspaceService } from '../../services/workspace.service';
import { UsageCalculatorService } from '../../services/usage-calculator.service';

// ─── System Instruction Constants ───────────────────────────────────────────

const SYSTEM_PROJECT_MODE = (workspacePath: string): string =>
  `You are a Senior Systems Architect. Local Workspace: ${workspacePath}. ` +
  `Use MCP tools to analyze and modify the codebase.`;

const SYSTEM_EXPERT_MODE =
  `You are a world-class Senior Software Engineer and Computer Science expert. ` +
  `Provide high-performance, clean, and secure code solutions focusing on industry best practices ` +
  `and efficient algorithms. (Note: Local workspace access is currently disabled for this query.)`;

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

  // ── Project Mode (off by default — user opts in explicitly)
  isProjectModeActive = false;

  private shouldScroll = false;

  constructor(
    private chatService: ChatService,
    private llmService: LlmService,
    private mcpService: McpService,
    private workspaceService: WorkspaceService,
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
    if (this.isProjectModeActive) {
      return SYSTEM_PROJECT_MODE(this.workspaceService.currentPath);
    }
    return SYSTEM_EXPERT_MODE;
  }

  // ── Chat ──────────────────────────────────────────────────────────────────────

  loadHistory(): void {
    this.chatService.getHistory().subscribe({
      next: (res) => {
        this.messages = res.history.map(h => ({
          role: h.role as 'user' | 'assistant',
          content: h.content,
          timestamp: new Date().toISOString(),
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

    const activeTools = this.isProjectModeActive ? this.getActiveTools() : [];

    this.chatService.send({
      message: text,
      providerId: this.selectedProviderId,
      activeTools,
      systemContext: this.systemInstruction,
      // Project Mode: send workspace path so the backend can build/reuse a cache
      activeWorkspacePath: this.isProjectModeActive ? this.workspaceService.currentPath : undefined,
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
        this.shouldScroll = true;
        console.log(`[SUCCESS] ${new Date().toISOString()} Reply received | toolsUsed: [${res.toolsUsed.join(', ')}] | turnCost: $${turnCost.toFixed(6)} | sessionCost: $${this.totalSessionCost.toFixed(6)}`);
      },
      error: (err) => {
        this.isThinking = false;
        const msg = err.error?.error ?? err.message ?? 'An unexpected error occurred.';
        this.showAlert(`Chat error: ${msg}`);
        console.log(`[ERROR] ${new Date().toISOString()} sendMessage failed | ${msg}`);
      },
    });
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
}
