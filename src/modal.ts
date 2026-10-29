import { App, Keymap, Modal, Notice, Platform, Scope, TFile, setIcon } from "obsidian";
import { SearchResult, highlightRanges } from "./engine";
import type CrispSearchPlugin from "./main";

const RECENT_LIMIT = 8;

type OpenMode = "current" | "tab" | "split";

interface Item {
  file: TFile;
  result?: SearchResult;
}

interface Action {
  label: string;
  icon: string;
  keys: string[];
  run: (item: Item) => void;
}

const MOD = Platform.isMacOS ? "⌘" : "Ctrl";
const ALT = Platform.isMacOS ? "⌥" : "Alt";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "heic"]);

function iconFor(file: TFile): string {
  if (file.extension === "md") return "file-text";
  if (file.extension === "canvas") return "layout-dashboard";
  if (file.extension === "base") return "table";
  if (file.extension === "pdf") return "file-type";
  if (IMAGE_EXTENSIONS.has(file.extension)) return "image";
  if (["mp3", "m4a", "wav", "ogg", "flac", "webm"].includes(file.extension)) return "audio-lines";
  if (["mp4", "mov", "mkv"].includes(file.extension)) return "film";
  return "file";
}

function renderHighlighted(el: HTMLElement, text: string, ranges: [number, number][]): void {
  let at = 0;
  for (const [start, end] of ranges) {
    if (start > at) el.appendText(text.slice(at, start));
    el.createEl("mark", { text: text.slice(start, end) });
    at = end;
  }
  if (at < text.length) el.appendText(text.slice(at));
}

function renderKeys(el: HTMLElement, keys: string[]): void {
  for (const key of keys) el.createEl("kbd", { text: key });
}

export class LauncherModal extends Modal {
  private readonly plugin: CrispSearchPlugin;
  private input!: HTMLInputElement;
  private statusEl!: HTMLElement;
  private listEl!: HTMLElement;
  private actionsEl!: HTMLElement;
  private items: Item[] = [];
  private rows: HTMLElement[] = [];
  private selected = 0;
  private actionIndex = 0;
  private actionsOpen = false;
  private pointer = { x: -1, y: -1 };
  private stopProgress: (() => void) | null = null;
  private escapeScope: Scope | null = null;
  private readonly actions: Action[];

  constructor(app: App, plugin: CrispSearchPlugin) {
    super(app);
    this.plugin = plugin;
    this.actions = [
      { label: "打开", icon: "file-input", keys: ["↵"], run: (item) => void this.openItem(item, "current") },
      { label: "在新标签页打开", icon: "plus-square", keys: [MOD, "↵"], run: (item) => void this.openItem(item, "tab") },
      { label: "在右侧打开", icon: "columns-2", keys: [MOD, ALT, "↵"], run: (item) => void this.openItem(item, "split") },
      { label: "复制链接", icon: "link", keys: [], run: (item) => this.copyLink(item) },
    ];
  }

