import { Component, OnInit, OnDestroy, ViewChild, ElementRef } from '@angular/core';
import { McpService, McpTool, ActiveConnection, ConnectResponse, LogsResponse } from '../../services/mcp.service';

@Component({
  selector: 'app-mcp-config',
  templateUrl: './mcp-config.component.html',
  styleUrls: ['./mcp-config.component.scss'],
})
export class McpConfigComponent implements OnInit, OnDestroy {
  // ── Connection state
  command = 'node';
  argsInput = '../mcp-server/server.js';
  connections: ActiveConnection[] = [];
  selectedConnectionId: string | null = null;

  // ── Tool state
  tools: McpTool[] = [];
  selectedTool: McpTool | null = null;

  // ── Execution state
  toolArgsJson = '{}';
  toolResult = '';

  // ── Logs state
  serverLogs: string[] = [];

  // ── UI state
  isConnecting = false;
  isExecuting = false;
  errorMessage = '';
  showError = false;

  @ViewChild('logsTerminal') logsTerminalRef!: ElementRef<HTMLDivElement>;

  private logsInterval: ReturnType<typeof setInterval> | null = null;

  constructor(private mcpService: McpService) {
    console.log(`[INIT] ${new Date().toISOString()} McpConfigComponent initialized`);
  }

  ngOnInit(): void {
    // Reload any existing connections that were made before a browser refresh
    this.mcpService.getClients().subscribe({
      next: (clients) => {
        this.connections = clients;
        console.log(`[SUCCESS] ${new Date().toISOString()} McpConfigComponent loaded ${clients.length} existing connection(s)`);
      },
      error: err => console.log(`[ERROR] ${new Date().toISOString()} McpConfigComponent failed to load connections | ${err.message}`),
    });
  }

  ngOnDestroy(): void {
    this.stopLogsPolling();
  }

  // ── Logs polling ─────────────────────────────────────────────────────────
  private startLogsPolling(connectionId: string): void {
    this.stopLogsPolling();
    this.logsInterval = setInterval(() => {
      this.mcpService.getLogs(connectionId).subscribe({
        next: (res: LogsResponse) => {
          this.serverLogs = res.logs;
          setTimeout(() => {
            const el = this.logsTerminalRef?.nativeElement;
            if (el) el.scrollTop = el.scrollHeight;
          }, 0);
        },
        error: () => {},
      });
    }, 1500);
  }

  private stopLogsPolling(): void {
    if (this.logsInterval !== null) {
      clearInterval(this.logsInterval);
      this.logsInterval = null;
    }
  }

  clearServerLogs(): void {
    if (!this.selectedConnectionId) { return; }
    this.mcpService.clearLogs(this.selectedConnectionId).subscribe({
      next: () => { this.serverLogs = []; },
      error: () => {},
    });
  }

  // ── Connect ──────────────────────────────────────────────────────────────
  connect(): void {
    if (!this.command.trim()) { return; }
    const argsArray = this.argsInput.trim().split(/\s+/).filter(a => a.length > 0);
    this.isConnecting = true;
    this.dismissError();

    this.mcpService.connect(this.command.trim(), argsArray).subscribe({
      next: (res: ConnectResponse) => {
        this.connections.push({
          connectionId: res.connectionId,
          label: res.label,
          command: res.command,
          args: res.args,
          toolCount: res.tools.length,
        });
        this.isConnecting = false;
        this.selectConnection(res.connectionId);
        console.log(`[SUCCESS] ${new Date().toISOString()} McpConfigComponent connected | id: ${res.connectionId}`);
      },
      error: (err) => {
        this.showAlert(err.error?.error ?? 'Failed to connect. Check command and args.');
        this.isConnecting = false;
      },
    });
  }

  // ── Select connection ────────────────────────────────────────────────────
  selectConnection(id: string): void {
    this.selectedConnectionId = id;
    this.selectedTool = null;
    this.toolResult = '';
    this.toolArgsJson = '{}';
    this.serverLogs = [];
    this.dismissError();

    this.mcpService.getTools(id).subscribe({
      next: (res) => { this.tools = res.tools; },
      error: (err) => { this.showAlert(err.error?.error ?? 'Failed to load tools'); },
    });
    this.startLogsPolling(id);
  }

  // ── Toggle tool expand / collapse ────────────────────────────────────────
  selectTool(tool: McpTool): void {
    if (this.selectedTool?.name === tool.name) {
      this.selectedTool = null;
      return;
    }
    this.selectedTool = tool;
    this.toolResult = '';
    const props = tool.inputSchema?.properties ?? {};
    const defaults: Record<string, unknown> = {};
    Object.keys(props).forEach(k => {
      const p = props[k];
      if (p.type === 'array') defaults[k] = [];
      else if (p.type === 'string') defaults[k] = '';
      else if (p.type === 'number') defaults[k] = 0;
      else defaults[k] = null;
    });
    this.toolArgsJson = JSON.stringify(defaults, null, 2);
  }

  // ── Execute tool ─────────────────────────────────────────────────────────
  runTool(): void {
    if (!this.selectedTool || !this.selectedConnectionId) { return; }
    let args: object = {};
    try {
      args = JSON.parse(this.toolArgsJson);
    } catch {
      this.showAlert('Arguments must be valid JSON (e.g. {"key": "value"})');
      return;
    }
    this.isExecuting = true;
    this.toolResult = '';
    this.dismissError();

    this.mcpService.execute(this.selectedConnectionId, this.selectedTool.name, args).subscribe({
      next: (res) => {
        this.toolResult = JSON.stringify(res.result, null, 2);
        this.isExecuting = false;
        console.log(`[SUCCESS] ${new Date().toISOString()} Tool executed: ${this.selectedTool?.name}`);
      },
      error: (err) => {
        this.toolResult = JSON.stringify({ error: err.error?.error ?? 'Execution failed' }, null, 2);
        this.isExecuting = false;
      },
    });
  }

  // ── Disconnect ───────────────────────────────────────────────────────────
  disconnect(connectionId: string, event: MouseEvent): void {
    event.stopPropagation();
    if (this.selectedConnectionId === connectionId) {
      this.stopLogsPolling();
    }
    this.mcpService.disconnect(connectionId).subscribe({
      next: () => {
        this.connections = this.connections.filter(c => c.connectionId !== connectionId);
        if (this.selectedConnectionId === connectionId) {
          this.selectedConnectionId = null;
          this.tools = [];
          this.selectedTool = null;
          this.toolResult = '';
          this.serverLogs = [];
        }
      },
      error: () => {
        this.connections = this.connections.filter(c => c.connectionId !== connectionId);
      },
    });
  }

  // ── Alert helpers ────────────────────────────────────────────────────────
  showAlert(msg: string): void {
    this.errorMessage = msg;
    this.showError = true;
  }

  dismissError(): void {
    this.showError = false;
    this.errorMessage = '';
  }
}
