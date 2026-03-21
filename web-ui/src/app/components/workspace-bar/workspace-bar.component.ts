import { Component, OnInit, OnDestroy } from '@angular/core';
import { BehaviorSubject, Subscription } from 'rxjs';
import { FlatTreeControl } from '@angular/cdk/tree';
import { WorkspaceService, FileTreeItem } from '../../services/workspace.service';

// ─── Tree node model ──────────────────────────────────────────────────────────
export interface FileNode {
  name: string;
  type: 'file' | 'directory';
  path: string;
  level: number;
  expandable: boolean;
  loading: boolean;         // true while fetching children
  inContext: boolean;       // "Include in AI Context" checkbox
  childrenLoaded: boolean;  // prevents duplicate fetches
  children: FileNode[];     // cached for re-expand
}

@Component({
  selector: 'app-workspace-bar',
  templateUrl: './workspace-bar.component.html',
  styleUrls: ['./workspace-bar.component.scss'],
})
export class WorkspaceBarComponent implements OnInit, OnDestroy {
  // ── Bar
  activePath = '';
  pathInput  = '';

  // ── Explorer modal state
  showBrowser     = false;
  browserLoading  = false;
  browserError    = '';
  browserRootPath = '';          // current view root (independent of activePath)
  selectedNode: FileNode | null = null;  // last-clicked file node

  // Tracks all inContext file paths across the full tree (survives collapse)
  private contextFilePaths = new Set<string>();

  // ── CDK Flat Tree
  flatNodes: FileNode[] = [];
  nodesData$ = new BehaviorSubject<FileNode[]>([]);

  treeControl = new FlatTreeControl<FileNode>(
    node => node.level,
    node => node.expandable,
  );

  /** CDK *cdkTreeNodeDef when predicate — directories are expandable. */
  hasChild = (_: number, node: FileNode): boolean => node.expandable;

  private sub!: Subscription;

