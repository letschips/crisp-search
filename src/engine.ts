import MiniSearch from "minisearch";
import { pinyin } from "pinyin-pro";

// Han, kana and hangul have no spaces between words, so they are indexed as overlapping bigrams.
// That needs no dictionary and finds any word inside a sentence.
const CJK_CHAR = "\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uac00-\\ud7af";
const TOKEN_RE = new RegExp(`([${CJK_CHAR}]+)|((?:(?![${CJK_CHAR}])[\\p{L}\\p{N}])+)`, "gu");
const CJK_RE = new RegExp(`[${CJK_CHAR}]`);
const HAN_RUN_RE = /[㐀-䶿一-鿿豈-﫿]+/g;

export function isCjk(term: string): boolean {
  return CJK_RE.test(term);
}

export function tokenizeText(text: string): string[] {
  const tokens: string[] = [];
  for (const match of text.matchAll(TOKEN_RE)) {
    const cjk = match[1];
    if (cjk) {
      if (cjk.length === 1) tokens.push(cjk);
      for (let i = 0; i + 1 < cjk.length; i++) tokens.push(cjk.slice(i, i + 2));
    } else {
      tokens.push(match[2].toLowerCase());
    }
  }
  return tokens;
}

// Full pinyin and initials for every suffix of each Han run, so "sheji" and "sj" both find 知识库设计.
export function pinyinKeys(title: string): string[] {
  const keys = new Set<string>();
  for (const [run] of title.matchAll(HAN_RUN_RE)) {
    const syllables = pinyin(run, { toneType: "none", type: "array", v: true }).map((s) => s.toLowerCase());
    for (let i = 0; i < syllables.length; i++) {
      const rest = syllables.slice(i);
      const full = rest.join("");
      const initials = rest.map((s) => s[0]).join("");
      if (full.length >= 2) keys.add(full);
      if (initials.length >= 2) keys.add(initials);
    }
  }
  return [...keys];
}

export interface Heading {
  text: string;
  line: number;
}

export interface SearchDoc {
  path: string;
  basename: string;
  extension: string;
  content: string;
  headings: Heading[];
  tags: string[];
  aliases: string[];
}

export type MatchKind = "title" | "heading" | "content";

export interface Excerpt {
  text: string;
  ranges: [number, number][];
  line: number;
}

export interface SearchResult {
  path: string;
  basename: string;
  extension: string;
  kind: MatchKind;
  score: number;
  line?: number;
  excerpt?: Excerpt;
}

interface IndexedDoc {
  path: string;
  basename: string;
  aliases: string;
  pinyin: string;
  headings: string;
  tags: string;
  folder: string;
  content: string;
}

const BOOST = { basename: 10, aliases: 8, pinyin: 6, headings: 4, tags: 3, folder: 2, content: 1 };
const TITLE_FIELDS = new Set(["basename", "aliases", "pinyin", "folder"]);
const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;

function queryParts(query: string): string[] {
  return query
    .trim()
    .split(/\s+/)
    .filter((part) => tokenizeText(part).length > 0);
}

// A part is located literally first; scattered bigram matches fall back to each token.
function needlesFor(part: string): string[][] {
  return [[part.toLowerCase()], tokenizeText(part)];
}

function findRanges(text: string, parts: string[]): [number, number][] {
  const lower = text.toLowerCase();
  const ranges: [number, number][] = [];
  for (const part of parts) {
    for (const needles of needlesFor(part)) {
      const before = ranges.length;
      for (const needle of needles) {
        for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, at + needle.length)) {
          ranges.push([at, at + needle.length]);
        }
      }
      if (ranges.length > before) break;
    }
  }
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: [number, number][] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  return merged;
}

export function highlightRanges(text: string, query: string): [number, number][] {
  return findRanges(text, queryParts(query));
}

