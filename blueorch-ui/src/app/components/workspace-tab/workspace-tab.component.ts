import { Component, OnInit, OnDestroy, HostListener } from '@angular/core';
import { BehaviorSubject, Subscription } from 'rxjs';
import { FlatTreeControl } from '@angular/cdk/tree';
import { WorkspaceService, FileTreeItem } from '../../services/workspace.service';

export interface FileNode {
  name: string;
  type: 'file' | 'directory';
  path: string;
  level: number;
  expandable: boolean;
  loading: boolean;
  inContext: boolean;
  childrenLoaded: boolean;
  children: FileNode[];
}

// Monaco editor options
const BASE_EDITOR_OPTIONS = {
  theme: 'vs-dark',
  readOnly: true,
  minimap: { enabled: true },
  scrollBeyondLastLine: false,
  fontSize: 13,
  fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', monospace",
  lineNumbers: 'on' as const,
  renderLineHighlight: 'line' as const,
  wordWrap: 'on' as const,
};

/** Infer Monaco language from file extension */
function langFromName(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const MAP: Record<string, string> = {
    ts: 'typescript', js: 'javascript', mjs: 'javascript', cjs: 'javascript',
    html: 'html', css: 'css', scss: 'scss', sass: 'sass',
    json: 'json', md: 'markdown', yaml: 'yaml', yml: 'yaml',
    py: 'python', java: 'java', go: 'go', rs: 'rust',
    c: 'c', cpp: 'cpp', h: 'cpp', rb: 'ruby', php: 'php',
    sh: 'shell', bash: 'shell', zsh: 'shell', sql: 'sql',
    xml: 'xml', toml: 'ini', env: 'ini', swift: 'swift', kt: 'kotlin',
  };
  return MAP[ext] ?? 'plaintext';
}

@Component({
  selector: 'app-workspace-tab',
  templateUrl: './workspace-tab.component.html',
  styleUrls: ['./workspace-tab.component.scss'],
})
export class WorkspaceTabComponent implements OnInit, OnDestroy {

  // ── Workspace path ─────────────────────────────────────────────────────────
  activePath   = '';
  pathInput    = '';

  // ── CDK Tree state ─────────────────────────────────────────────────────────
  treeLoading  = false;
  treeError    = '';
  treeRootPath = '';
  flatNodes: FileNode[] = [];
  nodesData$   = new BehaviorSubject<FileNode[]>([]);

  treeControl = new FlatTreeControl<FileNode>(
    node => node.level,
    node => node.expandable,
  );
  hasChild = (_: number, node: FileNode): boolean => node.expandable;

  // Persisted set (shared with WorkspaceBar via WorkspaceService)
  private contextFilePaths = new Set<string>();

  // ── Monaco viewer state ────────────────────────────────────────────────────
  viewerFile: FileNode | null  = null;
  viewerContent: string        = '';
  viewerLoading                = false;
  viewerError                  = '';
  editorOptions: object        = { ...BASE_EDITOR_OPTIONS, language: 'plaintext' };

  private monacoEditor: any    = null;
  private pendingContent: string | null = null;
  private resizeObserver: ResizeObserver | null = null;
  monacoReady                  = false;
  contentReady                 = false;

  // ── Edit / Save state ─────────────────────────────────────────────────────
  isEditing      = false;
  isDirty        = false;
  isSaving       = false;
  saveNotify     = false;
  private originalContent = '';

  // ── Toolbar preferences ───────────────────────────────────────────────────
  activeTheme    = 'vs-dark';
  wordWrap       = true;
  minimapOn      = true;
  fontSize       = 13;

  // ── Status bar ────────────────────────────────────────────────────────────
  cursorLine     = 1;
  cursorCol      = 1;

  // ── New file / folder inline input ───────────────────────────────────────
  showNewInput   = false;
  newInputName   = '';
  newInputType: 'file' | 'directory' = 'file';
  newInputDir    = '';
  newInputError  = '';

  private sub!: Subscription;
  private _skipNextLoad = false;

  constructor(public workspaceService: WorkspaceService) {
    console.log(`[INIT] ${new Date().toISOString()} WorkspaceTabComponent initialized`);
  }

