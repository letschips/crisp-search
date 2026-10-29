import {
  CachedMetadata,
  Command,
  Hotkey,
  Notice,
  Plugin,
  TAbstractFile,
  TFile,
  addIcon,
  getAllTags,
  parseFrontMatterAliases,
} from "obsidian";
import { preserveUnreadableData, verifyDataWrite } from "./data-safety";
import { SearchDoc, SearchEngine } from "./engine";
import { CRISP_SEARCH_ICON, CRISP_SEARCH_ICON_SVG } from "./icon";
import { discoverVaultCrispLicenses, verifyLicenseCode } from "./license";
import { ActivationOutcome, LicenseController, LicenseResult } from "./license-controller";
import { LauncherModal } from "./modal";
import { CrispSearchSettingTab } from "./settings-tab";

const PLUGIN_ID = "crisp-search";

export interface SearchSettings {
  licenseCode: string;
  recentCommands: string[];
}

function normalizeSettings(raw: unknown): SearchSettings {
  const data = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const recent = Array.isArray(data.recentCommands) ? data.recentCommands : [];
  return {
    licenseCode: typeof data.licenseCode === "string" ? data.licenseCode : "",
    recentCommands: recent.filter((id): id is string => typeof id === "string").slice(0, RECENT_COMMAND_LIMIT),
  };
}

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
  // Files that are not in the index because their last read failed; cleared as soon as one indexes.
  private readonly failures = new Set<string>();
  private changeQueued = false;
  settings: SearchSettings = normalizeSettings(null);
  // data.json could not be read and could not be backed up: nothing is written this session.
  private dataWriteBlocked = false;
  private saveErrorShown = false;
  private indexStarted = false;
  private settingTab: CrispSearchSettingTab | null = null;
  private generation = 0;
  // Bumped by every index write for a path; a read that finishes after a newer write is dropped.
  private readonly versions = new Map<string, number>();
  private saving: Promise<boolean> = Promise.resolve(true);
  private readonly licenseController = new LicenseController({
    verify: (code, online) => this.checkLicense(code, online),
    discover: () => discoverVaultCrispLicenses(this.app, PLUGIN_ID),
    getCode: () => this.settings.licenseCode,
    persistCode: (code) => {
      this.settings.licenseCode = code;
      return this.saveSettings();
    },
    onChange: () => this.onLicenseChange(),
  });
  private progressListeners = new Set<() => void>();
  private unloaded = false;

  get recentCommands(): string[] {
    return this.settings.recentCommands;
  }

  get license(): LicenseResult {
    return this.licenseController.state;
  }

  /** Searching needs an activated licence; the index is only built once one is in place. */
  get licensed(): boolean {
    return this.licenseController.licensed;
  }

  get licenseUnsaved(): boolean {
    return this.licenseController.unsaved;
  }

  async onload(): Promise<void> {
    const raw: unknown = await this.loadData();
    await this.protectUnreadableData(raw);
    this.settings = normalizeSettings(raw);
    // Startup stays local: only the embedded-key signature check, the online check runs later.
    await this.licenseController.loadLocal();
    this.registerInterval(window.setInterval(() => this.licenseController.checkExpiry(), 60_000));

    addIcon(CRISP_SEARCH_ICON, CRISP_SEARCH_ICON_SVG);
    this.settingTab = new CrispSearchSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);
    this.addCommand({ id: "open", name: "打开搜索面板", callback: () => this.openLauncher() });
    this.addCommand({
      id: "rebuild-index",
      name: "重建搜索索引",
      callback: () => {
        if (this.licensed) void this.rebuildIndex();
        else new Notice("Crisp Search 需要激活后才能使用");
      },
    });
    this.addRibbonIcon(CRISP_SEARCH_ICON, "Crisp Search", () => this.openLauncher());
    this.app.workspace.onLayoutReady(() => {
      // Obsidian queues this callback; the plugin may have been disabled or reloaded before it runs.
      if (this.unloaded) return;
      this.watchVault();
      this.startIndexIfLicensed();
      void this.licenseController.refreshInBackground().catch((error) => {
        console.debug("Crisp Search background license check failed", error);
      });
    });
  }

  onunload(): void {
    this.unloaded = true;
    this.licenseController.dispose();
    this.progressListeners.clear();
  }

  // Never overwrite a data.json that could not be read and could not be backed up either,
  // and never write from an instance that has already been unloaded.
  async saveData(data: unknown): Promise<void> {
    if (this.dataWriteBlocked || this.unloaded) return;
    await super.saveData(data);
  }

  /**
   * Saves one after another and reads data.json back, because Obsidian's saveData() swallows write
   * errors. Resolves false (after one notice) when the write could not be confirmed.
   */
  saveSettings(): Promise<boolean> {
    const operation = this.saving.then(async () => {
      // Taken when the write starts, so it includes every change made while this save waited.
      const snapshot = JSON.parse(JSON.stringify(this.settings)) as SearchSettings;
      if (this.unloaded || this.dataWriteBlocked) return false;
      try {
        await this.saveData(snapshot);
        await verifyDataWrite(this.app.vault?.adapter, `${this.manifest?.dir}/data.json`, snapshot);
        this.saveErrorShown = false;
        return true;
      } catch (error) {
        console.debug("Crisp Search settings save failed", error);
        if (!this.saveErrorShown) {
          this.saveErrorShown = true;
          new Notice("Crisp Search：设置没有写入磁盘，重启后会丢失。下次修改时会再试。");
        }
        return false;
      }
    });
    this.saving = operation.catch(() => false);
    return operation;
  }

  activate(code: string): Promise<ActivationOutcome> {
    return this.licenseController.activate(code);
  }

  retrySaveLicense(): Promise<boolean> {
    return this.licenseController.retrySave();
  }

  clearLicense(): Promise<boolean> {
    return this.licenseController.clear();
  }

  openSettings(): void {
    const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
    setting?.open();
    setting?.openTabById(this.manifest.id);
  }

  private async checkLicense(code: string, online: boolean): Promise<LicenseResult> {
    const result = await verifyLicenseCode(code, PLUGIN_ID, online ? undefined : { online: false });
    return { valid: result.valid, payload: result.payload, reason: result.reason };
  }

  private onLicenseChange(): void {
    this.settingTab?.display();
    this.startIndexIfLicensed();
    // An open panel switches between the activation prompt and search.
    this.emitProgress();
  }

  private startIndexIfLicensed(): void {
    if (this.indexStarted || !this.licensed || this.unloaded || !this.app.workspace.layoutReady) return;
    this.indexStarted = true;
    void this.rebuildIndex();
  }

  // loadData() yields undefined when data.json exists but cannot be read; keep a copy before defaults take over.
  private async protectUnreadableData(raw: unknown): Promise<void> {
    if (raw !== undefined) return;
    const result = await preserveUnreadableData(this.app.vault?.adapter, `${this.manifest?.dir}/data.json`);
    if (result.state === "preserved") {
      new Notice(`Crisp Search 的设置文件无法读取，已备份为 ${result.backupPath.split("/").pop()} 并恢复默认设置。`, 12000);
    } else if (result.state === "failed") {
      this.dataWriteBlocked = true;
      console.error("Crisp Search could not back up unreadable data.json", result.error);
      new Notice("Crisp Search 的设置文件无法读取，也无法备份。为保护原文件，本次运行不会保存设置。", 0);
    }
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

  // True when the host found and ran the command; it does not report what the command achieved.
  executeCommand(id: string): boolean {
    return (this.app as unknown as CommandHost).commands.executeCommandById(id);
  }

  recordCommand(id: string): void {
    this.settings.recentCommands = [id, ...this.settings.recentCommands.filter((other) => other !== id)].slice(
      0,
      RECENT_COMMAND_LIMIT,
    );
    void this.saveSettings();
  }

  onProgress(listener: () => void): () => void {
    this.progressListeners.add(listener);
    return () => this.progressListeners.delete(listener);
  }

  get failed(): string[] {
    return [...this.failures];
  }

  private emitProgress(): void {
    for (const listener of this.progressListeners) listener();
  }

  // Edits arrive in bursts (a save, a sync); listeners hear about each burst once.
  private notifyChange(): void {
    if (this.changeQueued) return;
    this.changeQueued = true;
    queueMicrotask(() => {
      this.changeQueued = false;
      if (!this.unloaded) this.emitProgress();
    });
  }

  isIgnored(path: string): boolean {
    const cache = this.app.metadataCache as unknown as { isUserIgnored?: (path: string) => boolean };
    return cache.isUserIgnored?.(path) ?? false;
  }

  // Registered once the layout is ready, so the vault's start-up create events are not replayed here.
  private watchVault(): void {
    this.registerEvent(this.app.vault.on("create", (file) => this.onFileEvent(file)));
    this.registerEvent(this.app.vault.on("delete", (file) => this.removePath(file.path)));
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        this.removePath(oldPath);
        this.onFileEvent(file);
      }),
    );
    // The event carries the file's current text, so it is applied at once and outdates pending reads.
    this.registerEvent(
      this.app.metadataCache.on("changed", (file, data, cache) => {
        this.bump(file.path);
        if (this.isIgnored(file.path)) this.removePath(file.path);
        else this.upsert(file, data, cache);
        this.notifyChange();
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
    this.emitProgress();
    let sliceStart = performance.now();
    const current = () => !this.unloaded && generation === this.generation;
    for (const file of files) {
      if (!current()) return;
      try {
        await this.indexFile(file, current);
      } catch (error) {
        // One unreadable file must not stop the rest of the vault from being indexed.
        console.warn(`Crisp Search: could not index ${file.path}`, error);
        this.engine.remove(file.path);
        this.failures.add(file.path);
      }
      if (!current()) return;
      this.indexed++;
      if (performance.now() - sliceStart > SLICE_MS) {
        this.emitProgress();
        await sliceBreak();
        sliceStart = performance.now();
      }
    }
    if (!current()) return;
    // Judge against the vault as it is now: files created during the pass are indexed by their own events.
    const kept = new Set(this.app.vault.getFiles().filter((file) => !this.isIgnored(file.path)).map((file) => file.path));
    for (const path of this.engine.paths()) if (!kept.has(path)) this.engine.remove(path);
    for (const path of this.failures) if (!kept.has(path)) this.failures.delete(path);
    this.ready = true;
    this.emitProgress();
  }

  private onFileEvent(file: TAbstractFile): void {
    if (!(file instanceof TFile)) return;
    const path = file.path;
    this.indexFile(file)
      .catch((error) => {
        console.warn(`Crisp Search: could not index ${path}`, error);
        this.failures.add(path);
      })
      .finally(() => this.notifyChange());
  }

  private bump(path: string): number {
    const version = (this.versions.get(path) ?? 0) + 1;
    this.versions.set(path, version);
    return version;
  }

  private removePath(path: string): void {
    this.bump(path);
    this.engine.remove(path);
    this.failures.delete(path);
    this.notifyChange();
  }

  // Throws only for a read failure that is still current; outdated reads are dropped silently.
  private async indexFile(file: TFile, current: () => boolean = () => true): Promise<void> {
    // The TFile is renamed in place, so the path is fixed now: after a rename this read belongs to no one.
    const path = file.path;
    const version = this.bump(path);
    const fresh = () => current() && file.path === path && this.versions.get(path) === version;
    if (this.isIgnored(file.path)) {
      this.engine.remove(file.path);
      return;
    }
    if (file.extension !== "md") {
      this.upsert(file, "", null);
      return;
    }
    let content: string;
    try {
      content = await this.app.vault.cachedRead(file);
    } catch (error) {
      if (fresh()) throw error;
      return;
    }
    // A newer pass or event has written this path, or the file was deleted while it was being read.
    if (!fresh() || this.app.vault.getAbstractFileByPath(path) !== file) return;
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
    this.failures.delete(file.path);
  }
}
