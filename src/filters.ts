import type { MatchKind } from "./engine";

export type Scope = "all" | "notes" | "content" | "commands" | "attachments";

// Tab order; the first is where every panel starts.
export const SCOPES: [Scope, string][] = [
  ["all", "全部"],
  ["notes", "笔记"],
  ["content", "正文"],
  ["commands", "命令"],
  ["attachments", "附件"],
];

// Files that are notes; everything else is an attachment.
const NOTE_EXTENSIONS = new Set(["md", "canvas", "base"]);

export function isNote(extension: string): boolean {
  return NOTE_EXTENSIONS.has(extension);
}

export function scopeAccepts(scope: Scope, kind: MatchKind, extension: string): boolean {
  if (scope === "notes") return kind === "title" && isNote(extension);
  if (scope === "content") return kind !== "title";
  if (scope === "attachments") return !isNote(extension);
  return true;
}

export type FilterKind = "tag" | "path" | "ext";

export interface Filter {
  kind: FilterKind;
  value: string;
}

// What the "/" menu offers, in order, with the text each one starts in the field.
export const FILTER_KINDS: { kind: FilterKind; label: string; prefix: string }[] = [
  { kind: "tag", label: "标签", prefix: "#" },
  { kind: "path", label: "文件夹", prefix: "path:" },
  { kind: "ext", label: "文件类型", prefix: "ext:" },
];

const TOKEN_RE = /^(#|path:|ext:)(.*)$/i;

function tokenFilter(token: string): Filter | null {
  const match = TOKEN_RE.exec(token);
  if (!match) return null;
  const kind = FILTER_KINDS.find((k) => k.prefix === match[1].toLowerCase())!.kind;
  let value = match[2];
  if (kind === "path") value = value.replace(/^\/+|\/+$/g, "");
  if (kind === "ext") value = value.replace(/^\./, "").toLowerCase();
  return { kind, value };
}

/**
 * Splits the field into search text, finished filter tokens (followed by a space) and the token still being
 * typed at the end. "#" alone, or "#" inside a word such as "C#", stays search text.
 */
export function splitQuery(input: string): { text: string; filters: Filter[]; pending: Filter | null } {
  const tokens = input.split(/\s+/);
  const open = !/\s$/.test(input);
  const words: string[] = [];
  const filters: Filter[] = [];
  let pending: Filter | null = null;
  tokens.forEach((token, index) => {
    if (!token) return;
    const filter = tokenFilter(token);
    const last = open && index === tokens.length - 1;
    if (filter && last) pending = filter;
    else if (filter?.value) filters.push(filter);
    else words.push(token);
  });
  return { text: words.join(" "), filters, pending };
}

export interface FilterTarget {
  path: string;
  extension: string;
  tags: string[];
}

function folderHolds(path: string, folder: string): boolean {
  const slash = path.lastIndexOf("/");
  const dir = slash === -1 ? "" : path.slice(0, slash);
  return `/${dir.toLowerCase()}/`.includes(`/${folder.toLowerCase()}/`);
}

// Every filter must hold. Tags match whole or as a parent of a nested tag; folders match a run of whole
// folder names anywhere in the path.
export function matchesFilters(doc: FilterTarget, filters: Filter[]): boolean {
  return filters.every((filter) => {
    const value = filter.value.toLowerCase();
    if (filter.kind === "tag") return doc.tags.some((tag) => tag.toLowerCase() === value || tag.toLowerCase().startsWith(`${value}/`));
    if (filter.kind === "path") return folderHolds(doc.path, value);
    return doc.extension.toLowerCase() === value;
  });
}

export function filterLabel(filter: Filter): string {
  const kind = FILTER_KINDS.find((k) => k.kind === filter.kind)!;
  return filter.kind === "tag" ? `#${filter.value}` : `${kind.label} ${filter.value}`;
}

// Values containing what was typed: those starting with it first, then the most used.
export function suggestValues(typed: string, counts: Map<string, number>, limit = 30): string[] {
  const lower = typed.toLowerCase();
  return [...counts.entries()]
    .filter(([value]) => value.toLowerCase().includes(lower))
    .sort(([a, x], [b, y]) => Number(b.toLowerCase().startsWith(lower)) - Number(a.toLowerCase().startsWith(lower)) || y - x)
    .slice(0, limit)
    .map(([value]) => value);
}
