import { CommandIndex } from "./commands";

// Results that other plugins bring to the panel: Crisp Tempo's tasks, Crisp Pulse's memos.
// A provider registers once (plugin.registerSearchProvider); the panel asks it for its entries when it
// opens, matches them here the same way commands are matched, and hands the chosen id back to open().
export const SEARCH_PROVIDER_API_VERSION = 1;

export interface ProviderEntry {
  // Stable within the provider; given back to open().
  id: string;
  title: string;
  // More searchable text that is not shown, such as the rest of a memo.
  text?: string;
  subtitle?: string;
  // Short note at the right edge of the row: a project, a date, "已完成".
  accessory?: string;
  icon?: string;
  // Finished items stay findable but sit below every open one that matches, however well they match:
  // a task search is nearly always for work still to do.
  done?: boolean;
}

export interface SearchProvider {
  // The registering plugin's id; one provider per id.
  id: string;
  // Tab and section name, e.g. "任务".
  label: string;
  icon?: string;
  // false keeps the entries out of the "全部" tab (they show under their own tab only).
  mixed?: boolean;
  list(): ProviderEntry[] | Promise<ProviderEntry[]>;
  open(id: string): void | Promise<void>;
}

export const MAX_PROVIDER_ENTRIES = 5000;
const MAX_TITLE = 300;
const MAX_TEXT = 4000;
const MAX_NOTE = 80;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export type ProviderScope = `provider:${string}`;

export function providerScope(id: string): ProviderScope {
  return `provider:${id}`;
}

export function scopeProvider(scope: string): string | null {
  return scope.startsWith("provider:") ? scope.slice("provider:".length) : null;
}

export class ProviderRegistry {
  private readonly providers = new Map<string, SearchProvider>();
  private readonly listeners = new Set<() => void>();

  // Returns the cleanup for this registration; it does nothing once another registration took the id.
  register(provider: SearchProvider): () => void {
    const p = provider as Partial<SearchProvider> | null;
    if (!p || typeof p.id !== "string" || !ID_RE.test(p.id) || typeof p.label !== "string" || !p.label.trim()
      || typeof p.list !== "function" || typeof p.open !== "function") {
      throw new Error("Crisp Search: invalid search provider (needs id, label, list and open)");
    }
    this.providers.set(provider.id, provider);
    this.emit();
    return () => {
      if (this.providers.get(provider.id) !== provider) return;
      this.providers.delete(provider.id);
      this.emit();
    };
  }

  list(): SearchProvider[] {
    return [...this.providers.values()];
  }

  get(id: string): SearchProvider | undefined {
    return this.providers.get(id);
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

function clip(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
}

// What a provider returned, reduced to entries the panel can trust.
export function cleanEntries(raw: unknown): ProviderEntry[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const entries: ProviderEntry[] = [];
  for (const item of raw) {
    if (entries.length >= MAX_PROVIDER_ENTRIES) break;
    if (!item || typeof item !== "object") continue;
    const source = item as Record<string, unknown>;
    const title = clip(source.title, MAX_TITLE);
    if (typeof source.id !== "string" || !source.id || !title || seen.has(source.id)) continue;
    seen.add(source.id);
    const entry: ProviderEntry = { id: source.id, title };
    const text = clip(source.text, MAX_TEXT);
    const subtitle = clip(source.subtitle, MAX_TITLE);
    const accessory = clip(source.accessory, MAX_NOTE);
    const icon = clip(source.icon, MAX_NOTE);
    if (text) entry.text = text;
    if (subtitle) entry.subtitle = subtitle;
    if (accessory) entry.accessory = accessory;
    if (icon) entry.icon = icon;
    if (typeof source.done === "boolean") entry.done = source.done;
    entries.push(entry);
  }
  return entries;
}

// One provider failing, hanging or answering with junk costs only its own results.
export async function loadEntries(
  provider: SearchProvider,
  timeoutMs: number,
  log: (...args: unknown[]) => void = console.warn,
): Promise<ProviderEntry[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const answer = await Promise.race([
      Promise.resolve().then(() => provider.list()),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer in ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
    return cleanEntries(answer);
  } catch (error) {
    log(`Crisp Search: provider ${provider.id} gave no results`, error);
    return [];
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface ProviderMatch {
  entry: ProviderEntry;
  score: number;
  // Where the query matched in the title; empty when it matched the hidden text.
  ranges: [number, number][];
}

// Below any title match: the words were found, but only in the text behind the title.
const TEXT_SCORE = 0.5;

// The few a provider adds to the "全部" tab: open entries only, so finished tasks do not fill the slots
// when fewer open ones match. The provider's own tab still lists finished entries below the open ones.
export function mixedMatches(matches: ProviderMatch[], limit: number): ProviderMatch[] {
  return matches.filter((match) => match.entry.done !== true).slice(0, limit);
}

export class ProviderIndex {
  private readonly entries: ProviderEntry[];
  private readonly order = new Map<string, number>();
  private readonly titles: CommandIndex;
  private readonly haystacks: string[];

  constructor(entries: ProviderEntry[]) {
    this.entries = entries;
    entries.forEach((entry, at) => this.order.set(entry.id, at));
    this.titles = new CommandIndex(entries.map(({ id, title }) => ({ id, name: title })));
    this.haystacks = entries.map((entry) => `${entry.title}\n${entry.text ?? ""}`.toLowerCase());
  }

  search(query: string): ProviderMatch[] {
    const parts = [...new Set(query.trim().toLowerCase().split(/\s+/).filter(Boolean))];
    if (!parts.length) return this.entries.map((entry) => ({ entry, score: 0, ranges: [] }));
    const matches = new Map<string, ProviderMatch>();
    for (const match of this.titles.search(query)) {
      matches.set(match.id, { entry: this.entries[this.order.get(match.id)!], score: match.score, ranges: match.ranges });
    }
    this.entries.forEach((entry, at) => {
      if (matches.has(entry.id) || !entry.text) return;
      if (parts.every((part) => this.haystacks[at].includes(part))) matches.set(entry.id, { entry, score: TEXT_SCORE, ranges: [] });
    });
    return [...matches.values()].sort(
      (a, b) =>
        Number(a.entry.done === true) - Number(b.entry.done === true) ||
        b.score - a.score ||
        this.order.get(a.entry.id)! - this.order.get(b.entry.id)!,
    );
  }
}
