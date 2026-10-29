import { App, Command, Hotkey, Keymap, Modal, Notice, Platform, Scope, TFile, setIcon } from "obsidian";
import { CommandIndex, CommandMatch } from "./commands";
import { SearchResult, highlightRanges } from "./engine";
import type CrispSearchPlugin from "./main";

const RECENT_LIMIT = 8;
// Commands shown among note results; the ">" prefix lists all of them.
const MIXED_COMMAND_LIMIT = 4;
const COMMAND_PREFIX = /^[>》]/;
let instanceCount = 0;

type OpenMode = "current" | "tab" | "split";

interface FileItem {
  type: "file";
  section: string;
  file: TFile;
  result?: SearchResult;
}

interface CommandItem {
  type: "command";
  section: string;
  command: Command;
  match: CommandMatch;
}

type Item = FileItem | CommandItem;

interface Action<T extends Item = Item> {
  label: string;
  icon: string;
  keys: string[];
  run: (item: T) => void;
}

const MOD = Platform.isMacOS ? "⌘" : "Ctrl";
const ALT = Platform.isMacOS ? "⌥" : "Alt";
const MODIFIER_KEYS: Record<string, string> = Platform.isMacOS
  ? { Mod: "⌘", Ctrl: "⌃", Meta: "⌘", Alt: "⌥", Shift: "⇧" }
  : { Mod: "Ctrl", Ctrl: "Ctrl", Meta: "Win", Alt: "Alt", Shift: "Shift" };
const KEY_NAMES: Record<string, string> = { ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Enter: "↵", " ": "Space" };