  constructor(public workspaceService: WorkspaceService) {
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

  // ── Browser modal ──────────────────────────────────────────────────────────

  openBrowser(): void {
    this.showBrowser  = true;
    this.browserError = '';
    // Do NOT clear contextFilePaths here — selections survive close/reopen
    this._loadRoot(this.activePath || '/');
    console.log(`[INIT] ${new Date().toISOString()} WorkspaceBar: opening explorer at "${this.activePath}"`);
  }

  /** Navigate the tree view one directory up without changing the workspace root. */
  navigateToParent(): void {
    const parent = this._parentPath(this.browserRootPath);
    if (parent === this.browserRootPath) return;
    this.browserError = '';
    this._loadRoot(parent);
    console.log(`[INIT] ${new Date().toISOString()} WorkspaceBar: navigating up to "${parent}"`);
  }

  closeBrowser(): void {
    this.showBrowser = false;
  }

  /** Navigate inside a folder — reloads the tree rooted at that folder. */
  navigateInto(node: FileNode): void {
    if (node.type !== 'directory') return;
    this.browserError = '';
    this._loadRoot(node.path);
    console.log(`[INIT] ${new Date().toISOString()} WorkspaceBar: navigating into "${node.path}"`);
  }

  /** Pin a directory as the active workspace root (does NOT close the explorer). */
  setAsRoot(node: FileNode): void {
    if (node.type !== 'directory') return;
    this.workspaceService.setPath(node.path);
    console.log(`[SUCCESS] ${new Date().toISOString()} WorkspaceBar: workspace root set to "${node.path}"`);
  }

  /** Click a file node to select / deselect it (shows info strip in footer). */
  selectFile(node: FileNode): void {
    if (node.type !== 'file') return;
    this.selectedNode = (this.selectedNode === node) ? null : node;
    console.log(`[SUCCESS] ${new Date().toISOString()} WorkspaceBar: file selected "${node.path}"`);
  }

  clearSelection(): void {
    this.selectedNode = null;
  }

  /** Remove ALL files from AI context and reset every visible node's inContext flag. */
  resetContext(): void {
    this.contextFilePaths.clear();
    this.workspaceService.clearContextFiles();
    this.flatNodes.forEach(n => n.inContext = false);
    this.nodesData$.next([...this.flatNodes]);
    this.selectedNode = null;
    console.log(`[SUCCESS] ${new Date().toISOString()} WorkspaceBar: context reset — all files cleared`);
  }

  /** Returns true for text/code extensions to use a coloured icon. */
  isCodeFile(name: string): boolean {
    return /\.(ts|js|mjs|py|java|go|rs|c|cpp|h|css|scss|sass|html|json|md|yaml|yml|sh|bash|zsh|txt|env|toml|xml|sql|rb|php|swift|kt|dart)$/i.test(name);
  }

  // ── Tree – lazy expand / collapse ─────────────────────────────────────────

  toggleNode(node: FileNode): void {
    if (!node.expandable || node.loading) return;

    if (this.treeControl.isExpanded(node)) {
      // ── Collapse: recursively un-expand descendants, remove from flat list ──
      this._collapseDescendants(node);
      this.treeControl.collapse(node);
      const idx = this.flatNodes.indexOf(node);
      let endIdx = idx + 1;
      while (endIdx < this.flatNodes.length && this.flatNodes[endIdx].level > node.level) {
        endIdx++;
      }
      this.flatNodes.splice(idx + 1, endIdx - idx - 1);
      this.nodesData$.next([...this.flatNodes]);
      console.log(`[SUCCESS] ${new Date().toISOString()} WorkspaceBar: collapsed "${node.name}"`);

    } else {
      // ── Expand ──────────────────────────────────────────────────────────────
      this.treeControl.expand(node);

      if (node.childrenLoaded) {
        // Re-insert cached immediate children (they start collapsed again)
        const idx = this.flatNodes.indexOf(node);
        this.flatNodes.splice(idx + 1, 0, ...node.children);
        this.nodesData$.next([...this.flatNodes]);
      } else {
        // Lazy fetch from backend
        node.loading = true;
        this.nodesData$.next([...this.flatNodes]);   // show spinner immediately

        this.workspaceService.getFileTree(node.path).subscribe({
          next: (items) => {
            node.loading        = false;
            node.childrenLoaded = true;
            const children      = this._itemsToNodes(items, node.level + 1);
            node.children       = children;
            const idx           = this.flatNodes.indexOf(node);
            this.flatNodes.splice(idx + 1, 0, ...children);
            this.nodesData$.next([...this.flatNodes]);
            console.log(`[SUCCESS] ${new Date().toISOString()} WorkspaceBar: loaded ${children.length} children for "${node.name}"`);
          },
          error: (err) => {
            node.loading = false;
            this.treeControl.collapse(node);
            this.nodesData$.next([...this.flatNodes]);
            console.error(`[ERROR] ${new Date().toISOString()} WorkspaceBar: failed loading "${node.path}" | ${err.message}`);
          },
        });
      }
    }
  }

  isExpanded(node: FileNode): boolean {
    return this.treeControl.isExpanded(node);
  }

  toggleContext(event: Event, node: FileNode): void {
    event.stopPropagation();
    node.inContext = !node.inContext;

    // Only files contribute to the context-files list
    if (node.type === 'file') {
      if (node.inContext) {
        this.contextFilePaths.add(node.path);
      } else {
        this.contextFilePaths.delete(node.path);
      }
      this.workspaceService.setContextFiles([...this.contextFilePaths]);
    }

    this.nodesData$.next([...this.flatNodes]);
    console.log(`[SUCCESS] ${new Date().toISOString()} WorkspaceBar: context toggled for "${node.name}" → ${node.inContext} | total files: ${this.contextFilePaths.size}`);
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private _loadRoot(rootPath: string): void {
    this.browserLoading  = true;
    this.browserRootPath = rootPath;
    this.selectedNode    = null;
    this.flatNodes       = [];
    this.nodesData$.next([]);
    this.workspaceService.getFileTree(rootPath).subscribe({
      next: (items) => {
        this.browserLoading = false;
        this.flatNodes      = this._itemsToNodes(items, 0);
        this.nodesData$.next([...this.flatNodes]);
        console.log(`[SUCCESS] ${new Date().toISOString()} WorkspaceBar: root loaded | ${items.length} items`);
      },
      error: (err) => {
        this.browserLoading = false;
        this.browserError   = err.error?.error ?? err.message ?? 'Failed to list directory.';
        console.error(`[ERROR] ${new Date().toISOString()} WorkspaceBar: root load failed | ${this.browserError}`);
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
      // Restore checked state from the persisted Set
      inContext:      item.type === 'file'
                        ? this.contextFilePaths.has(item.path)
                        : false,
      childrenLoaded: false,
      children:       [],
    }));
  }

  /** Computes the parent path of p (handles trailing slashes, stops at '/'). */
  private _parentPath(p: string): string {
    const norm = p.replace(/\/+$/, '');
    const idx  = norm.lastIndexOf('/');
    if (idx <= 0) return '/';
    return norm.substring(0, idx);
  }

  /** Recursively marks all expanded descendants as collapsed in treeControl
   *  so their expanded state is reset before they are removed from the flat list. */
  private _collapseDescendants(node: FileNode): void {
    for (const child of node.children) {
      if (this.treeControl.isExpanded(child)) {
        this._collapseDescendants(child);
        this.treeControl.collapse(child);
      }
    }
  }
}
