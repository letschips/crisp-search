import { App, Command, Hotkey, Keymap, Menu, Modal, Notice, Platform, Scope, TFile, TFolder, normalizePath, setIcon } from "obsidian";
import { CommandIndex, CommandMatch, isCommandAvailable } from "./commands";
import { Excerpt, MAX_HITS, SearchResult, highlightRanges, highlightSegments } from "./engine";
import type CrispSearchPlugin from "./main";
import { PANEL_MENU_ICON } from "./icon";
import { SORT_ORDERS, SortOrder, resultOrder } from "./sort";

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
  // Set on rows of the in-note hit list: one matching line of the file.
  hit?: Excerpt;
}

interface CommandItem {
  type: "command";
  section: string;
  command: Command;
  match: CommandMatch;
}

// The query as a new note's name, offered below the results.
interface CreateItem {
  type: "create";
  section: "";
  name: string;
}

// A search typed before; choosing it puts it back in the field.
interface QueryItem {
  type: "query";
  section: string;
  query: string;
}

type Item = FileItem | CommandItem | CreateItem | QueryItem;

// Recent searches shown under the recent notes in an empty panel.
const RECENT_QUERY_SHOWN = 3;

interface Action<T extends Item = Item> {
  label: string;
  icon: string;
  keys: string[];
  run: (item: T) => void;
  // Opens the right-click menu, so it is left out of that menu itself.
  more?: boolean;
}

const MOD = Platform.isMacOS ? "⌘" : "Ctrl";
const ALT = Platform.isMacOS ? "⌥" : "Alt";
const MODIFIER_KEYS: Record<string, string> = Platform.isMacOS
  ? { Mod: "⌘", Ctrl: "⌃", Meta: "⌘", Alt: "⌥", Shift: "⇧" }
  : { Mod: "Ctrl", Ctrl: "Ctrl", Meta: "Win", Alt: "Alt", Shift: "Shift" };
// One table for what the menu shows and what Enter does, so the two cannot drift apart.
const MODE_KEYS: Record<OpenMode, string[]> = { current: ["↵"], tab: [MOD, "↵"], split: [MOD, ALT, "↵"] };
const INSERT_KEYS = [ALT, "↵"];
const KEY_NAMES: Record<string, string> = { ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Enter: "↵", " ": "Space" };

function hotkeyKeys(hotkey: Hotkey): string[] {
  const key = KEY_NAMES[hotkey.key] ?? (hotkey.key.length === 1 ? hotkey.key.toUpperCase() : hotkey.key);
  return [...hotkey.modifiers.map((m) => MODIFIER_KEYS[m] ?? m), key];
}

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "heic"]);

// Characters a file name cannot hold, plus those that break a [[link]].
const UNSAFE_NAME = /[\\/:*?"<>|#^[\]]/g;

function noteName(query: string): string {
  return query.replace(UNSAFE_NAME, " ").replace(/\s+/g, " ").trim().replace(/^\.+/, "").slice(0, 200).trim();
}

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
  for (const segment of highlightSegments(text, ranges)) {
    if (segment.mark) el.createEl("mark", { text: segment.text });
    else el.appendText(segment.text);
  }
}

function itemKey(item: Item): string {
  if (item.type === "command") return `command:${item.command.id}`;
  if (item.type === "create") return `create:${item.name}`;
  if (item.type === "query") return `query:${item.query}`;
  return item.hit ? `hit:${item.file.path}:${item.hit.line}` : `file:${item.file.path}`;
}

function hitLabel(count: number): string {
  return count > MAX_HITS ? `${MAX_HITS}+` : String(count);
}

