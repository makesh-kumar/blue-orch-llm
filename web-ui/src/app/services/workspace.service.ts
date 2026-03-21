import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, Observable } from 'rxjs';
import { map, tap } from 'rxjs/operators';

// ─── Models ───────────────────────────────────────────────────────────────────

export interface FolderItem {
  name: string;
  type: 'directory' | 'file';
  path: string;
}

export interface FileTreeItem {
  name: string;
  type: 'file' | 'directory';
  path: string;
}

export interface ProxyToolResponse {
  connectionId: string;
  toolName: string;
  result: { content: { type: string; text: string }[] };
}

// ─── LocalStorage keys ────────────────────────────────────────────────────────
const LS_PATH    = 'blueorch_workspacePath';
const LS_HOME    = 'blueorch_workspaceHomeDir';

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable({ providedIn: 'root' })
export class WorkspaceService {
  private readonly backendUrl = 'http://localhost:3000';

  /** The machine's $HOME – resolved once from backend on init. */
  private homeDir = '';

  /** Current active workspace path, broadcast to subscribers. */
  readonly activePath$ = new BehaviorSubject<string>('');

  /** Specific files pinned into AI context. Empty = entire activePath folder is used. */
  readonly contextFiles$ = new BehaviorSubject<string[]>([]);

  get contextFiles(): string[] {
    return this.contextFiles$.value;
  }

  setContextFiles(files: string[]): void {
    this.contextFiles$.next([...files]);
    console.log(`[SUCCESS] ${new Date().toISOString()} WorkspaceService.setContextFiles() | ${files.length} file(s)`);
  }

  clearContextFiles(): void {
    this.contextFiles$.next([]);
    console.log(`[SUCCESS] ${new Date().toISOString()} WorkspaceService.clearContextFiles()`);
  }

  constructor(private http: HttpClient) {
    console.log(`[INIT] ${new Date().toISOString()} WorkspaceService constructed`);
  }

  // ── Bootstrap (call once from AppComponent.ngOnInit) ───────────────────────