  onOpen(): void {
    this.containerEl.addClass("crisp-search-container");
    this.modalEl.addClass("crisp-search-panel");
    this.modalEl.empty();

    const bar = this.modalEl.createDiv("crisp-search-bar");
    setIcon(bar.createSpan("crisp-search-bar-icon"), "search");
    this.input = bar.createEl("input", {
      cls: "crisp-search-input",
      type: "text",
      attr: { placeholder: "搜索笔记和内容…", spellcheck: "false", enterkeyhint: "go" },
    });
    this.statusEl = bar.createSpan("crisp-search-status");

    this.listEl = this.modalEl.createDiv("crisp-search-list");
    this.listEl.setAttr("role", "listbox");

    if (!Platform.isMobile) {
      const footer = this.modalEl.createDiv("crisp-search-footer");
      const open = footer.createDiv("crisp-search-footer-action");
      open.createSpan({ text: "打开" });
      renderKeys(open, ["↵"]);
      open.addEventListener("click", () => this.runAction(0));
      const more = footer.createDiv("crisp-search-footer-action");
      more.createSpan({ text: "操作" });
      renderKeys(more, [MOD, "K"]);
      more.addEventListener("click", () => this.toggleActions());
    }
    this.actionsEl = this.modalEl.createDiv("crisp-search-actions");

    // Chinese IME: while composing, the field holds raw pinyin and Enter only confirms the candidate.
    this.input.addEventListener("input", (evt) => {
      if (!(evt as InputEvent).isComposing) this.update();
    });
    this.input.addEventListener("compositionend", () => this.update());
    this.input.addEventListener("keydown", (evt) => this.onKeyDown(evt));
    this.listEl.addEventListener("mousemove", (evt) => {
      // Chromium replays mousemove when rows re-render under a still pointer; only real movement selects.
      const first = this.pointer.x === -1;
      if (evt.screenX === this.pointer.x && evt.screenY === this.pointer.y) return;
      this.pointer = { x: evt.screenX, y: evt.screenY };
      if (first) return;
      const index = this.rowIndexOf(evt.target);
      if (index !== -1 && index !== this.selected) this.select(index, false);
    });
    this.listEl.addEventListener("click", (evt) => {
      const index = this.rowIndexOf(evt.target);
      if (index === -1) return;
      this.select(index, false);
      void this.openItem(this.items[index], this.modeFor(evt));
    });

    // The modal's own scope closes on Escape before the field sees the key, so a child scope on top
    // takes Escape first: it closes the action menu, and leaves an IME composition to the IME.
    this.escapeScope = new Scope(this.scope);
    this.escapeScope.register([], "Escape", (evt) => {
      if (evt.isComposing) return false;
      if (this.actionsOpen) this.toggleActions(false);
      else this.close();
      return false;
    });
    this.app.keymap.pushScope(this.escapeScope);

    this.stopProgress = this.plugin.onProgress(() => this.onIndexProgress());
    this.renderStatus();
    this.update();
    this.input.focus();
  }

  onClose(): void {
    this.stopProgress?.();
    if (this.escapeScope) this.app.keymap.popScope(this.escapeScope);
  }

  private onIndexProgress(): void {
    this.renderStatus();
    if (this.input.value.trim()) this.update();
  }

  private renderStatus(): void {
    const { ready, indexed, total } = this.plugin;
    this.statusEl.setText(ready ? "" : `索引中 ${indexed}/${total}`);
  }

  private modeFor(evt: MouseEvent | KeyboardEvent): OpenMode {
    if (Keymap.isModEvent(evt) && evt.altKey) return "split";
    if (Keymap.isModEvent(evt)) return "tab";
    return "current";
  }

  private onKeyDown(evt: KeyboardEvent): void {
    if (evt.isComposing || evt.keyCode === 229) return;
    if (evt.key === "k" && Keymap.isModEvent(evt)) {
      evt.preventDefault();
      this.toggleActions();
      return;
    }
    if (this.actionsOpen) {
      if (evt.key === "ArrowDown" || evt.key === "ArrowUp") {
        evt.preventDefault();
        const step = evt.key === "ArrowDown" ? 1 : -1;
        this.actionIndex = (this.actionIndex + step + this.actions.length) % this.actions.length;
        this.renderActions();
      } else if (evt.key === "Enter") {
        evt.preventDefault();
        this.runAction(this.actionIndex);
      }
      return;
    }
    if (evt.key === "ArrowDown" || (evt.ctrlKey && evt.key === "n")) {
      evt.preventDefault();
      this.select(Math.min(this.selected + 1, this.items.length - 1));
    } else if (evt.key === "ArrowUp" || (evt.ctrlKey && evt.key === "p")) {
      evt.preventDefault();
      this.select(Math.max(this.selected - 1, 0));
    } else if (evt.key === "Enter") {
      evt.preventDefault();
      const item = this.items[this.selected];
      if (item) void this.openItem(item, this.modeFor(evt));
    }
  }

  private rowIndexOf(target: EventTarget | null): number {
    const row = target instanceof HTMLElement ? target.closest<HTMLElement>(".crisp-search-item") : null;
    return row ? Number(row.dataset.index) : -1;
  }

  private update(): void {
    const query = this.input.value.trim();
    this.toggleActions(false);
    this.items = query ? this.searchItems(query) : this.recentItems();
    this.selected = 0;
    this.render(query);
  }