// A body result with more than one matching line can open its in-note hit list.
function hasMoreHits(item: Item | undefined): item is FileItem {
  return item?.type === "file" && !item.hit && (item.result?.hitCount ?? 0) > 1;
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
  private refreshPending = false;
  // True while an IME holds uncommitted text (raw pinyin) in the field.
  private composing = false;
  // Whether the panel currently shows the activation prompt instead of search.
  private lockedShown = false;
  // The body result whose hit list is showing, and where the list was when it opened.
  private drill: { item: FileItem; index: number; scrollTop: number } | null = null;
  private readonly fileActions: Action<FileItem>[];
  private readonly commandActions: Action<CommandItem>[];
  private readonly createActions: Action<CreateItem>[];
  private readonly queryActions: Action<QueryItem>[];
  // A sort picked in the panel lasts until it closes; the setting is the default.
  private sortOverride: SortOrder | null = null;
  private primaryLabel: HTMLElement | null = null;
  private commands: Map<string, Command> | null = null;
  private commandIndex: CommandIndex | null = null;

  constructor(app: App, plugin: CrispSearchPlugin) {
    super(app);
    this.plugin = plugin;
    this.fileActions = [
      { label: "打开", icon: "file-input", keys: MODE_KEYS.current, run: (item) => void this.openFile(item, "current") },
      { label: "在新标签页打开", icon: "plus-square", keys: MODE_KEYS.tab, run: (item) => void this.openFile(item, "tab") },
      { label: "在右侧打开", icon: "columns-2", keys: MODE_KEYS.split, run: (item) => void this.openFile(item, "split") },
      { label: "插入链接", icon: "link-2", keys: INSERT_KEYS, run: (item) => this.insertLink(item) },
      { label: "复制链接", icon: "link", keys: [], run: (item) => this.copyLink(item) },
    ];
    this.commandActions = [
      { label: "运行", icon: "play", keys: ["↵"], run: (item) => this.runCommand(item) },
      { label: "复制命令 ID", icon: "copy", keys: [], run: (item) => this.copyCommandId(item) },
    ];
    this.createActions = [
      { label: "新建笔记", icon: "file-plus", keys: MODE_KEYS.current, run: (item) => void this.createNote(item, "current") },
      { label: "在新标签页新建", icon: "plus-square", keys: MODE_KEYS.tab, run: (item) => void this.createNote(item, "tab") },
      { label: "在右侧新建", icon: "columns-2", keys: MODE_KEYS.split, run: (item) => void this.createNote(item, "split") },
    ];
    this.queryActions = [
      { label: "搜索", icon: "search", keys: ["↵"], run: (item) => this.searchAgain(item) },
      { label: "从最近搜索中移除", icon: "x", keys: [], run: (item) => this.forgetQuery(item) },
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
      const tools = this.modalEl.createDiv("crisp-search-footer is-start");
      const menuButton = tools.createDiv({ cls: "crisp-search-footer-icon", attr: { "aria-label": "排序、索引与设置", "data-tooltip-position": "top" } });
      setIcon(menuButton, PANEL_MENU_ICON);
      menuButton.addEventListener("click", () => this.showPanelMenu(menuButton));

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
    // Typing always searches again, leaving a hit list.
    this.input.addEventListener("input", (evt) => {
      if ((evt as InputEvent).isComposing) return;
      this.drill = null;
      this.update();
    });
    this.input.addEventListener("compositionstart", () => (this.composing = true));
    this.input.addEventListener("compositionend", () => {
      this.composing = false;
      this.drill = null;
      this.update();
    });
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
    this.listEl.addEventListener("contextmenu", (evt) => {
      const index = this.rowIndexOf(evt.target);
      if (index === -1) return;
      evt.preventDefault();
      this.toggleActions(false);
      this.select(index, false);
      this.showItemMenu(this.items[index], (menu) => menu.showAtMouseEvent(evt));
    });
    this.listEl.addEventListener("click", (evt) => {
      const target = evt.target instanceof HTMLElement ? evt.target : null;
      if (target?.closest(".crisp-search-section.is-drill")) {
        this.leaveHits();
        return;
      }
      const index = this.rowIndexOf(evt.target);
      if (index === -1) return;
      if (target?.closest(".crisp-search-item-hits")) {
        this.select(index, false);
        this.enterHits();
        return;
      }
      this.select(index, false);
      this.choose(this.items[index], evt);
    });

    // The modal's own scope closes on Escape before the field sees the key, so a child scope on top
    // takes Escape first: it closes the action menu, and leaves an IME composition to the IME.
    this.escapeScope = new Scope(this.scope);
    this.escapeScope.register([], "Escape", (evt) => {
      if (evt.isComposing) return false;
      if (this.actionsOpen) this.toggleActions(false);
      else if (this.drill) this.leaveHits();
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

  // Index changes refresh file results but keep the selection; while the action menu is open the
  // refresh waits and runs when the menu closes.
  private onIndexProgress(): void {
    if (this.lockedShown !== !this.plugin.licensed) {
      this.renderStatus();
      this.update();
      return;
    }
    this.renderStatus();
    // Mid-composition the field holds raw pinyin; compositionend searches with the committed text anyway.
    if (this.composing || !this.input.value.trim() || this.commandMode()) return;
    if (this.actionsOpen) this.refreshPending = true;
    else this.refreshKeepingSelection();
  }

  private refreshKeepingSelection(): void {
    const selected = this.items[this.selected];
    const scrollTop = this.listEl.scrollTop;
    this.update();
    const index = selected ? this.items.findIndex((item) => itemKey(item) === itemKey(selected)) : -1;
    if (index >= 0) {
      this.listEl.scrollTop = scrollTop;
      this.select(index, false);
    }
  }

  private commandMode(): boolean {
    return COMMAND_PREFIX.test(this.input.value.trimStart());
  }

  private renderStatus(): void {
    const { ready, indexed, total, failed } = this.plugin;
    if (!this.plugin.licensed) this.statusEl.setText("");
    else if (!ready) this.statusEl.setText(`索引中 ${indexed}/${total}`);
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
    // Caps Lock turns the key into "K".
    if (evt.key.toLowerCase() === "k" && Keymap.isModEvent(evt)) {
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
      } else if (evt.key === "ArrowRight" && hasMoreHits(this.items[this.selected])) {
        // The menu lists → next to the hit list, so → opens it here too.
        evt.preventDefault();
        this.enterHits();
      } else if (evt.key === "Enter") {
        evt.preventDefault();
        // A modified Enter means the action it is shown next to, whichever row is highlighted.
        const item = this.items[this.selected];
        if (item && (this.modeFor(evt) !== "current" || this.wantsInsert(evt, item))) this.choose(item, evt);
        else this.runAction(this.actionIndex);
      }
      return;
    }
    // → at the end of the field opens a body result's hit list; ← goes back from it.
    const atEnd = this.input.selectionStart === this.input.value.length && this.input.selectionEnd === this.input.value.length;
    if (evt.key === "ArrowRight" && atEnd && !evt.shiftKey && hasMoreHits(this.items[this.selected])) {
      evt.preventDefault();
      this.enterHits();
      return;
    }
    if (evt.key === "ArrowLeft" && this.drill && !evt.shiftKey) {
      evt.preventDefault();
      this.leaveHits();
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
      // ⇧↵ creates the note from any row, the way Obsidian's quick switcher does.
      const item = evt.shiftKey ? this.items.find((other) => other.type === "create") : this.items[this.selected];
      if (item) this.choose(item, evt);
    }
  }

  // ⌥↵ / ⌥-click on a note inserts a link to it; everything else follows the open mode.
  private wantsInsert(evt: MouseEvent | KeyboardEvent, item: Item): item is FileItem {
    return evt.altKey && !Keymap.isModEvent(evt) && item.type === "file";
  }

  private choose(item: Item, evt: MouseEvent | KeyboardEvent): void {
    if (this.wantsInsert(evt, item)) this.insertLink(item);
    else this.activate(item, this.modeFor(evt));
  }

  private rowIndexOf(target: EventTarget | null): number {
    const row = target instanceof HTMLElement ? target.closest<HTMLElement>(".crisp-search-item") : null;
    return row ? Number(row.dataset.index) : -1;
  }

  private update(): void {
    const raw = this.input.value.trimStart();
    const commandMode = COMMAND_PREFIX.test(raw);
    const query = (commandMode ? raw.slice(1) : raw).trim();
    this.refreshPending = false;
    this.toggleActions(false);
    if (!this.plugin.licensed) {
      this.renderLocked();
      return;
    }
    this.lockedShown = false;
    this.modalEl.removeClass("is-locked");
    if (this.drill) this.items = this.hitItems(this.drill.item, query);
    else if (commandMode) this.items = this.commandItems(query, Infinity);
    else this.items = query ? this.searchItems(query) : this.recentItems();
    this.selected = 0;
    this.render(query, commandMode);
  }

  // Searching is for activated copies: the panel shows how to activate instead of results.
  private renderLocked(): void {
    this.lockedShown = true;
    this.modalEl.addClass("is-locked");
    this.drill = null;
    this.items = [];
    this.rows = [];
    this.selected = 0;
    this.listEl.empty();
    this.input.removeAttribute("aria-activedescendant");
    const locked = this.listEl.createDiv("crisp-search-locked");
    locked.createDiv({ text: "Crisp Search 需要激活后才能搜索" });
    const button = locked.createEl("button", { cls: "crisp-search-locked-button", text: "输入授权码" });
    button.addEventListener("click", () => {
      this.close();
      this.plugin.openSettings();
    });
  }

  private hitItems(parent: FileItem, query: string): Item[] {
    const hits = this.plugin.engine.hits(parent.file.path, query);
    return hits.map((hit) => ({ type: "file", section: parent.file.basename, file: parent.file, result: parent.result, hit }));
  }

  private enterHits(): void {
    const item = this.items[this.selected];
    if (!hasMoreHits(item)) return;
    this.drill = { item, index: this.selected, scrollTop: this.listEl.scrollTop };
    this.update();
  }

  private leaveHits(): void {
    const drill = this.drill;
    if (!drill) return;
    this.drill = null;
    this.update();
    const index = this.items.findIndex((item) => itemKey(item) === itemKey(drill.item));
    if (index === -1) return;
    this.listEl.scrollTop = drill.scrollTop;
    this.select(index);
  }

  private recentItems(): Item[] {
    const items: Item[] = [];
    for (const path of this.app.workspace.getLastOpenFiles()) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile && !this.plugin.isIgnored(file.path)) items.push({ type: "file", section: "最近", file });
      if (items.length >= RECENT_LIMIT) break;
    }
    for (const query of this.plugin.recentQueries.slice(0, RECENT_QUERY_SHOWN)) {
      items.push({ type: "query", section: "最近搜索", query });
    }
    return items;
  }

  private get sortOrder(): SortOrder {
    return this.sortOverride ?? this.plugin.settings.sortOrder;
  }

  private searchItems(query: string): Item[] {
    const titles: FileItem[] = [];
    const bodies: Item[] = [];
    const stat = (path: string) => {
      const file = this.app.vault.getAbstractFileByPath(path);
      return file instanceof TFile ? file.stat : undefined;
    };
    for (const result of this.plugin.engine.search(query, undefined, resultOrder(this.sortOrder, stat))) {
      const file = this.app.vault.getAbstractFileByPath(result.path);
      if (!(file instanceof TFile)) continue;
      if (result.kind === "title") titles.push({ type: "file", section: "笔记", file, result });
      else bodies.push({ type: "file", section: "内容", file, result });
    }
    const items: Item[] = [...titles, ...this.commandItems(query, MIXED_COMMAND_LIMIT), ...bodies];
    // A note already named this way is the result to open, not one to create again.
    const name = noteName(query);
    const lower = name.toLowerCase();
    if (name && !titles.some((item) => item.file.basename.toLowerCase() === lower)) {
      items.push({ type: "create", section: "", name });
    }
    return items;
  }

  // Only commands that can run right now, judged once per panel: the active note does not change while it is open.
  private availableCommands(): Map<string, Command> {
    if (this.commands) return this.commands;
    const context = this.app.workspace.activeEditor;
    const available = new Map<string, Command>();
    for (const command of this.plugin.listCommands()) {
      if (command.id.startsWith(`${this.plugin.manifest.id}:open`)) continue;
      if (isCommandAvailable(command, context)) available.set(command.id, command);
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
    // Nothing found still offers the query as a new note, below the message.
    if (this.items.every((item) => item.type === "create")) {
      // An emptied hit list keeps its header, so there is still a way back.
      if (this.drill) this.renderSection(this.drill.item.file.basename);
      if (query || commandMode || this.drill) {
        const text = commandMode || this.plugin.ready ? "没有结果" : "正在建立索引…";
        this.listEl.createDiv({ cls: "crisp-search-empty", text });
      }
      if (this.items.length === 0) return;
    }
    let section = "";
    this.items.forEach((item, index) => {
      if (item.section !== section) {
        section = item.section;
        if (section) this.renderSection(section);
      }
      const row =
        item.type === "command"
          ? this.renderCommandRow(item, index)
          : item.type === "create"
            ? this.renderCreateRow(item, index)
            : item.type === "query"
              ? this.renderQueryRow(item, index)
            : item.hit
            ? this.renderHitRow(item, item.hit, index)
            : this.renderFileRow(item, index, query);
      this.rows.push(row);
    });
    this.select(0);
  }

  private renderSection(text: string): void {
    const header = this.listEl.createDiv({ cls: "crisp-search-section", text });
    if (!this.drill) return;
    header.addClass("is-drill");
    setIcon(header.createSpan({ cls: "crisp-search-section-back", attr: { "aria-label": "返回" } }), "chevron-left");
    header.prepend(header.lastChild!);
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
    if (hasMoreHits(item)) {
      const hits = row.createDiv({ cls: "crisp-search-item-hits", attr: { "aria-label": "查看全部命中" } });
      hits.createSpan({ text: `${hitLabel(result!.hitCount!)} 行` });
      setIcon(hits.createSpan("crisp-search-item-hits-icon"), "chevron-right");
    }
    return row;
  }

  private renderQueryRow(item: QueryItem, index: number): HTMLElement {
    const row = this.createRow(index, "history");
    row.createDiv("crisp-search-item-text").createSpan({ cls: "crisp-search-item-title", text: item.query });
    return row;
  }

  private renderCreateRow(item: CreateItem, index: number): HTMLElement {
    const row = this.createRow(index, "file-plus");
    const title = row.createDiv("crisp-search-item-text").createSpan("crisp-search-item-title");
    title.appendText("新建笔记「");
    title.createSpan({ cls: "crisp-search-item-strong", text: item.name });
    title.appendText("」");
    renderKeys(row.createDiv("crisp-search-item-hotkey"), [MODIFIER_KEYS.Shift, "↵"]);
    return row;
  }

  private renderHitRow(item: FileItem, hit: Excerpt, index: number): HTMLElement {
    const row = this.createRow(index, "text");
    const title = row.createDiv("crisp-search-item-text").createSpan("crisp-search-item-title crisp-search-item-hit");
    renderHighlighted(title, hit.text, hit.ranges);
    row.createDiv({ cls: "crisp-search-item-accessory", text: `第 ${hit.line + 1} 行` });
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
    const type = this.items[index].type;
    const labels: Record<Item["type"], string> = { command: "运行", create: "新建", query: "搜索", file: "打开" };
    this.primaryLabel?.setText(labels[type]);
  }

  private toggleActions(open = !this.actionsOpen): void {
    if (open && !this.items[this.selected]) return;
    this.actionsOpen = open;
    this.actionIndex = 0;
    this.actionsEl.toggleClass("is-open", open);
    if (open) this.renderActions();
    else if (this.refreshPending) {
      this.refreshPending = false;
      this.refreshKeepingSelection();
    }
  }

  private actionsFor(item: Item | undefined): Action[] {
    if (!item) return [];
    if (item.type === "command") return this.commandActions as Action[];
    if (item.type === "create") return this.createActions as Action[];
    if (item.type === "query") return this.queryActions as Action[];
    // Inserting needs a note open in an editor behind the panel.
    const fileActions = this.app.workspace.activeEditor?.editor
      ? this.fileActions
      : this.fileActions.filter((action) => action.keys !== INSERT_KEYS);
    const more: Action<FileItem> = { label: "更多操作…", icon: "more-horizontal", keys: [], more: true, run: () => this.showMenuAtRow() };
    if (!hasMoreHits(item)) return [...fileActions, more] as Action[];
    const hits: Action<FileItem> = {
      label: item.result!.hitCount! > MAX_HITS ? `查看前 ${MAX_HITS} 行命中` : `查看全部 ${item.result!.hitCount} 行命中`,
      icon: "list",
      keys: ["→"],
      run: () => this.enterHits(),
    };
    return [...fileActions, hits, more] as Action[];
  }

  // Right-click menu: this panel's own actions first, then the note menu Obsidian and other plugins build
  // for any file (reveal in Finder, copy path, bookmark, move…), the same one the file list shows.
  private showItemMenu(item: Item, show: (menu: Menu) => void): void {
    const menu = new Menu();
    for (const action of this.actionsFor(item)) {
      if (action.more) continue;
      // Obsidian orders menu items by section; "title" comes before its own open/copy/system groups.
      menu.addItem((menuItem) =>
        menuItem.setTitle(action.label).setIcon(action.icon).setSection("title").onClick(() => action.run(item)),
      );
    }
    if (item.type === "file") {
      menu.addSeparator();
      this.app.workspace.trigger("file-menu", menu, item.file, "crisp-search", null);
      // Obsidian's own entries that open the note would leave the panel over it; close it when one does.
      const ref = this.app.workspace.on("file-open", () => this.close());
      menu.onHide(() => this.app.workspace.offref(ref));
    }
    show(menu);
  }

  private showMenuAtRow(): void {
    const item = this.items[this.selected];
    const row = this.rows[this.selected];
    if (!item || !row) return;
    this.toggleActions(false);
    const rect = row.getBoundingClientRect();
    this.showItemMenu(item, (menu) => menu.showAtPosition({ x: rect.right - 16, y: rect.bottom }, row.doc));
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
    else if (item.type === "create") void this.createNote(item, mode);
    else if (item.type === "query") this.searchAgain(item);
    else void this.openFile(item, mode);
  }

  // The sort picked here applies to this panel only; the default lives in the settings.
  private showPanelMenu(anchor: HTMLElement): void {
    const { ready, indexed, total } = this.plugin;
    const menu = new Menu();
    for (const [order, label] of Object.entries(SORT_ORDERS) as [SortOrder, string][]) {
      menu.addItem((menuItem) =>
        menuItem
          .setTitle(label)
          .setChecked(order === this.sortOrder)
          .onClick(() => {
            this.sortOverride = order;
            this.update();
          }),
      );
    }
    menu.addSeparator();
    menu.addItem((menuItem) =>
      menuItem
        .setTitle(ready ? `已索引 ${this.plugin.engine.paths().length.toLocaleString()} 个文件` : `索引中 ${indexed}/${total}`)
        .setIcon("database")
        .setDisabled(true),
    );
    menu.addItem((menuItem) =>
      menuItem
        .setTitle("重建索引")
        .setIcon("refresh-cw")
        .onClick(() => void this.plugin.rebuildIndex()),
    );
    menu.addSeparator();
    menu.addItem((menuItem) =>
      menuItem
        .setTitle("插件设置")
        .setIcon("settings")
        .onClick(() => {
          this.close();
          this.plugin.openSettings();
        }),
    );
    this.showMenuBelow(menu, anchor);
  }

  private showMenuBelow(menu: Menu, anchor: HTMLElement): void {
    this.toggleActions(false);
    menu.onHide(() => this.input.focus());
    const rect = anchor.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 }, anchor.doc);
  }

  private async newNoteParent(): Promise<TFolder> {
    const path = this.plugin.settings.newNoteFolder;
    if (path) {
      const folder = this.app.vault.getAbstractFileByPath(path);
      if (folder instanceof TFolder) return folder;
      if (!folder) {
        await this.app.vault.createFolder(path);
        const created = this.app.vault.getAbstractFileByPath(path);
        if (created instanceof TFolder) return created;
      }
    }
    return this.app.fileManager.getNewFileParent(this.app.workspace.getActiveFile()?.path ?? "");
  }

  // A note of that name already in the folder is opened instead of being created twice.
  private async createNote(item: CreateItem, mode: OpenMode): Promise<void> {
    this.rememberQuery();
    this.close();
    try {
      const parent = await this.newNoteParent();
      const path = normalizePath(parent.isRoot() ? `${item.name}.md` : `${parent.path}/${item.name}.md`);
      const existing = this.app.vault.getAbstractFileByPath(path);
      const file = existing instanceof TFile ? existing : await this.app.vault.create(path, "");
      const workspace = this.app.workspace;
      const leaf = mode === "split" ? workspace.getLeaf("split", "vertical") : workspace.getLeaf(mode === "tab" ? "tab" : false);
      await leaf.openFile(file, { active: true });
    } catch (error) {
      console.error("Crisp Search: could not create note", error);
      new Notice(`新建笔记失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Checked again at run time; only a command the host accepted goes into recent use.
  private runCommand(item: CommandItem): void {
    const runnable = isCommandAvailable(item.command, this.app.workspace.activeEditor);
    this.close();
    if (!runnable || !this.plugin.executeCommand(item.command.id)) {
      new Notice("这个命令现在无法运行");
      return;
    }
    this.plugin.recordCommand(item.command.id);
  }

  private copyCommandId(item: CommandItem): void {
    void navigator.clipboard.writeText(item.command.id).then(
      () => new Notice("已复制命令 ID"),
      () => new Notice("复制失败"),
    );
    this.close();
  }

  private async openFile(item: FileItem, mode: OpenMode): Promise<void> {
    this.rememberQuery();
    this.close();
    const workspace = this.app.workspace;
    const leaf = mode === "split" ? workspace.getLeaf("split", "vertical") : workspace.getLeaf(mode === "tab" ? "tab" : false);
    const line = item.hit?.line ?? item.result?.line;
    await leaf.openFile(item.file, { active: true, eState: line !== undefined ? { line } : undefined });
  }

  // Only a search that led somewhere is remembered; command searches are not.
  private rememberQuery(): void {
    const raw = this.input.value.trim();
    if (raw && !COMMAND_PREFIX.test(raw)) this.plugin.recordQuery(raw);
  }

  private searchAgain(item: QueryItem): void {
    this.input.value = item.query;
    this.drill = null;
    this.update();
    this.input.focus();
    this.input.setSelectionRange(item.query.length, item.query.length);
  }

  private forgetQuery(item: QueryItem): void {
    this.plugin.forgetQuery(item.query);
    this.update();
  }

  // Into the note that was being edited when the panel opened; selected text becomes the link's display text.
  private insertLink(item: FileItem): void {
    const context = this.app.workspace.activeEditor;
    const editor = context?.editor;
    this.rememberQuery();
    this.close();
    if (!editor) {
      new Notice("没有正在编辑的笔记，无法插入链接");
      return;
    }
    const selection = editor.getSelection();
    const link = this.app.fileManager.generateMarkdownLink(item.file, context.file?.path ?? "", "", selection || undefined);
    editor.replaceSelection(link);
    editor.focus();
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
