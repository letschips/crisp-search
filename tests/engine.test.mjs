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
const { SearchEngine, tokenizeText, makeExcerpt } = await import(pathToFileURL(path.join(outDir, "engine.mjs")).href);

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
  assert.deepEqual(tokenizeText("知识库"), ["知识", "识库"]);
  assert.deepEqual(tokenizeText("Obsidian插件 v2"), ["obsidian", "插件", "v2"]);
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