  private recentItems(): Item[] {
    const items: Item[] = [];
    for (const path of this.app.workspace.getLastOpenFiles()) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) items.push({ file });
      if (items.length >= RECENT_LIMIT) break;
    }
    return items;
  }

  private searchItems(query: string): Item[] {
    const titles: Item[] = [];
    const bodies: Item[] = [];
    for (const result of this.plugin.engine.search(query)) {
      const file = this.app.vault.getAbstractFileByPath(result.path);
      if (!(file instanceof TFile)) continue;
      (result.kind === "title" ? titles : bodies).push({ file, result });
    }
    return [...titles, ...bodies];
  }

  private render(query: string): void {
    this.listEl.empty();
    this.rows = [];
    this.listEl.scrollTop = 0;
    if (this.items.length === 0) {
      if (query) this.listEl.createDiv({ cls: "crisp-search-empty", text: this.plugin.ready ? "没有结果" : "正在建立索引…" });
      return;
    }
    let section = "";
    this.items.forEach((item, index) => {
      const heading = !query ? "最近" : item.result?.kind === "title" ? "笔记" : "内容";
      if (heading !== section) {
        section = heading;
        this.listEl.createDiv({ cls: "crisp-search-section", text: heading });
      }
      this.rows.push(this.renderRow(item, index, query));
    });
    this.select(0);
  }

  private renderRow(item: Item, index: number, query: string): HTMLElement {
    const { file, result } = item;
    const row = this.listEl.createDiv({ cls: "crisp-search-item", attr: { role: "option", "data-index": String(index) } });
    setIcon(row.createDiv("crisp-search-item-icon"), iconFor(file));
    const text = row.createDiv("crisp-search-item-text");
    const title = text.createSpan("crisp-search-item-title");
    renderHighlighted(title, file.basename, query ? highlightRanges(file.basename, query) : []);
    if (result?.excerpt?.text) {
      renderHighlighted(text.createSpan("crisp-search-item-subtitle"), result.excerpt.text, result.excerpt.ranges);
    }
    const folder = file.parent && !file.parent.isRoot() ? file.parent.name : "";
    if (folder) row.createDiv({ cls: "crisp-search-item-accessory", text: folder, attr: { title: file.path } });
    return row;
  }

  private select(index: number, scroll = true): void {
    this.rows[this.selected]?.removeClass("is-selected");
    this.selected = index;
    const row = this.rows[index];
    if (!row) return;
    row.addClass("is-selected");
    if (scroll) row.scrollIntoView({ block: "nearest" });
  }

  private toggleActions(open = !this.actionsOpen): void {
    if (open && !this.items[this.selected]) return;
    this.actionsOpen = open;
    this.actionIndex = 0;
    this.actionsEl.toggleClass("is-open", open);
    if (open) this.renderActions();
  }

  private renderActions(): void {
    this.actionsEl.empty();
    this.actions.forEach((action, index) => {
      const row = this.actionsEl.createDiv({ cls: "crisp-search-action" });
      row.toggleClass("is-selected", index === this.actionIndex);
      setIcon(row.createSpan("crisp-search-action-icon"), action.icon);
      row.createSpan({ cls: "crisp-search-action-label", text: action.label });
      renderKeys(row.createSpan("crisp-search-action-keys"), action.keys);
      row.addEventListener("mousemove", () => {
        if (this.actionIndex === index) return;
        this.actionIndex = index;
        this.renderActions();
      });
      row.addEventListener("click", () => this.runAction(index));
    });
  }

  private runAction(index: number): void {
    const item = this.items[this.selected];
    if (item) this.actions[index].run(item);
  }

  private async openItem(item: Item, mode: OpenMode): Promise<void> {
    this.close();
    const workspace = this.app.workspace;
    const leaf = mode === "split" ? workspace.getLeaf("split", "vertical") : workspace.getLeaf(mode === "tab" ? "tab" : false);
    const line = item.result?.line;
    await leaf.openFile(item.file, { active: true, eState: line !== undefined ? { line } : undefined });
  }

  private copyLink(item: Item): void {
    const link = this.app.fileManager.generateMarkdownLink(item.file, "");
    void navigator.clipboard.writeText(link).then(
      () => new Notice("已复制链接"),
      () => new Notice("复制失败"),
    );
    this.close();
  }
}
