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
const { SearchEngine, tokenizeText, makeExcerpt, highlightSegments } = await import(pathToFileURL(path.join(outDir, "engine.mjs")).href);

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