function hotkeyKeys(hotkey: Hotkey): string[] {
  const key = KEY_NAMES[hotkey.key] ?? (hotkey.key.length === 1 ? hotkey.key.toUpperCase() : hotkey.key);
  return [...hotkey.modifiers.map((m) => MODIFIER_KEYS[m] ?? m), key];
}

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
  private idPrefix = "";
  private readonly fileActions: Action<FileItem>[];
  private readonly commandActions: Action<CommandItem>[];
  private primaryLabel: HTMLElement | null = null;
  private commands: Map<string, Command> | null = null;
  private commandIndex: CommandIndex | null = null;

  constructor(app: App, plugin: CrispSearchPlugin) {
    super(app);
    this.plugin = plugin;
    this.fileActions = [
      { label: "打开", icon: "file-input", keys: ["↵"], run: (item) => void this.openFile(item, "current") },
      { label: "在新标签页打开", icon: "plus-square", keys: [MOD, "↵"], run: (item) => void this.openFile(item, "tab") },
      { label: "在右侧打开", icon: "columns-2", keys: [MOD, ALT, "↵"], run: (item) => void this.openFile(item, "split") },
      { label: "复制链接", icon: "link", keys: [], run: (item) => this.copyLink(item) },
    ];
    this.commandActions = [
      { label: "运行", icon: "play", keys: ["↵"], run: (item) => this.runCommand(item) },
      { label: "复制命令 ID", icon: "copy", keys: [], run: (item) => this.copyCommandId(item) },
    ];
  }

  onOpen(): void {
    this.containerEl.addClass("crisp-search-container");
    this.modalEl.addClass("crisp-search-panel");
    this.modalEl.empty();

    const bar = this.modalEl.createDiv("crisp-search-bar");
    setIcon(bar.createSpan("crisp-search-bar-icon"), "search");
    this.idPrefix = `crisp-search-${++instanceCount}`;
    this.input = bar.createEl("input", {
      cls: "crisp-search-input",
      type: "text",
      attr: {
        placeholder: "搜索笔记、内容和命令…",
        spellcheck: "false",
        enterkeyhint: "go",
        role: "combobox",
        "aria-label": "搜索笔记、内容和命令",
        "aria-expanded": "true",
        "aria-autocomplete": "list",
        "aria-controls": `${this.idPrefix}-list`,
      },
    });
    this.statusEl = bar.createSpan("crisp-search-status");

    this.listEl = this.modalEl.createDiv({ cls: "crisp-search-list", attr: { id: `${this.idPrefix}-list`, role: "listbox" } });

    if (!Platform.isMobile) {
      const footer = this.modalEl.createDiv("crisp-search-footer");
      const open = footer.createDiv("crisp-search-footer-action");
      this.primaryLabel = open.createSpan({ text: "打开" });
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
      this.activate(this.items[index], this.modeFor(evt));
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
    if (this.input.value.trim() && !this.commandMode()) this.update();
  }

  private commandMode(): boolean {
    return COMMAND_PREFIX.test(this.input.value.trimStart());
  }

  private renderStatus(): void {
    const { ready, indexed, total, failed } = this.plugin;
    if (!ready) this.statusEl.setText(`索引中 ${indexed}/${total}`);
    else this.statusEl.setText(failed.length ? `${failed.length} 个文件未能索引` : "");
    this.statusEl.setAttr("title", ready && failed.length ? `${failed.slice(0, 20).join("\n")}\n\n运行「重建搜索索引」重试` : "");
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
        const count = this.actionsFor(this.items[this.selected]).length;
        this.actionIndex = (this.actionIndex + step + count) % count;
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
      if (item) this.activate(item, this.modeFor(evt));
    }
  }

  private rowIndexOf(target: EventTarget | null): number {
    const row = target instanceof HTMLElement ? target.closest<HTMLElement>(".crisp-search-item") : null;
    return row ? Number(row.dataset.index) : -1;
  }

  private update(): void {
    const raw = this.input.value.trimStart();
    const commandMode = COMMAND_PREFIX.test(raw);
    const query = (commandMode ? raw.slice(1) : raw).trim();
    this.toggleActions(false);
    if (commandMode) this.items = this.commandItems(query, Infinity);
    else this.items = query ? this.searchItems(query) : this.recentItems();
    this.selected = 0;
    this.render(query, commandMode);
  }

  private recentItems(): Item[] {
    const items: Item[] = [];
    for (const path of this.app.workspace.getLastOpenFiles()) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile && !this.plugin.isIgnored(file.path)) items.push({ type: "file", section: "最近", file });
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
      if (result.kind === "title") titles.push({ type: "file", section: "笔记", file, result });
      else bodies.push({ type: "file", section: "内容", file, result });
    }
    return [...titles, ...this.commandItems(query, MIXED_COMMAND_LIMIT), ...bodies];
  }

  // Only commands that can run right now, judged once per panel: the active note does not change while it is open.
  private availableCommands(): Map<string, Command> {
    if (this.commands) return this.commands;
    const editor = this.app.workspace.activeEditor;
    const available = new Map<string, Command>();
    for (const command of this.plugin.listCommands()) {
      if (command.id.startsWith(`${this.plugin.manifest.id}:open`)) continue;
      let ok = true;
      try {
        if (command.checkCallback) ok = command.checkCallback(true) !== false;
        else if (command.editorCheckCallback) {
          ok = !!editor?.editor && command.editorCheckCallback(true, editor.editor, editor) !== false;
        } else if (command.editorCallback) ok = !!editor?.editor;
      } catch {
        ok = false;
      }
      if (ok) available.set(command.id, command);
    }
    this.commands = available;
    return available;
  }

  private commandItems(query: string, limit: number): Item[] {
    const commands = this.availableCommands();
    this.commandIndex ??= new CommandIndex([...commands.values()].map(({ id, name }) => ({ id, name })));
    const recent = this.plugin.recentCommands;
    const items: Item[] = [];
    for (const match of this.commandIndex.search(query, recent)) {
      if (items.length >= limit) break;
      const section = !query && recent.includes(match.id) ? "最近使用" : "命令";
      items.push({ type: "command", section, command: commands.get(match.id)!, match });
    }
    return items;
  }

  private render(query: string, commandMode: boolean): void {
    this.listEl.empty();
    this.rows = [];
    this.input.removeAttribute("aria-activedescendant");
    this.listEl.scrollTop = 0;
    if (this.items.length === 0) {
      if (query || commandMode) {
        const text = commandMode || this.plugin.ready ? "没有结果" : "正在建立索引…";
        this.listEl.createDiv({ cls: "crisp-search-empty", text });
      }
      return;
    }
    let section = "";
    this.items.forEach((item, index) => {
      if (item.section !== section) {
        section = item.section;
        this.listEl.createDiv({ cls: "crisp-search-section", text: section });
      }
      this.rows.push(item.type === "file" ? this.renderFileRow(item, index, query) : this.renderCommandRow(item, index));
    });
    this.select(0);
  }

  private createRow(index: number, icon: string): HTMLElement {
    const row = this.listEl.createDiv({
      cls: "crisp-search-item",
      attr: { id: `${this.idPrefix}-option-${index}`, role: "option", "aria-selected": "false", "data-index": String(index) },
    });
    setIcon(row.createDiv("crisp-search-item-icon"), icon);
    return row;
  }

  private renderCommandRow(item: CommandItem, index: number): HTMLElement {
    const row = this.createRow(index, item.command.icon ?? "terminal-square");
    const title = row.createDiv("crisp-search-item-text").createSpan("crisp-search-item-title");
    renderHighlighted(title, item.match.name, item.match.ranges);
    const hotkey = this.plugin.hotkeysFor(item.command.id)[0];
    if (hotkey) renderKeys(row.createDiv("crisp-search-item-hotkey"), hotkeyKeys(hotkey));
    return row;
  }

  private renderFileRow(item: FileItem, index: number, query: string): HTMLElement {
    const { file, result } = item;
    const row = this.createRow(index, iconFor(file));
    const text = row.createDiv("crisp-search-item-text");
    const title = text.createSpan("crisp-search-item-title");
    renderHighlighted(title, file.basename, query ? highlightRanges(file.basename, query) : []);
    if (result?.excerpt?.text) {
      renderHighlighted(text.createSpan("crisp-search-item-subtitle"), result.excerpt.text, result.excerpt.ranges);
    }
    // The last two folders plus a non-Markdown extension tell same-named files apart.
    const folders = file.parent && !file.parent.isRoot() ? file.parent.path.split("/").slice(-2).join("/") : "";
    const accessory = [file.extension === "md" ? "" : file.extension.toUpperCase(), folders].filter(Boolean).join(" · ");
    if (accessory) row.createDiv({ cls: "crisp-search-item-accessory", text: accessory, attr: { title: file.path } });
    return row;
  }

  private select(index: number, scroll = true): void {
    const previous = this.rows[this.selected];
    previous?.removeClass("is-selected");
    previous?.setAttr("aria-selected", "false");
    this.selected = index;
    const row = this.rows[index];
    if (!row) {
      this.input.removeAttribute("aria-activedescendant");
      return;
    }
    row.addClass("is-selected");
    row.setAttr("aria-selected", "true");
    this.input.setAttr("aria-activedescendant", row.id);
    if (scroll) row.scrollIntoView({ block: "nearest" });
    this.primaryLabel?.setText(this.items[index].type === "command" ? "运行" : "打开");
  }

  private toggleActions(open = !this.actionsOpen): void {
    if (open && !this.items[this.selected]) return;
    this.actionsOpen = open;
    this.actionIndex = 0;
    this.actionsEl.toggleClass("is-open", open);
    if (open) this.renderActions();
  }

  private actionsFor(item: Item | undefined): Action[] {
    if (!item) return [];
    return (item.type === "command" ? this.commandActions : this.fileActions) as Action[];
  }

  private renderActions(): void {
    this.actionsEl.empty();
    this.actionsFor(this.items[this.selected]).forEach((action, index) => {
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
    if (item) this.actionsFor(item)[index]?.run(item);
  }

  private activate(item: Item, mode: OpenMode): void {
    if (item.type === "command") this.runCommand(item);
    else void this.openFile(item, mode);
  }

  private runCommand(item: CommandItem): void {
    this.close();
    this.plugin.recordCommand(item.command.id);
    this.plugin.executeCommand(item.command.id);
  }

  private copyCommandId(item: CommandItem): void {
    void navigator.clipboard.writeText(item.command.id).then(
      () => new Notice("已复制命令 ID"),
      () => new Notice("复制失败"),
    );
    this.close();
  }

  private async openFile(item: FileItem, mode: OpenMode): Promise<void> {
    this.close();
    const workspace = this.app.workspace;
    const leaf = mode === "split" ? workspace.getLeaf("split", "vertical") : workspace.getLeaf(mode === "tab" ? "tab" : false);
    const line = item.result?.line;
    await leaf.openFile(item.file, { active: true, eState: line !== undefined ? { line } : undefined });
  }

  private copyLink(item: FileItem): void {
    const link = this.app.fileManager.generateMarkdownLink(item.file, "");
    void navigator.clipboard.writeText(link).then(
      () => new Notice("已复制链接"),
      () => new Notice("复制失败"),
    );
    this.close();
  }
}