  init(): void {
    console.log(`[INIT] ${new Date().toISOString()} WorkspaceService.init() — fetching homeDir`);
    this.http.get<{ homeDir: string }>(`${this.backendUrl}/api/system/env`).subscribe({
      next: ({ homeDir }) => {
        this.homeDir = homeDir;
        const storedPath = localStorage.getItem(LS_PATH);
        const storedHome = localStorage.getItem(LS_HOME);

        // Portability check: if the stored homeDir differs from the current
        // machine's homeDir the user is on a new machine → reset to new $HOME.
        if (storedPath && storedHome === homeDir) {
          this.activePath$.next(storedPath);
          console.log(`[SUCCESS] ${new Date().toISOString()} WorkspaceService: restored path "${storedPath}"`);
        } else {
          this.activePath$.next(homeDir);
          this._persist(homeDir);
          console.log(`[SUCCESS] ${new Date().toISOString()} WorkspaceService: defaulting to homeDir "${homeDir}"`);
        }
      },
      error: (err) => {
        console.log(`[ERROR] ${new Date().toISOString()} WorkspaceService.init() failed | ${err.message}`);
      },
    });
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  get currentPath(): string {
    return this.activePath$.value;
  }

  setPath(path: string): void {
    this.activePath$.next(path);
    this._persist(path);
    console.log(`[SUCCESS] ${new Date().toISOString()} WorkspaceService.setPath() | "${path}"`);
  }

  /** System prompt injected at the start of every LLM conversation turn. */
  get systemContext(): string {
    const path = this.currentPath;
    return (
      `You are an expert developer assistant.\n` +
      `The current local workspace is exactly: ${JSON.stringify(path)}.\n` +
      `Treat that workspace path as a literal string and preserve spaces exactly as written.\n` +
      `All file operations should default to this directory.\n` +
      `If the user mentions "this folder" or "my code," they are referring to this exact path.`
    );
  }

  /**
   * Fetch one level of children for a directory via the native backend endpoint.
   * Called per lazy-load expand in the file explorer.
   */
  getFileTree(dirPath: string): Observable<FileTreeItem[]> {
    console.log(`[INIT] ${new Date().toISOString()} WorkspaceService.getFileTree() | path: "${dirPath}"`);
    return this.http
      .get<{ children: FileTreeItem[] }>(`${this.backendUrl}/api/system/files/tree`, {
        params: { path: dirPath },
      })
      .pipe(
        map(res => res.children),
        tap(items => console.log(`[SUCCESS] ${new Date().toISOString()} WorkspaceService.getFileTree() | ${items.length} items at "${dirPath}"`)),
      );
  }

  readFile(filePath: string): Observable<string> {
    console.log(`[INIT] ${new Date().toISOString()} WorkspaceService.readFile() | path: "${filePath}"`);
    return this.http
      .get<{ content: string; path: string }>(`${this.backendUrl}/api/system/files/read`, {
        params: { path: filePath },
      })
      .pipe(
        map(res => res.content),
        tap(() => console.log(`[SUCCESS] ${new Date().toISOString()} WorkspaceService.readFile() | "${filePath}"`)),
      );
  }

  writeFile(filePath: string, content: string): Observable<void> {
    console.log(`[INIT] ${new Date().toISOString()} WorkspaceService.writeFile() | path: "${filePath}"`);
    return this.http
      .put<void>(`${this.backendUrl}/api/system/files/write`, { path: filePath, content })
      .pipe(tap(() => console.log(`[SUCCESS] ${new Date().toISOString()} WorkspaceService.writeFile() | "${filePath}"`)));
  }

  createFile(filePath: string, type: 'file' | 'directory' = 'file'): Observable<void> {
    console.log(`[INIT] ${new Date().toISOString()} WorkspaceService.createFile() | path: "${filePath}"`);
    return this.http
      .post<void>(`${this.backendUrl}/api/system/files/create`, { path: filePath, type })
      .pipe(tap(() => console.log(`[SUCCESS] ${new Date().toISOString()} WorkspaceService.createFile() | "${filePath}"`)));
  }

  /**
   * List directory contents via the MCP proxy endpoint.
   * Uses @modelcontextprotocol/server-filesystem's `list_directory` tool.
   */
  getFolderItems(connectionId: string, path: string): Observable<FolderItem[]> {
    const resolvedPath = path || this.currentPath;
    console.log(`[INIT] ${new Date().toISOString()} WorkspaceService.getFolderItems() | path: "${resolvedPath}"`);
    return this.http
      .post<ProxyToolResponse>(`${this.backendUrl}/api/mcp/proxy`, {
        connectionId,
        toolName: 'list_directory',
        toolArgs: { path: resolvedPath },
        activeWorkspacePath: this.currentPath,
      })
      .pipe(
        tap(() => console.log(`[SUCCESS] ${new Date().toISOString()} WorkspaceService.getFolderItems() completed`)),
        map(res => this._parseDirectoryListing(res, resolvedPath))
      );
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private _persist(path: string): void {
    localStorage.setItem(LS_PATH, path);
    localStorage.setItem(LS_HOME, this.homeDir);
  }

  /**
   * Parses the text output produced by the MCP filesystem server's
   * list_directory tool.  Typical output:
   *   [DIR]  folder-name
   *   [FILE] filename.ts
   */
  private _parseDirectoryListing(res: ProxyToolResponse, parentPath: string): FolderItem[] {
    const text: string = res.result?.content?.[0]?.text ?? '';
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const items: FolderItem[] = [];

    for (const line of lines) {
      const isDirLine  = line.startsWith('[DIR]')  || line.startsWith('Directory:') || line.toLowerCase().includes('[dir]');
      const isFileLine = line.startsWith('[FILE]') || line.toLowerCase().includes('[file]');

      if (isDirLine) {
        const name = line.replace(/^\[DIR\]\s*/i, '').trim();
        if (name) items.push({ name, type: 'directory', path: `${parentPath}/${name}`.replace(/\/\//g, '/') });
      } else if (isFileLine) {
        const name = line.replace(/^\[FILE\]\s*/i, '').trim();
        if (name) items.push({ name, type: 'file', path: `${parentPath}/${name}`.replace(/\/\//g, '/') });
      } else if (line && !line.startsWith('Contents') && !line.startsWith('Listing')) {
        // Fallback: treat unknown non-header lines as files
        items.push({ name: line, type: 'file', path: `${parentPath}/${line}`.replace(/\/\//g, '/') });
      }
    }

    // Sort: directories first, then files
    items.sort((a, b) => {
      if (a.type === b.type) return a.name.localeCompare(b.name);
      return a.type === 'directory' ? -1 : 1;
    });

    return items;
  }
}
