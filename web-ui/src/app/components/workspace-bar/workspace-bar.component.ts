import { Component, OnInit, OnDestroy } from '@angular/core';
import { Subscription } from 'rxjs';
import { WorkspaceService, FolderItem } from '../../services/workspace.service';
import { McpService } from '../../services/mcp.service';

@Component({
  selector: 'app-workspace-bar',
  templateUrl: './workspace-bar.component.html',
  styleUrls: ['./workspace-bar.component.scss'],
})
export class WorkspaceBarComponent implements OnInit, OnDestroy {
  // ── Bar
  activePath = '';
  pathInput  = '';

  // ── Browser modal
  showBrowser  = false;
  browserItems: FolderItem[] = [];
  browserPath  = '';
  browserLoading = false;
  browserError = '';

  // ── File-system MCP connection
  private fsConnectionId = '';

  private sub!: Subscription;

  constructor(
    public workspaceService: WorkspaceService,
    private mcpService: McpService,
  ) {
    console.log(`[INIT] ${new Date().toISOString()} WorkspaceBarComponent initialized`);
  }

  ngOnInit(): void {
    this.sub = this.workspaceService.activePath$.subscribe(path => {
      this.activePath = path;
      this.pathInput  = path;
    });
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
  }

  // ── Path bar ───────────────────────────────────────────────────────────────

  applyPathInput(): void {
    const p = this.pathInput.trim();
    if (p && p !== this.activePath) {
      this.workspaceService.setPath(p);
    }
  }

  onPathKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      this.applyPathInput();
      (event.target as HTMLInputElement).blur();
    }
    if (event.key === 'Escape') {
      this.pathInput = this.activePath;
      (event.target as HTMLInputElement).blur();
    }
  }

  // ── Browse modal ───────────────────────────────────────────────────────────

  openBrowser(): void {
    this.showBrowser  = true;
    this.browserError = '';
    this._resolveFsConnection(() => {
      this._loadDir(this.activePath || '/');
    });
    console.log(`[INIT] ${new Date().toISOString()} WorkspaceBar: opened file browser`);
  }

  closeBrowser(): void {
    this.showBrowser = false;
  }

  navigateInto(item: FolderItem): void {
    if (item.type !== 'directory') return;
    this._loadDir(item.path);
  }

  navigateUp(): void {
    const parts = this.browserPath.split('/').filter(Boolean);
    parts.pop();
    const parent = parts.length > 0 ? '/' + parts.join('/') : '/';
    this._loadDir(parent);
  }

  selectCurrentDir(): void {
    this.workspaceService.setPath(this.browserPath);
    this.closeBrowser();
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private _resolveFsConnection(cb: () => void): void {
    if (this.fsConnectionId) { cb(); return; }

    this.mcpService.getClients().subscribe({
      next: (clients) => {
        if (clients.length === 0) {
          this.browserError = 'No MCP servers connected. Connect a filesystem server first.';
          return;
        }

        // Find first connection that exposes list_directory
        const checkNext = (idx: number) => {
          if (idx >= clients.length) {
            this.browserError = 'No connected MCP server exposes a list_directory tool.';
            return;
          }
          this.mcpService.getTools(clients[idx].connectionId).subscribe({
            next: (res) => {
              const hasTool = res.tools.some(t => t.name === 'list_directory');
              if (hasTool) {
                this.fsConnectionId = clients[idx].connectionId;
                cb();
              } else {
                checkNext(idx + 1);
              }
            },
            error: () => checkNext(idx + 1),
          });
        };
        checkNext(0);
      },
      error: (err) => {
        this.browserError = `Failed to fetch MCP clients: ${err.message}`;
        console.log(`[ERROR] ${new Date().toISOString()} WorkspaceBar: ${this.browserError}`);
      },
    });
  }

  private _loadDir(path: string): void {
    if (!this.fsConnectionId) return;
    this.browserLoading = true;
    this.browserError   = '';
    this.browserPath    = path;

    this.workspaceService.getFolderItems(this.fsConnectionId, path).subscribe({
      next: (items) => {
        this.browserItems   = items;
        this.browserLoading = false;
        console.log(`[SUCCESS] ${new Date().toISOString()} WorkspaceBar: loaded ${items.length} items for "${path}"`);
      },
      error: (err) => {
        this.browserLoading = false;
        this.browserError   = err.error?.error ?? err.message ?? 'Failed to list directory.';
        console.log(`[ERROR] ${new Date().toISOString()} WorkspaceBar: ${this.browserError}`);
      },
    });
  }
}
