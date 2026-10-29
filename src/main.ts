import { CachedMetadata, Command, Hotkey, Plugin, TAbstractFile, TFile, getAllTags, parseFrontMatterAliases } from "obsidian";
import { SearchDoc, SearchEngine } from "./engine";
import { LauncherModal } from "./modal";

const RECENT_COMMAND_LIMIT = 20;

// Obsidian has no public API to list, look up hotkeys for or run commands; every launcher uses these.
interface CommandHost {
  commands: { commands: Record<string, Command>; executeCommandById(id: string): boolean };
  hotkeyManager?: { getHotkeys(id: string): Hotkey[] | undefined; getDefaultHotkeys(id: string): Hotkey[] | undefined };
}

// Each indexing slice gives the main thread back after this long, so typing never stalls.
const SLICE_MS = 12;

// A message-channel task, not setTimeout: Chromium clamps timers in a background window to about one per
// second, which made a full index of a 3,800-file vault take over an hour while Obsidian was not in front.
function sliceBreak(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

export default class CrispSearchPlugin extends Plugin {
  readonly engine = new SearchEngine();
  indexed = 0;
  total = 0;
  ready = false;
  failed: string[] = [];
  recentCommands: string[] = [];
  // False when data.json exists but could not be read: saving then would overwrite it with defaults.
  private dataWritable = true;
  private generation = 0;
  private progressListeners = new Set<() => void>();
  private unloaded = false;

  async onload(): Promise<void> {
    const data: unknown = await this.loadData();
    if (data === undefined) {
      this.dataWritable = false;
      console.warn("Crisp Search: data.json could not be read; recent commands will not be saved this session");
    } else {
      const recent = (data as { recentCommands?: unknown } | null)?.recentCommands;
      if (Array.isArray(recent)) {
        this.recentCommands = recent.filter((id): id is string => typeof id === "string").slice(0, RECENT_COMMAND_LIMIT);
      }
    }
    this.addCommand({ id: "open", name: "打开搜索面板", callback: () => this.openLauncher() });
    this.addCommand({ id: "rebuild-index", name: "重建搜索索引", callback: () => void this.rebuildIndex() });
    this.addRibbonIcon("search", "Crisp Search", () => this.openLauncher());
    this.app.workspace.onLayoutReady(() => {
      this.watchVault();
      void this.rebuildIndex();
    });
  }

  onunload(): void {
    this.unloaded = true;
    this.progressListeners.clear();
  }

  openLauncher(): void {
    new LauncherModal(this.app, this).open();
  }

  listCommands(): Command[] {
    return Object.values((this.app as unknown as CommandHost).commands.commands);
  }

  hotkeysFor(id: string): Hotkey[] {
    const manager = (this.app as unknown as CommandHost).hotkeyManager;
    return manager?.getHotkeys(id) ?? manager?.getDefaultHotkeys(id) ?? [];
  }

  executeCommand(id: string): void {
    (this.app as unknown as CommandHost).commands.executeCommandById(id);
  }

  recordCommand(id: string): void {
    this.recentCommands = [id, ...this.recentCommands.filter((other) => other !== id)].slice(0, RECENT_COMMAND_LIMIT);
    if (this.dataWritable) void this.saveData({ recentCommands: this.recentCommands });
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

  // Registered once the layout is ready, so the vault's start-up create events are not replayed here.
  private watchVault(): void {
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
        if (this.isIgnored(file.path)) this.engine.remove(file.path);
        else if (this.ready || this.engine.has(file.path)) this.upsert(file, data, cache);
      }),
    );
  }

  // Re-reads every file. Results stay searchable meanwhile; files gone from the vault are dropped at the end.
  async rebuildIndex(): Promise<void> {
    const generation = ++this.generation;
    const files = this.app.vault.getFiles().filter((file) => !this.isIgnored(file.path));
    this.ready = false;
    this.indexed = 0;
    this.total = files.length;
    const failed: string[] = [];
    this.emitProgress();
    let sliceStart = performance.now();
    for (const file of files) {
      if (this.unloaded || generation !== this.generation) return;
      try {
        await this.indexFile(file);
      } catch (error) {
        // One unreadable file must not stop the rest of the vault from being indexed.
        console.warn(`Crisp Search: could not index ${file.path}`, error);
        this.engine.remove(file.path);
        failed.push(file.path);
      }
      this.indexed++;
      if (performance.now() - sliceStart > SLICE_MS) {
        this.emitProgress();
        await sliceBreak();
        sliceStart = performance.now();
      }
    }
    if (this.unloaded || generation !== this.generation) return;
    // Judge against the vault as it is now: files created during the pass are indexed by their own events.
    const kept = new Set(this.app.vault.getFiles().filter((file) => !this.isIgnored(file.path)).map((file) => file.path));
    for (const path of this.engine.paths()) if (!kept.has(path)) this.engine.remove(path);
    this.failed = failed;
    this.ready = true;
    this.emitProgress();
  }

  private onFileEvent(file: TAbstractFile): void {
    if (file instanceof TFile) {
      this.indexFile(file).catch((error) => console.warn(`Crisp Search: could not index ${file.path}`, error));
    }
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
