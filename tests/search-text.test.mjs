// Regression: accents must not rely on fuzzy fallback, split words, or move highlights off the original.
import { test } from "node:test";
import assert from "node:assert/strict";
import esbuild from "esbuild";

async function load(module) {
  const build = await esbuild.build({
    entryPoints: [new URL(`../src/${module}.ts`, import.meta.url).pathname],
    bundle: true, format: "esm", platform: "node", write: false, logLevel: "error",
  });
  return import(`data:text/javascript;base64,${Buffer.from(build.outputFiles[0].text).toString("base64")}`);
}
const { SearchEngine, tokenizeText, highlightRanges, makeExcerpt } = await load("engine");
const { CommandIndex } = await load("commands");
const { ProviderIndex } = await load("providers");
const { matchesFilters, suggestValues } = await load("filters");
const doc = (path, content = "", extra = {}) => ({
  path, basename: path.split("/").pop().replace(/\.[^.]+$/, ""), extension: "md", content,
  headings: [], tags: [], aliases: [], ...extra,
});
const marked = (text, ranges) => ranges.map(([from, to]) => text.slice(from, to));
const pairs = [
  ["cafe", "café"], ["cafe", "cafe\u0301"], ["lodz", "Łódź"], ["strasse", "Straße"],
  ["coeur", "cœur"], ["aether", "Æther"], ["oresund", "Øresund"], ["dak", "Đắk"],
  ["deth", "Ðeth"], ["haga", "Ħaġa"], ["island", "ıSLAND"], ["thing", "Þing"],
];

test("accent folding finds body text even with five ordinary hits, and works in both directions", () => {
  for (const [plain, accented] of pairs) {
    const engine = new SearchEngine();
    engine.upsert(doc("target.md", accented));
    for (let i = 0; i < 5; i++) engine.upsert(doc(`plain-${i}.md`, plain));
    for (const query of [plain, accented]) {
      const result = engine.search(query).find((r) => r.path === "target.md");
      assert.ok(result, `${query} finds ${accented} without fuzzy fallback`);
      assert.deepEqual(marked(result.excerpt.text, result.excerpt.ranges), [accented]);
    }
  }
});

test("folded names, aliases, headings, folders and properties retain their match kind and original text", () => {
  const cases = [
    [doc("Straße.md"), "title"],
    [doc("alias.md", "", { aliases: ["Straße"] }), "title"],
    [doc("heading.md", "# Straße", { headings: [{ text: "Straße", line: 0 }] }), "heading"],
    [doc("Straße/note.md"), "folder"],
    [doc("property.md", "---\ncity: Straße\n---\nNothing here"), "content"],
  ];
  for (const [entry, kind] of cases) {
    const engine = new SearchEngine();
    engine.upsert(entry);
    const [result] = engine.search("strasse");
    assert.equal(result?.kind, kind, entry.path);
    if (result.excerpt) assert.deepEqual(marked(result.excerpt.text, result.excerpt.ranges), ["Straße"]);
    assert.equal(engine.doc(entry.path).content, entry.content, "source stays untouched");
  }
});

test("highlights map expansions, decomposed accents and supplementary characters to original offsets", () => {
  const text = "😀 Straße cafe\u0301 Œuf";
  assert.deepEqual(highlightRanges(text, "strasse cafe oeuf"), [[3, 9], [10, 15], [16, 19]]);
  assert.deepEqual(highlightRanges("😀 ß!", "s ss"), [[3, 4]], "expanded letters map to one original character");
  const excerpt = makeExcerpt("unrelated\n" + text, "strasse cafe");
  assert.equal(excerpt.line, 1);
  assert.deepEqual(marked(excerpt.text, excerpt.ranges), ["Straße", "cafe\u0301"]);
});

test("accent folding keeps combining accents inside words without changing Chinese, kana or hangul tokens", () => {
  assert.deepEqual(tokenizeText("Cafe\u0301ine"), ["cafeine"]);
  assert.deepEqual(tokenizeText("知识库 ガイド 한국어"), ["知识", "识库", "库", "ガイ", "イド", "ド", "한국", "국어", "어"]);
  const engine = new SearchEngine();
  engine.upsert(doc("ガイド.md"));
  assert.deepEqual(engine.search("カイト"), [], "kana voicing is not a Latin accent");
});

test("commands and host names fold accents and highlight their original names", () => {
  for (const [plain, accented] of pairs) {
    const index = new CommandIndex([{ id: "target", name: `😀 ${accented}: 打开` }]);
    const [hit] = index.search(plain);
    assert.equal(hit?.id, "target", plain);
    assert.deepEqual(marked(hit.name, hit.ranges), [accented]);
  }
  const index = new CommandIndex([{ id: "a", name: "Café Reload" }]);
  assert.equal(index.search("cr")[0]?.id, "a", "initials use the same folded words");
});

test("providers fold both title and hidden body while retaining completion order", () => {
  const index = new ProviderIndex([
    { id: "done", title: "Straße", done: true },
    { id: "open", title: "Straße" },
    { id: "body", title: "速记", text: "Łódź café" },
  ]);
  assert.deepEqual(index.search("strasse").map((m) => m.entry.id), ["open", "done"]);
  assert.deepEqual(marked(index.search("strasse")[0].entry.title, index.search("strasse")[0].ranges), ["Straße"]);
  assert.deepEqual(index.search("lodz cafe").map((m) => m.entry.id), ["body"]);
  assert.deepEqual(index.search("lodz cafe")[0].ranges, []);
});

test("filter values and suggestions fold accents but keep folder and tag boundaries", () => {
  const entry = doc("Straße/café/a.md", "", { tags: ["Łódź/旅行"] });
  assert.equal(matchesFilters(entry, [{ kind: "tag", value: "lodz" }, { kind: "path", value: "strasse/cafe" }]), true);
  assert.equal(matchesFilters(entry, [{ kind: "path", value: "cafe" }]), true);
  assert.equal(matchesFilters(entry, [{ kind: "tag", value: "lod" }]), false);
  assert.equal(matchesFilters(entry, [{ kind: "path", value: "strass" }]), false);
  assert.deepEqual(suggestValues("cafe", new Map([["café", 2], ["Other café", 4]])), ["café", "Other café"]);
});

test("folded link targets stay visible in excerpts and hits open the correct original line", () => {
  const engine = new SearchEngine();
  engine.upsert(doc("note.md", "---\nkind: travel\n---\nNothing\n[[Straße|街道]]\n😀 Cafe\u0301"));
  const [result] = engine.search("strasse");
  assert.ok(result);
  assert.ok(result.excerpt.text.includes("Straße"));
  assert.deepEqual(marked(result.excerpt.text, result.excerpt.ranges), ["Straße"]);
  assert.equal(result.line, 4);
  const [hit] = engine.hits("note.md", "cafe");
  assert.equal(hit.line, 5);
  assert.deepEqual(marked(hit.text, hit.ranges), ["Cafe\u0301"]);
});
