// Search behaviour that decides whether Chinese search feels right: bigram recall, single-character
// queries, mixed Chinese/English, pinyin on titles, literal-phrase ranking, excerpts and incremental updates.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(path.join(tmpdir(), "crisp-search-engine-"));
await esbuild.build({
  entryPoints: [path.join(root, "src/engine.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: path.join(outDir, "engine.mjs"),
  logLevel: "error",
});
const { SearchEngine, tokenizeText, makeExcerpt, makeExcerpts, highlightSegments } = await import(pathToFileURL(path.join(outDir, "engine.mjs")).href);

function doc(p, content = "", extra = {}) {
  const basename = p.split("/").pop().replace(/\.[^.]+$/, "");
  return { path: p, basename, extension: "md", content, headings: [], tags: [], aliases: [], ...extra };
}

function engineWith(...docs) {
  const engine = new SearchEngine();
  for (const d of docs) engine.upsert(d);
  return engine;
}

const paths = (results) => results.map((r) => r.path);

test("Chinese runs become bigrams, English words lowercase, mixed text splits at the script boundary", () => {
  assert.deepEqual(tokenizeText("知识库"), ["知识", "识库", "库"]);
  assert.deepEqual(tokenizeText("Obsidian插件 v2"), ["obsidian", "插件", "件", "v2"]);
  assert.deepEqual(tokenizeText("库"), ["库"]);
  assert.deepEqual(tokenizeText("，。!?"), []);
});

test("a Chinese word inside a long sentence is found without a dictionary", () => {
  const engine = engineWith(doc("a.md", "今天整理了一下个人知识库的目录结构"), doc("b.md", "完全无关的内容"));
  assert.deepEqual(paths(engine.search("知识库")), ["a.md"]);
  assert.deepEqual(paths(engine.search("目录结构")), ["a.md"]);
});

test("a single Chinese character matches words that start with it", () => {
  const engine = engineWith(doc("a.md", "插件开发"), doc("b.md", "完全无关"));
  assert.deepEqual(paths(engine.search("插")), ["a.md"]);
});

test("the literal phrase ranks above scattered bigrams", () => {
  const engine = engineWith(doc("scattered.md", "知识很重要。另一个话题是识库存。"), doc("literal.md", "知识库"));
  assert.equal(engine.search("知识库")[0].path, "literal.md");
});

test("all query terms must match", () => {
  const engine = engineWith(doc("a.md", "Obsidian 插件"), doc("b.md", "Obsidian 主题"));
  assert.deepEqual(paths(engine.search("obsidian 插件")), ["a.md"]);
});

test("English matches by prefix and tolerates a typo", () => {
  const engine = engineWith(doc("a.md", "Obsidian launcher"), doc("b.md", "nothing here"));
  assert.deepEqual(paths(engine.search("obsid")), ["a.md"]);
  assert.deepEqual(paths(engine.search("launchr")), ["a.md"]);
});

test("titles match by full pinyin, initials and from the middle of the title", () => {
  const engine = engineWith(doc("notes/知识库设计.md"), doc("other.md", "zhishi"));
  for (const q of ["zhishiku", "zsk", "zsksj", "sheji", "sj"]) {
    assert.equal(engine.search(q)[0]?.path, "notes/知识库设计.md", q);
  }
});

test("a title hit outranks a body hit and is reported as a title match", () => {
  const engine = engineWith(doc("body.md", "这里提到了周报"), doc("周报.md", "内容"));
  const results = engine.search("周报");
  assert.equal(results[0].path, "周报.md");
  assert.equal(results[0].kind, "title");
  assert.equal(results[1].kind, "content");
});

test("a heading hit is reported as a heading and carries its line", () => {
  const engine = engineWith(doc("a.md", "# 开头\n\n正文\n\n## 发布流程\n细节", { headings: [{ text: "发布流程", line: 4 }] }));
  const [hit] = engine.search("发布流程");
  assert.equal(hit.kind, "heading");
  assert.equal(hit.line, 4);
});

test("upsert replaces a document and remove forgets it", () => {
  const engine = engineWith(doc("a.md", "旧内容"));
  engine.upsert(doc("a.md", "新内容"));
  assert.deepEqual(paths(engine.search("旧内容")), []);
  assert.deepEqual(paths(engine.search("新内容")), ["a.md"]);
  engine.remove("a.md");
  assert.deepEqual(paths(engine.search("新内容")), []);
  assert.equal(engine.size, 0);
});

test("non-Markdown files are found by name only", () => {
  const engine = engineWith({ ...doc("files/产品手册.pdf"), extension: "pdf" });
  assert.equal(engine.search("产品手册")[0].kind, "title");
});

test("punctuation-only or empty queries return nothing", () => {
  const engine = engineWith(doc("a.md", "内容"));
  assert.deepEqual(engine.search("  "), []);
  assert.deepEqual(engine.search("，。"), []);
});

test("excerpts skip frontmatter, centre on the match and mark every query term", () => {
  const content = "---\ntitle: 知识库\n---\n" + "前言".repeat(40) + "\n这里讲知识库的搭建方法，也讲 Obsidian。\n";
  const excerpt = makeExcerpt(content, "知识库 obsidian");
  assert.ok(excerpt.text.includes("这里讲知识库的搭建方法"));
  assert.ok(!excerpt.text.includes("title:"));
  const marked = excerpt.ranges.map(([s, e]) => excerpt.text.slice(s, e));
  assert.deepEqual(marked, ["知识库", "Obsidian"]);
  assert.equal(excerpt.line, 4);
});

test("excerpts collapse line breaks and Markdown markers", () => {
  const excerpt = makeExcerpt("## 标题\n\n- **周报** 模板\n- 其他", "周报");
  assert.ok(!excerpt.text.includes("\n"));
  assert.ok(!excerpt.text.includes("**"));
  assert.deepEqual(excerpt.ranges.map(([s, e]) => excerpt.text.slice(s, e)), ["周报"]);
});

test("excerpts open at a sentence or word boundary, never inside an English word", () => {
  const en = makeExcerpt("An intro text; only release files.", "release");
  assert.equal(en.text, "…only release files.");
  const word = makeExcerpt("aaaa bbbb cccc dddd eeee ffff gggg hhhh release", "release");
  assert.equal(word.text, "…gggg hhhh release");
  const zh = makeExcerpt("前面有一段很长很长很长很长很长的铺垫文字，说的是别的事情。这里讲发布流程的细节", "发布流程");
  assert.ok(zh.text.startsWith("…这里讲发布流程"), zh.text);
  const comma = makeExcerpt("甲".repeat(10) + "，" + "乙".repeat(9) + "发布", "发布");
  assert.ok(!/^…[，,]/.test(comma.text), comma.text);
});

// Audit 2026-10-29 B3: the last character of a Chinese run had no token starting with it.
test("every character of a Chinese run is found on its own, in body, title and aliases", () => {
  const engine = engineWith(
    doc("body.md", "我们的知识库。下一句"),
    doc("notes/周报模板.md"),
    doc("alias.md", "", { aliases: ["学习笔记"] }),
  );
  for (const q of ["知", "识", "库", "句"]) assert.deepEqual(paths(engine.search(q)), ["body.md"], q);
  assert.deepEqual(paths(engine.search("板")), ["notes/周报模板.md"]);
  assert.deepEqual(paths(engine.search("记")), ["alias.md"]);
});

// B4: a typo found the file but the excerpt and line fell back to the top of the note.
test("a fuzzy match points the excerpt and line at the word that actually matched", () => {
  const engine = engineWith(doc("a.md", "# Title\n\nintro\n\nlauncher details\n"));
  const [hit] = engine.search("launchr");
  assert.equal(hit.line, 4);
  assert.deepEqual(hit.excerpt.ranges.map(([s, e]) => hit.excerpt.text.slice(s, e)), ["launcher"]);
});

// B5: one term in the folder and one in the body was treated as a pure title hit, losing the body position.
test("a query split between path and body keeps the body excerpt and line", () => {
  const engine = engineWith(doc("项目/a.md", "第一行\n\n\n\n预算细节在这里"));
  const [hit] = engine.search("项目 预算");
  assert.equal(hit.kind, "content");
  assert.equal(hit.line, 4);
  assert.ok(hit.excerpt.text.includes("预算细节"));
  assert.deepEqual(hit.excerpt.ranges.map(([s, e]) => hit.excerpt.text.slice(s, e)), ["预算"]);
});

// B6: a property-only hit showed unrelated body text.
test("a match only inside frontmatter shows that property line", () => {
  const engine = engineWith(doc("a.md", "---\ntitle: x\ncustom: uniquemarker\n---\nordinary body"));
  const [hit] = engine.search("uniquemarker");
  assert.equal(hit.line, 2);
  assert.ok(hit.excerpt.text.includes("custom: uniquemarker"), hit.excerpt.text);
  assert.deepEqual(hit.excerpt.ranges.map(([s, e]) => hit.excerpt.text.slice(s, e)), ["uniquemarker"]);
});

test("a title hit found through an alias shows the alias, not a bare file name", () => {
  const engine = engineWith(doc("claim-0c6f.md", "body", { aliases: ["特定模型和设置，不外推其他任务"] }));
  const [hit] = engine.search("设置");
  assert.equal(hit.kind, "title");
  assert.equal(hit.line, undefined);
  assert.deepEqual(hit.excerpt.ranges.map(([s, e]) => hit.excerpt.text.slice(s, e)), ["设置"]);
});

// R2-4: cleaning [[target|alias]] down to the alias deleted the only matched word.
test("a match inside a link target stays visible in the excerpt", () => {
  const wiki = makeExcerpt("prefix\n\n[[uniquemarker|显示文字]]", "uniquemarker");
  assert.equal(wiki.line, 2);
  assert.deepEqual(wiki.ranges.map(([s, e]) => wiki.text.slice(s, e)), ["uniquemarker"]);
  assert.ok(wiki.text.includes("显示文字"));
  const md = makeExcerpt("see [the docs](https://example.com/launchpad-guide) here", "launchpad");
  assert.deepEqual(md.ranges.map(([s, e]) => md.text.slice(s, e)), ["launchpad"]);
  const plain = makeExcerpt("[[other|显示文字]] 里的 uniquemarker", "uniquemarker");
  assert.ok(!plain.text.includes("other"), plain.text);
});

test("highlight segments never repeat text, even for overlapping ranges", () => {
  const segments = highlightSegments("切换行号", [[0, 2], [0, 2], [1, 3]]);
  assert.equal(segments.map((s) => s.text).join(""), "切换行号");
});

// Multi-hit preview: one excerpt per line that matches, in note order.
const LONG = "---\ntags: [发布]\n---\n# 发布流程\n\n第一步准备。\n\n中间无关的段落。\n\n第二步发布 Release，再次发布。\n\n最后一行也提到发布。\n";

test("every matching line gets its own excerpt with its line number", () => {
  const hits = makeExcerpts(LONG, "发布");
  assert.deepEqual(hits.map((h) => h.line), [3, 9, 11]);
  for (const hit of hits) assert.ok(hit.ranges.length > 0 && hit.text.includes("发布"), hit.text);
});

test("the number of excerpts is capped", () => {
  const content = Array.from({ length: 80 }, (_, i) => `第 ${i} 行提到发布`).join("\n");
  assert.equal(makeExcerpts(content, "发布", [], 50).length, 50);
});

test("a property-only match still yields that property line", () => {
  const hits = makeExcerpts("---\ncustom: uniquemarker\n---\nbody", "uniquemarker");
  assert.deepEqual(hits.map((h) => h.line), [1]);
});

test("content results report how many lines matched, and hits() lists them", () => {
  const engine = engineWith(doc("long.md", LONG));
  const [hit] = engine.search("发布");
  assert.equal(hit.hitCount, 3);
  assert.deepEqual(engine.hits("long.md", "发布").map((h) => h.line), [3, 9, 11]);
  assert.deepEqual(engine.hits("missing.md", "发布"), []);
});

test("a line counts as a hit only when it holds every query word, not a stray bigram", () => {
  const content = "只提到发布。\n讲流程的一行。\n这里有发布流程。\n再一次发布流程\n";
  assert.deepEqual(makeExcerpts(content, "发布流程").map((h) => h.line), [2, 3]);
  assert.deepEqual(makeExcerpts(content, "发布 流程").map((h) => h.line), [2, 3]);
  const engine = engineWith(doc("scattered.md", "只提到发布。\n讲流程的一行。\n"), doc("long.md", content));
  const scattered = engine.search("发布流程").find((r) => r.path === "scattered.md");
  assert.equal(scattered?.hitCount ?? 1, 1);
});

test("words answered by the path are not required on each body line", () => {
  const engine = engineWith(doc("项目/a.md", "开头\n预算一\n无关\n预算二\n"));
  const [hit] = engine.search("项目 预算");
  assert.equal(hit.hitCount, 2);
  assert.deepEqual(engine.hits("项目/a.md", "项目 预算").map((h) => h.line), [1, 3]);
});

test("a note with more hits than the list shows reports one past the cap", () => {
  const content = Array.from({ length: 80 }, (_, i) => `第 ${i} 行提到发布`).join("\n");
  const [hit] = engineWith(doc("many.md", content)).search("发布");
  assert.equal(hit.hitCount, 51);
});

// Audit round 4. These go through engine.search and engine.hits, so the matched terms are the real ones.
const hitLines = (engine, path, q) => engine.hits(path, q).map((h) => h.line);

test("R4-1: each English word needs its own match on the line", () => {
  const engine = engineWith(doc("a.md", "alpha only\nbeta only\nalpha beta together\n"));
  const [hit] = engine.search("alpha beta");
  assert.equal(hit.hitCount, 1);
  assert.equal(hit.line, 2);
  assert.deepEqual(hitLines(engine, "a.md", "alpha beta"), [2]);
});

test("R4-1: an English word matches at a word start, not inside another word", () => {
  const engine = engineWith(doc("a.md", "daily planning\nAI research\nemail archive\n"));
  const [hit] = engine.search("AI");
  assert.equal(hit.line, 1);
  assert.deepEqual(hitLines(engine, "a.md", "AI"), [1]);
  assert.deepEqual(hit.excerpt.ranges.map(([s, e]) => hit.excerpt.text.slice(s, e)), ["AI"]);
});

test("R4-1: a typo and an exact word combine per word", () => {
  const engine = engineWith(doc("a.md", "launcher only\nnotes only\nlauncher notes\n"));
  assert.deepEqual(hitLines(engine, "a.md", "launchr notes"), [2]);
});

test("R4-1: Chinese and English words in one query", () => {
  const engine = engineWith(doc("a.md", "插件很多\nobsidian 主题\nobsidian 插件开发\n"));
  assert.deepEqual(hitLines(engine, "a.md", "插件 obsidian"), [2]);
});

test("R4-2: the hit list uses matches from the current text, not the search that opened it", () => {
  const engine = engineWith(doc("a.md", "launcher first\nlauncher second\n"));
  engine.search("launchr");
  engine.upsert(doc("a.md", "launch first\nlaunch second\n"));
  assert.deepEqual(hitLines(engine, "a.md", "launchr"), [0, 1]);
});

test("R4-3: a heading that answers only part of the query does not override the excerpt line", () => {
  const engine = engineWith(
    doc("a.md", "# 预算说明\n\n无关内容\n\n预算 风险\n预算 风险\n", { headings: [{ text: "预算说明", line: 0 }] }),
  );
  const [hit] = engine.search("预算 风险");
  assert.equal(hit.line, 4);
  assert.equal(hit.excerpt.line, 4);
});

test("a hit-list row shows only its own line", () => {
  const engine = engineWith(doc("a.md", "第一行讲发布\n第二行无关内容很长很长\n第三行也讲发布\n"));
  const [first, second] = engine.hits("a.md", "发布");
  assert.ok(!first.text.includes("第二行"), first.text);
  assert.equal(second.line, 2);
});

test("a caller's order is applied before the limit, so the cut keeps what that order puts first", () => {
  const docs = Array.from({ length: 70 }, (_, i) => doc(`n${String(i).padStart(2, "0")}.md`, "hello world"));
  const engine = engineWith(...docs);
  const byPathDesc = (a, b) => b.path.localeCompare(a.path);
  const results = engine.search("hello", 60, byPathDesc);
  assert.equal(results.length, 60);
  assert.equal(results[0].path, "n69.md");
  assert.equal(results.at(-1).path, "n10.md");
});

test("B1: title hits are kept before the cut, whatever order the body results take", () => {
  const bodies = Array.from({ length: 60 }, (_, i) => doc(`b${String(i).padStart(2, "0")}.md`, "needle in the text"));
  const engine = engineWith(doc("needle.md", "nothing else"), ...bodies);
  const bodyFirst = (a, b) => (a.path === "needle.md" ? 1 : b.path === "needle.md" ? -1 : 0);
  const results = engine.search("needle", 60, bodyFirst);
  assert.equal(results.length, 60);
  assert.equal(results[0].path, "needle.md");
  assert.equal(results[0].kind, "title");
});

test("B3: results the caller no longer wants are dropped before the cut", () => {
  const engine = engineWith(doc("private/secret.md", "needle"), ...Array.from({ length: 60 }, (_, i) => doc(`n${i}.md`, "needle")));
  const results = engine.search("needle", 60, undefined, (path) => !path.startsWith("private/"));
  assert.equal(results.length, 60);
  assert.ok(results.every((r) => !r.path.startsWith("private/")));
});

test("B4: an attachment is found by its full file name, as a name match", () => {
  const engine = engineWith(
    doc("assets/photo.png", "", { extension: "png" }),
    doc("assets/Crisp-Focus.jpg", "", { extension: "jpg" }),
    doc("refs/paper.pdf", "", { extension: "pdf" }),
    doc("note.md", "see photo.png for details"),
  );
  for (const [query, path] of [["photo.png", "assets/photo.png"], ["Crisp-Focus.jpg", "assets/Crisp-Focus.jpg"], ["paper.pdf", "refs/paper.pdf"], ["photo", "assets/photo.png"]]) {
    const [first] = engine.search(query);
    assert.equal(first?.path, path, query);
    assert.equal(first.kind, "title", query);
  }
});

test("the full number of matches is reported next to the cut list, after the caller's filter", () => {
  const engine = engineWith(...Array.from({ length: 75 }, (_, i) => doc(`${i < 5 ? "private" : "notes"}/n${i}.md`, "needle")));
  const page = engine.searchPage("needle", { keep: (path) => !path.startsWith("private/") });
  assert.equal(page.results.length, 60);
  assert.equal(page.total, 70);
  assert.deepEqual(engine.searchPage("needle", { limit: 100 }).total, 75);
  assert.equal(engine.searchPage("").total, 0);
});

test("the literal-word bonus ignores case and takes regex characters literally", () => {
  const engine = engineWith(doc("fuzzy.md", "obsidiam notes"), doc("literal.md", "OBSIDIAN notes"), doc("plus.md", "C++ (and more)"));
  assert.equal(engine.search("obsidian")[0].path, "literal.md");
  assert.deepEqual(paths(engine.search("C++")), ["plus.md"]);
  assert.deepEqual(paths(engine.search("(and")), ["plus.md"]);
});

test("accept() drops results by kind before the cut and the count", () => {
  const engine = engineWith(doc("needle.md", "x"), ...Array.from({ length: 70 }, (_, i) => doc(`b${i}.md`, "needle")));
  const names = engine.searchPage("needle", { accept: (r) => r.kind === "title" });
  assert.deepEqual([names.total, names.results.map((r) => r.path)], [1, ["needle.md"]]);
  const bodies = engine.searchPage("needle", { accept: (r) => r.kind !== "title" });
  assert.deepEqual([bodies.total, bodies.results.length], [70, 60]);
});

test("filters alone list every kept file in the given order, counted and cut", () => {
  const engine = engineWith(...Array.from({ length: 65 }, (_, i) => doc(`f${String(i).padStart(2, "0")}.md`)), doc("x.png", "", { extension: "png" }));
  const page = engine.listPage({ keep: (path) => path.endsWith(".md"), order: (a, b) => b.path.localeCompare(a.path) });
  assert.equal(page.total, 65);
  assert.equal(page.results.length, 60);
  assert.equal(page.results[0].path, "f64.md");
  assert.equal(page.results[0].kind, "title");
  assert.equal(engine.doc("x.png").extension, "png");
});
