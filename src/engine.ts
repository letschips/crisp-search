import MiniSearch, { SearchOptions } from "minisearch";
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
      for (let i = 0; i + 1 < cjk.length; i++) tokens.push(cjk.slice(i, i + 2));
      // The last character starts no bigram, so it gets its own token for single-character queries.
      tokens.push(cjk[cjk.length - 1]);
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
  terms?: string[];
  // Matching lines in the body, up to MAX_HITS + 1; set on heading and content results.
  hitCount?: number;
}

interface IndexedDoc {
  path: string;
  basename: string;
  aliases: string;
  pinyin: string;
  headings: string;
  tags: string;
  folder: string;
  properties: string;
  content: string;
}

const BOOST = { basename: 10, aliases: 8, pinyin: 6, headings: 4, tags: 3, folder: 2, properties: 2, content: 1 };
const TITLE_FIELDS = new Set(["basename", "aliases", "pinyin", "folder"]);
const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;

function queryParts(query: string): string[] {
  return query
    .trim()
    .split(/\s+/)
    .filter((part) => tokenizeText(part).length > 0);
}

const FUZZY = 0.2;
const MAX_FUZZY = 6;
const LATIN_WORD_CHAR = /[a-z0-9]/;

// Same distance MiniSearch allows for a fuzzy term of this length.
function fuzzyDistance(term: string): number {
  return isCjk(term) || term.length < 4 ? 0 : Math.min(MAX_FUZZY, Math.round(term.length * FUZZY));
}

function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length];
}

// The indexed terms that one English query token could have matched: by prefix or within fuzzy distance.
// Terms that matched other query words are not this token's evidence.
function termsForToken(token: string, matchedTerms: string[]): string[] {
  const max = fuzzyDistance(token);
  return matchedTerms.filter(
    (term) => !isCjk(term) && term !== token && (term.startsWith(token) || (max > 0 && editDistance(term, token, max) <= max)),
  );
}

// Chinese matches anywhere; an English needle only where a word starts, as the index tokenizes it.
function occurrences(lower: string, needle: string): number[] {
  const latin = !isCjk(needle);
  const found: number[] = [];
  for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, at + 1)) {
    if (!latin || at === 0 || !LATIN_WORD_CHAR.test(lower[at - 1])) found.push(at);
  }
  return found;
}

// Ways to locate one query word, most exact first: the word itself, then its tokens (a Chinese word as
// bigrams), then for English tokens the fuzzy terms that matched it.
function needleLevels(part: string, matchedTerms: string[]): string[][] {
  const tokens = tokenizeText(part);
  const fuzzy = tokens.filter((token) => !isCjk(token)).flatMap((token) => termsForToken(token, matchedTerms));
  return [[part.toLowerCase()], tokens, fuzzy];
}

interface PreparedPart {
  exact: string;
  tokens: string[][];
  levels: string[][];
}

// Fuzzy candidates depend on the query and index match, never on the line being scanned.
function prepareParts(parts: string[], matchedTerms: string[]): PreparedPart[] {
  return parts.map((part) => {
    const tokens = tokenizeText(part);
    const alternatives = tokens.map((token) => [token, ...(!isCjk(token) ? termsForToken(token, matchedTerms) : [])]);
    return {
      exact: part.toLowerCase(),
      tokens: alternatives,
      levels: [[part.toLowerCase()], tokens, alternatives.flatMap((terms) => terms.slice(1))],
    };
  });
}