  ngOnInit(): void {
    this.sub = this.workspaceService.activePath$.subscribe(path => {
      this.activePath = path;
      this.pathInput  = path;
      if (this._skipNextLoad) {
        this._skipNextLoad = false;
        return;
      }
      this.treeRootPath = path;
      this._loadRoot(path || '/');
    });

    // Sync contextFilePaths from service on init
    this.contextFilePaths = new Set(this.workspaceService.contextFiles);
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
    this.resizeObserver?.disconnect();
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
      (event.target as HTMLElement).blur();
    }
    if (event.key === 'Escape') {
      this.pathInput = this.activePath;
    }
  }

  // ── Tree navigation ────────────────────────────────────────────────────────

  navigateToParent(): void {
    const parent = this._parentPath(this.treeRootPath);
    if (parent === this.treeRootPath) return;
    this.treeError = '';
    this._loadRoot(parent);
  }

  onDirRowClick(event: MouseEvent, node: FileNode): void {
    if ((event.target as HTMLElement).closest('button')) return;
    this.navigateInto(node);
  }

  navigateInto(node: FileNode): void {
    if (node.type !== 'directory') return;
    this.treeError = '';
    this._loadRoot(node.path);
  }

  setAsRoot(node: FileNode): void {
    if (node.type !== 'directory') return;
    this._skipNextLoad = true;
    this.workspaceService.setPath(node.path);
  }

  toggleNode(node: FileNode): void {
    if (!node.expandable || node.loading) return;

    if (this.treeControl.isExpanded(node)) {
      this._collapseDescendants(node);
      this.treeControl.collapse(node);
      const idx = this.flatNodes.indexOf(node);
      let end   = idx + 1;
      while (end < this.flatNodes.length && this.flatNodes[end].level > node.level) end++;
      this.flatNodes.splice(idx + 1, end - idx - 1);
      this.nodesData$.next([...this.flatNodes]);
    } else {
      this.treeControl.expand(node);
      if (node.childrenLoaded) {
        const idx = this.flatNodes.indexOf(node);
        this.flatNodes.splice(idx + 1, 0, ...node.children);
        this.nodesData$.next([...this.flatNodes]);
      } else {
        node.loading = true;
        this.nodesData$.next([...this.flatNodes]);
        this.workspaceService.getFileTree(node.path).subscribe({
          next: (items) => {
            node.loading        = false;
            node.childrenLoaded = true;
            const children      = this._itemsToNodes(items, node.level + 1);
            node.children       = children;
            const idx           = this.flatNodes.indexOf(node);
            this.flatNodes.splice(idx + 1, 0, ...children);
            this.nodesData$.next([...this.flatNodes]);
          },
          error: (err) => {
            node.loading = false;
            this.treeControl.collapse(node);
            this.nodesData$.next([...this.flatNodes]);
            console.error(`[ERROR] ${new Date().toISOString()} WorkspaceTab: load failed | ${err.message}`);
          },
        });
      }
    }
  }

  isExpanded(node: FileNode): boolean {
    return this.treeControl.isExpanded(node);
  }

  // ── File open (Monaco viewer) ──────────────────────────────────────────────

  openFile(node: FileNode): void {
    if (node.type !== 'file') return;
    if (this.viewerFile === node) return;
    if (this.isDirty && !confirm('Discard unsaved changes?')) return;
    // reset edit state for new file
    this.isEditing = false;
    this.isDirty   = false;
    this.originalContent = '';
    if (this.monacoEditor) this.monacoEditor.updateOptions({ readOnly: true });
    this.viewerFile    = node;
    this.viewerContent = '';
    this.viewerLoading = true;
    this.viewerError   = '';
    this.contentReady  = false;
    this.editorOptions = {
      ...BASE_EDITOR_OPTIONS,
      language: langFromName(node.name),
    };
    console.log(`[INIT] ${new Date().toISOString()} WorkspaceTab: opening "${node.path}"`);

    this.workspaceService.readFile(node.path).subscribe({
      next: (content) => {
        this.viewerLoading = false;
        this.viewerContent = content;
        if (this.monacoEditor) {
          // Editor already initialized — push content and language directly
          this.monacoEditor.setValue(content);
          const model = this.monacoEditor.getModel();
          if (model) {
            (window as any).monaco?.editor?.setModelLanguage(model, langFromName(node.name));
          }
          this.monacoEditor.revealLine(1);
          this.monacoEditor.layout();
          requestAnimationFrame(() => requestAnimationFrame(() => this.contentReady = true));
        } else {
          // Editor not yet ready — store for onMonacoInit
          this.pendingContent = content;
        }
        console.log(`[SUCCESS] ${new Date().toISOString()} WorkspaceTab: loaded "${node.name}"`);
      },
      error: (err) => {
        this.viewerLoading = false;
        this.viewerError   = err.error?.error ?? err.message ?? 'Failed to read file.';
        console.error(`[ERROR] ${new Date().toISOString()} WorkspaceTab: read failed | ${this.viewerError}`);
      },
    });
  }

  // Called by Monaco (onInit) — editor is guaranteed ready
  onMonacoInit(editor: any): void {
    this.monacoEditor = editor;
    this.monacoReady  = true;
    // Apply any content that arrived before the editor was ready
    const content = this.pendingContent ?? this.viewerContent;
    if (content) {
      editor.setValue(content);
      this.pendingContent = null;
      editor.layout();
      requestAnimationFrame(() => requestAnimationFrame(() => this.contentReady = true));
    }
    // ResizeObserver: re-layout Monaco whenever its container changes size
    // (handles initial display toggle, zoom, panel resize, toolbar show/hide)
    const container = editor.getContainerDomNode();
    if (container && typeof ResizeObserver !== 'undefined') {
      this.resizeObserver?.disconnect();
      this.resizeObserver = new ResizeObserver(() => {
        editor.layout();
      });
      this.resizeObserver.observe(container.parentElement ?? container);
    }
    // Track cursor position for status bar
    editor.onDidChangeCursorPosition((e: any) => {
      this.cursorLine = e.position.lineNumber;
      this.cursorCol  = e.position.column;
    });
    // Track dirty state
    editor.onDidChangeModelContent(() => {
      if (this.isEditing) {
        this.isDirty = editor.getValue() !== this.originalContent;
      }
    });
    console.log(`[SUCCESS] ${new Date().toISOString()} WorkspaceTab: Monaco editor ready`);
  }

  closeViewer(): void {
    if (this.isDirty && !confirm('Discard unsaved changes?')) return;
    this.viewerFile      = null;
    this.viewerContent   = '';
    this.viewerError     = '';
    this.contentReady    = false;
    this.pendingContent  = null;
    this.isEditing       = false;
    this.isDirty         = false;
    this.originalContent = '';
    this.isSaving        = false;
    if (this.monacoEditor) {
      this.monacoEditor.setValue('');
      this.monacoEditor.updateOptions({ readOnly: true });
    }
  }

  // ── Edit / Save ────────────────────────────────────────────────────────────

  @HostListener('document:keydown', ['$event'])
  onKeydown(e: KeyboardEvent): void {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      if (this.isEditing && this.isDirty) {
        e.preventDefault();
        this.saveFile();
      }
    }
  }

  toggleEdit(): void {
    if (!this.viewerFile) return;
    if (this.isEditing) {
      if (this.isDirty && !confirm('Discard unsaved changes?')) return;
      this.discardChanges();
      return;
    }
    this.originalContent = this.monacoEditor?.getValue() ?? this.viewerContent;
    this.isEditing = true;
    this.monacoEditor?.updateOptions({ readOnly: false });
    this.monacoEditor?.focus();
    console.log(`[INIT] ${new Date().toISOString()} WorkspaceTab: edit mode ON "${this.viewerFile.name}"`);
  }

  saveFile(): void {
    if (!this.viewerFile || !this.isEditing) return;
    const content = this.monacoEditor?.getValue() ?? this.viewerContent;
    this.isSaving = true;
    console.log(`[INIT] ${new Date().toISOString()} WorkspaceTab: saving "${this.viewerFile.path}"`);
    this.workspaceService.writeFile(this.viewerFile.path, content).subscribe({
      next: () => {
        this.isSaving        = false;
        this.isDirty         = false;
        this.originalContent = content;
        this.viewerContent   = content;
        this.saveNotify      = true;
        setTimeout(() => this.saveNotify = false, 2000);
        console.log(`[SUCCESS] ${new Date().toISOString()} WorkspaceTab: saved "${this.viewerFile!.path}"`);
      },
      error: (err) => {
        this.isSaving = false;
        alert('Save failed: ' + (err.error?.error ?? err.message));
        console.error(`[ERROR] ${new Date().toISOString()} WorkspaceTab: save failed | ${err.message}`);
      },
    });
  }

  discardChanges(): void {
    this.isEditing = false;
    this.isDirty   = false;
    this.monacoEditor?.updateOptions({ readOnly: true });
    this.monacoEditor?.setValue(this.originalContent);
    this.viewerContent   = this.originalContent;
    this.originalContent = '';
    console.log(`[SUCCESS] ${new Date().toISOString()} WorkspaceTab: changes discarded`);
  }

  // ── Theme / editor prefs ───────────────────────────────────────────────────

  setTheme(theme: string): void {
    this.activeTheme = theme;
    (window as any).monaco?.editor?.setTheme(theme);
    console.log(`[SUCCESS] ${new Date().toISOString()} WorkspaceTab: theme → ${theme}`);
  }

  toggleWordWrap(): void {
    this.wordWrap = !this.wordWrap;
    this.monacoEditor?.updateOptions({ wordWrap: this.wordWrap ? 'on' : 'off' });
  }

  toggleMinimap(): void {
    this.minimapOn = !this.minimapOn;
    this.monacoEditor?.updateOptions({ minimap: { enabled: this.minimapOn } });
  }

  setFontSize(delta: number): void {
    this.fontSize = Math.min(30, Math.max(8, this.fontSize + delta));
    this.monacoEditor?.updateOptions({ fontSize: this.fontSize });
    console.log(`[SUCCESS] ${new Date().toISOString()} WorkspaceTab: fontSize → ${this.fontSize}`);
  }

  // ── New file / folder ──────────────────────────────────────────────────────

  showNewFileInput(dirPath: string, type: 'file' | 'directory' = 'file'): void {
    this.showNewInput  = true;
    this.newInputName  = '';
    this.newInputType  = type;
    this.newInputDir   = dirPath || this.treeRootPath;
    this.newInputError = '';
  }

  cancelNewFile(): void {
    this.showNewInput  = false;
    this.newInputName  = '';
    this.newInputError = '';
  }

  confirmNewFile(): void {
    const name = this.newInputName.trim();
    if (!name) { this.newInputError = 'Name is required'; return; }
    if (/[\/\\:*?"<>|]/.test(name)) { this.newInputError = 'Invalid characters'; return; }
    const fullPath = this.newInputDir.replace(/\/+$/, '') + '/' + name;
    this.workspaceService.createFile(fullPath, this.newInputType).subscribe({
      next: () => {
        this.showNewInput = false;
        this.newInputName = '';
        this._loadRoot(this.treeRootPath);
        console.log(`[SUCCESS] ${new Date().toISOString()} WorkspaceTab: created "${fullPath}"`);
      },
      error: (err) => {
        this.newInputError = err.error?.error ?? err.message ?? 'Failed to create';
        console.error(`[ERROR] ${new Date().toISOString()} WorkspaceTab: create failed | ${this.newInputError}`);
      },
    });
  }

  onNewInputKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter') this.confirmNewFile();
    if (e.key === 'Escape') this.cancelNewFile();
  }

  // ── Context (AI) toggles ───────────────────────────────────────────────────

  toggleContext(event: Event, node: FileNode): void {
    event.stopPropagation();
    node.inContext = !node.inContext;
    if (node.type === 'file') {
      if (node.inContext) {
        this.contextFilePaths.add(node.path);
      } else {
        this.contextFilePaths.delete(node.path);
      }
      this.workspaceService.setContextFiles([...this.contextFilePaths]);
    }
    this.nodesData$.next([...this.flatNodes]);
    console.log(`[SUCCESS] ${new Date().toISOString()} WorkspaceTab: context → ${node.name} = ${node.inContext}`);
  }

  resetContext(): void {
    this.contextFilePaths.clear();
    this.workspaceService.clearContextFiles();
    this.flatNodes.forEach(n => (n.inContext = false));
    this.nodesData$.next([...this.flatNodes]);
    console.log(`[SUCCESS] ${new Date().toISOString()} WorkspaceTab: context reset`);
  }

  isCodeFile(name: string): boolean {
    return /\.(ts|js|mjs|py|java|go|rs|c|cpp|h|css|scss|sass|html|json|md|yaml|yml|sh|bash|zsh|txt|env|toml|xml|sql|rb|php|swift|kt|dart)$/i.test(name);
  }

  langFromName(name: string): string {
    return langFromName(name);
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private _loadRoot(rootPath: string): void {
    this.treeLoading  = true;
    this.treeRootPath = rootPath;
    this.flatNodes    = [];
    this.nodesData$.next([]);
    this.workspaceService.getFileTree(rootPath).subscribe({
      next: (items) => {
        this.treeLoading = false;
        this.flatNodes   = this._itemsToNodes(items, 0);
        this.nodesData$.next([...this.flatNodes]);
        console.log(`[SUCCESS] ${new Date().toISOString()} WorkspaceTab: root loaded | ${items.length} items`);
      },
      error: (err) => {
        this.treeLoading = false;
        this.treeError   = err.error?.error ?? err.message ?? 'Failed to list directory.';
        console.error(`[ERROR] ${new Date().toISOString()} WorkspaceTab: root load failed | ${this.treeError}`);
      },
    });
  }

  private _itemsToNodes(items: FileTreeItem[], level: number): FileNode[] {
    return items.map(item => ({
      name:           item.name,
      type:           item.type,
      path:           item.path,
      level,
      expandable:     item.type === 'directory',
      loading:        false,
      inContext:      item.type === 'file' ? this.contextFilePaths.has(item.path) : false,
      childrenLoaded: false,
      children:       [],
    }));
  }

  private _parentPath(p: string): string {
    const norm = p.replace(/\/+$/, '');
    const idx  = norm.lastIndexOf('/');
    if (idx <= 0) return '/';
    return norm.substring(0, idx);
  }

  private _collapseDescendants(node: FileNode): void {
    for (const child of node.children) {
      if (this.treeControl.isExpanded(child)) {
        this._collapseDescendants(child);
        this.treeControl.collapse(child);
      }
    }
  }
}
