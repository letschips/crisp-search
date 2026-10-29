import { CachedMetadata, Plugin, TAbstractFile, TFile, getAllTags, parseFrontMatterAliases } from "obsidian";
import { SearchDoc, SearchEngine } from "./engine";
import { LauncherModal } from "./modal";

// Each indexing slice gives the main thread back after this long, so typing never stalls.
const SLICE_MS = 12;

function sliceBreak(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

export default class CrispSearchPlugin extends Plugin {
  readonly engine = new SearchEngine();
  indexed = 0;
  total = 0;
  ready = false;
  private progressListeners = new Set<() => void>();
  private unloaded = false;

  async onload(): Promise<void> {
    this.addCommand({ id: "open", name: "打开搜索面板", callback: () => this.openLauncher() });
    this.addRibbonIcon("search", "Crisp Search", () => this.openLauncher());
    this.app.workspace.onLayoutReady(() => void this.buildIndex());
  }

  onunload(): void {
    this.unloaded = true;
    this.progressListeners.clear();
  }

  openLauncher(): void {
    new LauncherModal(this.app, this).open();
  }

  onProgress(listener: () => void): () => void {
    this.progressListeners.add(listener);
    return () => this.progressListeners.delete(listener);
  }

  private emitProgress(): void {
    for (const listener of this.progressListeners) listener();
  }

  isIgnored(path: string): boolean {
    const cache = this.app.metadataCache as unknown as { isUserIgnored?: (path: string) => boolean };
    return cache.isUserIgnored?.(path) ?? false;
  }

  private async buildIndex(): Promise<void> {
    // Watch first, so edits made while the initial pass runs are not lost.
    this.registerEvent(this.app.vault.on("create", (file) => this.onFileEvent(file)));
    this.registerEvent(this.app.vault.on("delete", (file) => this.engine.remove(file.path)));
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        this.engine.remove(oldPath);
        this.onFileEvent(file);
      }),
    );
    this.registerEvent(
      this.app.metadataCache.on("changed", (file, data, cache) => {
        if (this.ready || this.engine.has(file.path)) this.upsert(file, data, cache);
      }),
    );

    const files = this.app.vault.getFiles().filter((file) => !this.isIgnored(file.path));
    this.total = files.length;
    let sliceStart = performance.now();
    for (const file of files) {
      if (this.unloaded) return;
      await this.indexFile(file);
      this.indexed++;
      if (performance.now() - sliceStart > SLICE_MS) {
        this.emitProgress();
        await sliceBreak();
        sliceStart = performance.now();
      }
    }
    this.ready = true;
    this.emitProgress();
  }

  private onFileEvent(file: TAbstractFile): void {
    if (file instanceof TFile) void this.indexFile(file);
  }

  private async indexFile(file: TFile): Promise<void> {
    if (this.isIgnored(file.path)) {
      this.engine.remove(file.path);
      return;
    }
    if (file.extension !== "md") {
      this.upsert(file, "", null);
      return;
    }
    const content = await this.app.vault.cachedRead(file);
    // The file may have been deleted while it was being read.
    if (this.app.vault.getAbstractFileByPath(file.path) !== file) return;
    this.upsert(file, content, this.app.metadataCache.getFileCache(file));
  }

  private upsert(file: TFile, content: string, cache: CachedMetadata | null): void {
    const doc: SearchDoc = {
      path: file.path,
      basename: file.basename,
      extension: file.extension,
      content,
      headings: (cache?.headings ?? []).map((h) => ({ text: h.heading, line: h.position.start.line })),
      tags: cache ? (getAllTags(cache) ?? []).map((tag) => tag.replace(/^#/, "")) : [],
      aliases: parseFrontMatterAliases(cache?.frontmatter ?? null) ?? [],
    };
    this.engine.upsert(doc);
  }
}