function findPreparedRanges(text: string, parts: PreparedPart[]): [number, number][] {
  const lower = text.toLowerCase();
  const ranges: [number, number][] = [];
  for (const part of parts) {
    for (const needles of part.levels) {
      const before = ranges.length;
      for (const needle of needles) {
        for (const at of occurrences(lower, needle)) ranges.push([at, at + needle.length]);
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

function findRanges(text: string, parts: string[], matchedTerms: string[] = []): [number, number][] {
  return findPreparedRanges(text, prepareParts(parts, matchedTerms));
}

// Existence checks stop at the first occurrence instead of allocating every match on a long line.
function hasOccurrence(lower: string, needle: string): boolean {
  const latin = !isCjk(needle);
  for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, at + 1)) {
    if (!latin || at === 0 || !LATIN_WORD_CHAR.test(lower[at - 1])) return true;
  }
  return false;
}

// A line answers a query word when it holds the word, or every token of it: Chinese tokens anywhere,
// English tokens at a word start or as one of the fuzzy terms that matched that token.
function lineHolds(lowerLine: string, part: PreparedPart): boolean {
  return hasOccurrence(lowerLine, part.exact) ||
    part.tokens.every((alternatives) => alternatives.some((term) => hasOccurrence(lowerLine, term)));
}

export function highlightRanges(text: string, query: string): [number, number][] {
  return findRanges(text, queryParts(query));
}

// Splits text for rendering; overlapping or repeated ranges never repeat a character.
export function highlightSegments(text: string, ranges: [number, number][]): { text: string; mark: boolean }[] {
  const segments: { text: string; mark: boolean }[] = [];
  let at = 0;
  for (const [rawStart, end] of [...ranges].sort((a, b) => a[0] - b[0])) {
    const start = Math.max(rawStart, at);
    if (end <= start) continue;
    if (start > at) segments.push({ text: text.slice(at, start), mark: false });
    segments.push({ text: text.slice(start, end), mark: true });
    at = end;
  }
  if (at < text.length) segments.push({ text: text.slice(at), mark: false });
  return segments;
}

// Links collapse to their display text, unless the hidden target is what matched: then it stays visible.
function cleanMarkdown(text: string, needles: string[]): string {
  const matched = (hidden: string) => needles.some((needle) => hidden.toLowerCase().includes(needle));
  return text
    .replace(/!?\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g, (_, target: string, alias?: string) =>
      alias === undefined ? target : matched(target) ? `${alias}（${target}）` : alias,
    )
    .replace(/\[([^\]]*)\]\(([^)]*)\)/g, (_, label: string, url: string) => (matched(url) ? `${label} (${url})` : label))
    .replace(/(\*\*|__|~~|==|`)/g, "")
    .replace(/^\s*(#{1,6}\s+|[-*+]\s+(\[.\]\s+)?|\d+\.\s+|>\s*)/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

const EXCERPT_BEFORE = 10;
const SENTENCE_BREAKS = ["。", "！", "？", "；", ". ", "! ", "? ", "; "];
const WORD_CHAR = /[A-Za-z0-9_]/;
const EXCERPT_AFTER = 140;

function splitFrontmatter(content: string): { frontmatter: string; body: string } {
  const length = content.match(FRONTMATTER_RE)?.[0].length ?? 0;
  return { frontmatter: content.slice(0, length), body: content.slice(length) };
}

function lineAt(text: string, offset: number): number {
  return (text.slice(0, offset).match(/\n/g) ?? []).length;
}

// Offsets of the first match on each body line that answers every query word, in note order.
function hitStarts(body: string, parts: string[], matchedTerms: string[], limit: number): number[] {
  const starts: number[] = [];
  const prepared = prepareParts(parts, matchedTerms);
  let offset = 0;
  for (const line of body.split("\n")) {
    const lower = line.toLowerCase();
    if (lower.trim() && prepared.every((part) => lineHolds(lower, part))) {
      starts.push(offset + (findPreparedRanges(line, prepared)[0]?.[0] ?? 0));
      if (starts.length >= limit) break;
    }
    offset += line.length + 1;
  }
  return starts;
}

function propertyExcerpt(frontmatter: string, parts: string[], matchedTerms: string[]): Excerpt | null {
  const property = findRanges(frontmatter, parts, matchedTerms)[0];
  if (!property) return null;
  const lineStart = frontmatter.lastIndexOf("\n", property[0] - 1) + 1;
  const lineEnd = frontmatter.indexOf("\n", property[0]);
  const text = frontmatter.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim();
  return { text, ranges: findRanges(text, parts, matchedTerms), line: lineAt(frontmatter, property[0]) };
}

// A hit-list row stays on its own line; a result excerpt may run on for context.
function excerptAt(body: string, at: number, line: number, parts: string[], matchedTerms: string[], ownLine = false): Excerpt {
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
  const needles = parts.flatMap((part) => needleLevels(part, matchedTerms).flat());
  const lineEnd = body.indexOf("\n", at);
  const end = ownLine && lineEnd !== -1 ? Math.min(lineEnd, at + EXCERPT_AFTER) : at + EXCERPT_AFTER;
  let text = cleanMarkdown(body.slice(from, end), needles);
  if (from > lineStart) text = "…" + text;
  return { text, ranges: findRanges(text, parts, matchedTerms), line };
}

export function makeExcerpt(content: string, query: string, matchedTerms: string[] = []): Excerpt {
  const parts = queryParts(query);
  const { frontmatter, body } = splitFrontmatter(content);
  return excerptForMatch(frontmatter, body, parts, matchedTerms, hitStarts(body, parts, matchedTerms, 1));
}

function excerptForMatch(frontmatter: string, body: string, parts: string[], matchedTerms: string[], starts: number[]): Excerpt {
  // Words scattered over several lines still found the note; then show where the first of them is.
  const at = starts[0] ?? findRanges(body, parts, matchedTerms)[0]?.[0];
  if (at === undefined) {
    // Only a property matched: show that property line rather than unrelated body text.
    const property = propertyExcerpt(frontmatter, parts, matchedTerms);
    if (property) return property;
  }
  const offset = at ?? 0;
  return excerptAt(body, offset, lineAt(frontmatter, frontmatter.length) + lineAt(body, offset), parts, matchedTerms);
}

export const MAX_HITS = 50;

// One excerpt per matching line, for the in-note hit list.
export function makeExcerpts(content: string, query: string, matchedTerms: string[] = [], limit = MAX_HITS): Excerpt[] {
  const parts = queryParts(query);
  const { frontmatter, body } = splitFrontmatter(content);
  const starts = hitStarts(body, parts, matchedTerms, limit);
  if (starts.length === 0) {
    if (findRanges(body, parts, matchedTerms).length > 0) return [makeExcerpt(content, query, matchedTerms)];
    const property = propertyExcerpt(frontmatter, parts, matchedTerms);
    return property ? [property] : [];
  }
  const excerpts: Excerpt[] = [];
  // Count lines incrementally; recounting from the top for each hit is quadratic on long notes.
  let line = lineAt(frontmatter, frontmatter.length);
  let counted = 0;
  for (const at of starts) {
    line += lineAt(body.slice(counted, at), at - counted);
    counted = at;
    excerpts.push(excerptAt(body, at, line, parts, matchedTerms, true));
  }
  return excerpts;
}

const SEARCH_OPTIONS: SearchOptions = {
  boost: BOOST,
  combineWith: "AND",
  prefix: (term: string) => !isCjk(term) || term.length === 1,
  fuzzy: (term: string) => (fuzzyDistance(term) ? FUZZY : 0),
};

export class SearchEngine {
  private readonly docs = new Map<string, SearchDoc>();
  private readonly titleKeys = new Map<string, { text: string; pinyin: string[] }>();
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
    const folder = slash === -1 ? "" : doc.path.slice(0, slash);
    const pinyin = [...pinyinKeys(doc.basename), ...doc.aliases.flatMap(pinyinKeys)];
    // The full file name counts as a name too, so "photo.png" finds the image it names.
    const filename = `${doc.basename}.${doc.extension}`;
    this.titleKeys.set(doc.path, { text: [doc.basename, filename, ...doc.aliases, folder].join("\n").toLowerCase(), pinyin });
    const { frontmatter, body } = splitFrontmatter(doc.content);
    this.index.add({
      path: doc.path,
      // Attachments are searched by name only, extension included; ".md" on every note would only add noise.
      basename: doc.extension === "md" ? doc.basename : filename,
      aliases: doc.aliases.join(" "),
      pinyin: pinyin.join(" "),
      headings: doc.headings.map((h) => h.text).join("\n"),
      tags: doc.tags.join(" "),
      folder,
      properties: frontmatter,
      content: body,
    });
  }

  remove(path: string): void {
    if (!this.docs.delete(path)) return;
    this.titleKeys.delete(path);
    this.index.discard(path);
  }

  has(path: string): boolean {
    return this.docs.has(path);
  }

  // Matches this note against the query as it is now, so the list never mixes old terms with new text.
  hits(path: string, query: string): Excerpt[] {
    const doc = this.docs.get(path);
    const parts = queryParts(query);
    if (!doc || parts.length === 0) return [];
    const [hit] = this.index.search(parts.join(" "), { ...SEARCH_OPTIONS, filter: (result) => result.id === path });
    return hit ? makeExcerpts(doc.content, this.bodyQuery(path, parts), hit.terms) : [];
  }

  private inTitle(path: string, part: string): boolean {
    const keys = this.titleKeys.get(path);
    const lower = part.toLowerCase();
    return !!keys && (keys.text.includes(lower) || keys.pinyin.some((key) => key.startsWith(lower)));
  }

  // The words the body has to answer: those the name, aliases or folder already answer are dropped,
  // unless that leaves nothing.
  private bodyQuery(path: string, parts: string[]): string {
    const body = parts.filter((part) => !this.inTitle(path, part));
    return (body.length ? body : parts).join(" ");
  }

  paths(): string[] {
    return [...this.docs.keys()];
  }

  // Name matches come first and `order` sorts within each group (relevance by default), both before `limit`,
  // so the cut never drops a name match the panel would list first. `keep` drops paths the caller no longer
  // searches, such as newly excluded folders whose entries have not been removed yet.
  search(
    query: string,
    limit = 60,
    order?: (a: SearchResult, b: SearchResult) => number,
    keep?: (path: string) => boolean,
  ): SearchResult[] {
    const parts = queryParts(query);
    if (parts.length === 0) return [];
    const hits = this.index.search(parts.join(" "), SEARCH_OPTIONS);
    const lowerParts = parts.map((p) => p.toLowerCase());
    const results: SearchResult[] = [];
    for (const hit of hits) {
      const doc = this.docs.get(hit.id as string);
      if (!doc || (keep && !keep(doc.path))) continue;
      const fields = new Set(Object.values(hit.match).flat());
      // A title hit needs every query word answered by the name, aliases or folder; otherwise the body
      // carries part of the match and the result must show where.
      const inTitle = (part: string) => this.inTitle(doc.path, part);
      const kind: MatchKind =
        [...fields].every((f) => TITLE_FIELDS.has(f)) || lowerParts.every(inTitle)
          ? "title"
          : fields.has("headings")
            ? "heading"
            : "content";
      // Bigram AND also matches scattered characters; a literal phrase is what the user meant.
      const title = doc.basename.toLowerCase();
      const phrase = lowerParts.join(" ");
      let score = hit.score;
      if (title === phrase || `${title}.${doc.extension}` === phrase) score *= 3;
      else if (lowerParts.every((p) => title.includes(p))) score *= 2;
      else {
        const lowerContent = doc.content.toLowerCase();
        if (lowerParts.every((p) => lowerContent.includes(p))) score *= 1.5;
      }
      results.push({ path: doc.path, basename: doc.basename, extension: doc.extension, kind, score, terms: hit.terms });
    }
    const within = order ?? ((a: SearchResult, b: SearchResult) => b.score - a.score);
    const group = (r: SearchResult) => (r.kind === "title" ? 0 : 1);
    results.sort((a, b) => group(a) - group(b) || within(a, b));
    const top = results.slice(0, limit);
    for (const result of top) {
      const doc = this.docs.get(result.path)!;
      if (result.kind === "title") {
        // Found through an alias: show it, or the row is a file name with no visible reason to be here.
        const terms = result.terms ?? [];
        const alias = findRanges(doc.basename, parts, terms).length
          ? undefined
          : doc.aliases.find((a) => findRanges(a, parts, terms).length > 0);
        if (alias) result.excerpt = makeExcerpt(alias, query, terms);
        continue;
      }
      const terms = result.terms ?? [];
      const bodyQuery = this.bodyQuery(doc.path, parts);
      const lineParts = queryParts(bodyQuery);
      const { frontmatter, body } = splitFrontmatter(doc.content);
      const starts = hitStarts(body, lineParts, terms, MAX_HITS + 1);
      result.excerpt = excerptForMatch(frontmatter, body, lineParts, terms, starts);
      // Counted one past the cap, so the panel can tell "50" from "more than 50".
      result.hitCount = Math.max(1, starts.length);
      // A heading is the place to open only when it answers the whole query; otherwise the excerpt is.
      const prepared = prepareParts(lineParts, terms);
      const heading =
        result.kind === "heading"
          ? doc.headings.find((h) => prepared.every((part) => lineHolds(h.text.toLowerCase(), part)))
          : undefined;
      result.line = heading ? heading.line : result.excerpt.line;
    }
    return top;
  }
}