function cleanMarkdown(text: string): string {
  return text
    .replace(/!?\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|~~|==|`)/g, "")
    .replace(/^\s*(#{1,6}\s+|[-*+]\s+(\[.\]\s+)?|\d+\.\s+|>\s*)/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

const EXCERPT_BEFORE = 10;
const SENTENCE_BREAKS = ["。", "！", "？", "；", ". ", "! ", "? ", "; "];
const WORD_CHAR = /[A-Za-z0-9_]/;
const EXCERPT_AFTER = 140;

export function makeExcerpt(content: string, query: string): Excerpt {
  const parts = queryParts(query);
  const bodyStart = content.match(FRONTMATTER_RE)?.[0].length ?? 0;
  const body = content.slice(bodyStart);
  const first = findRanges(body, parts)[0];
  const at = first ? first[0] : 0;
  const line = (content.slice(0, bodyStart + at).match(/\n/g) ?? []).length;
  const start = Math.max(0, at - EXCERPT_BEFORE);
  // Start on a line boundary when one is close, so the excerpt does not open mid-sentence.
  const lineStart = body.lastIndexOf("\n", at - 1) + 1;
  let from = lineStart >= start ? lineStart : start;
  if (from > lineStart) {
    // Prefer the start of the sentence; otherwise do not cut an English word in half.
    const lead = body.slice(from, at);
    const sentence = Math.max(...SENTENCE_BREAKS.map((mark) => lead.lastIndexOf(mark)));
    if (sentence !== -1) from += sentence + 1;
    else while (from < at && WORD_CHAR.test(body[from - 1]) && WORD_CHAR.test(body[from])) from++;
    while (from < at && /[\s，、,:：）)」』]/.test(body[from])) from++;
  }
  let text = cleanMarkdown(body.slice(from, at + EXCERPT_AFTER));
  if (from > lineStart) text = "…" + text;
  return { text, ranges: findRanges(text, parts), line };
}

export class SearchEngine {
  private readonly docs = new Map<string, SearchDoc>();
  private readonly index = new MiniSearch<IndexedDoc>({
    idField: "path",
    fields: Object.keys(BOOST),
    tokenize: (text, field) => (field === "pinyin" ? text.split(" ").filter(Boolean) : tokenizeText(text)),
    processTerm: (term) => term,
  });

  get size(): number {
    return this.docs.size;
  }

  upsert(doc: SearchDoc): void {
    if (this.docs.has(doc.path)) this.index.discard(doc.path);
    this.docs.set(doc.path, doc);
    const slash = doc.path.lastIndexOf("/");
    this.index.add({
      path: doc.path,
      basename: doc.basename,
      aliases: doc.aliases.join(" "),
      pinyin: [...pinyinKeys(doc.basename), ...doc.aliases.flatMap(pinyinKeys)].join(" "),
      headings: doc.headings.map((h) => h.text).join("\n"),
      tags: doc.tags.join(" "),
      folder: slash === -1 ? "" : doc.path.slice(0, slash),
      content: doc.content,
    });
  }

  remove(path: string): void {
    if (!this.docs.delete(path)) return;
    this.index.discard(path);
  }

  has(path: string): boolean {
    return this.docs.has(path);
  }

  search(query: string, limit = 60): SearchResult[] {
    const parts = queryParts(query);
    if (parts.length === 0) return [];
    const hits = this.index.search(parts.join(" "), {
      boost: BOOST,
      combineWith: "AND",
      prefix: (term) => !isCjk(term) || term.length === 1,
      fuzzy: (term) => (!isCjk(term) && term.length >= 4 ? 0.2 : 0),
    });
    const lowerParts = parts.map((p) => p.toLowerCase());
    const results: SearchResult[] = [];
    for (const hit of hits) {
      const doc = this.docs.get(hit.id as string);
      if (!doc) continue;
      const fields = new Set(Object.values(hit.match).flat());
      const kind: MatchKind = [...fields].some((f) => TITLE_FIELDS.has(f))
        ? "title"
        : fields.has("headings")
          ? "heading"
          : "content";
      // Bigram AND also matches scattered characters; a literal phrase is what the user meant.
      const title = doc.basename.toLowerCase();
      let score = hit.score;
      if (title === lowerParts.join(" ")) score *= 3;
      else if (lowerParts.every((p) => title.includes(p))) score *= 2;
      else if (lowerParts.every((p) => doc.content.toLowerCase().includes(p))) score *= 1.5;
      results.push({ path: doc.path, basename: doc.basename, extension: doc.extension, kind, score });
    }
    results.sort((a, b) => b.score - a.score);
    const top = results.slice(0, limit);
    for (const result of top) {
      if (result.kind === "title") continue;
      const doc = this.docs.get(result.path)!;
      result.excerpt = makeExcerpt(doc.content, query);
      const heading =
        result.kind === "heading"
          ? doc.headings.find((h) => findRanges(h.text, parts).length > 0)
          : undefined;
      result.line = heading ? heading.line : result.excerpt.line;
    }
    return top;
  }
}
