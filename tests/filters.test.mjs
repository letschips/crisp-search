// Scope tabs and filter tokens: what a finished token becomes, what each filter accepts, and value suggestions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(path.join(tmpdir(), "crisp-search-filters-"));
await esbuild.build({
  entryPoints: [path.join(root, "src/filters.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: path.join(outDir, "filters.mjs"),
  logLevel: "error",
});
const { splitQuery, matchesFilters, scopeAccepts, suggestValues, filterLabel } = await import(
  pathToFileURL(path.join(outDir, "filters.mjs")).href
);

test("finished tokens become filters, the token being typed stays pending, the rest is the search text", () => {
  assert.deepEqual(splitQuery("#读书 预算 path:raw/inbox ext:pdf"), {
    text: "预算",
    filters: [
      { kind: "tag", value: "读书" },
      { kind: "path", value: "raw/inbox" },
    ],
    pending: { kind: "ext", value: "pdf" },
  });
  assert.deepEqual(splitQuery("预算 #"), { text: "预算", filters: [], pending: { kind: "tag", value: "" } });
  assert.deepEqual(splitQuery("预算 "), { text: "预算", filters: [], pending: null });
  assert.deepEqual(splitQuery("PATH:Notes/ 计划").filters, [{ kind: "path", value: "Notes" }]);
  assert.deepEqual(splitQuery("ext:.PNG 图").filters, [{ kind: "ext", value: "png" }]);
});

test("a lone # or a word with # inside is search text, not a filter", () => {
  assert.deepEqual(splitQuery("C# 入门").text, "C# 入门");
  assert.deepEqual(splitQuery("# 标题").filters, []);
});

test("filters: nested tags, folders anywhere in the path, extensions; all must hold", () => {
  const doc = { path: "Topics/self-media/raw/inbox/a.md", extension: "md", tags: ["读书/笔记", "Project"] };
  const ok = (...filters) => matchesFilters(doc, filters);
  assert.equal(ok({ kind: "tag", value: "读书" }), true);
  assert.equal(ok({ kind: "tag", value: "读书/笔记" }), true);
  assert.equal(ok({ kind: "tag", value: "读" }), false);
  assert.equal(ok({ kind: "tag", value: "project" }), true);
  assert.equal(ok({ kind: "path", value: "raw/inbox" }), true);
  assert.equal(ok({ kind: "path", value: "Topics" }), true);
  assert.equal(ok({ kind: "path", value: "raw/in" }), false);
  assert.equal(ok({ kind: "ext", value: "md" }), true);
  assert.equal(ok({ kind: "tag", value: "读书" }, { kind: "ext", value: "pdf" }), false);
});

test("scopes: notes are name matches of notes, content is body matches, attachments are non-note files", () => {
  assert.equal(scopeAccepts("notes", "title", "md"), true);
  assert.equal(scopeAccepts("notes", "title", "canvas"), true);
  assert.equal(scopeAccepts("notes", "content", "md"), false);
  assert.equal(scopeAccepts("notes", "title", "png"), false);
  assert.equal(scopeAccepts("content", "heading", "md"), true);
  assert.equal(scopeAccepts("content", "title", "md"), false);
  assert.equal(scopeAccepts("attachments", "title", "pdf"), true);
  assert.equal(scopeAccepts("attachments", "title", "md"), false);
  assert.equal(scopeAccepts("all", "content", "md"), true);
});

test("value suggestions: matching anywhere, prefix matches and frequent values first, capped", () => {
  const counts = new Map([["读书/笔记", 3], ["阅读", 9], ["书单", 1], ["工作", 20]]);
  assert.deepEqual(suggestValues("书", counts), ["书单", "读书/笔记"]);
  assert.deepEqual(suggestValues("", counts, 2), ["工作", "阅读"]);
  assert.equal(filterLabel({ kind: "path", value: "raw" }), "文件夹 raw");
});

test("folder-only matches belong to neither the notes nor the content tab", () => {
  assert.equal(scopeAccepts("notes", "folder", "md"), false);
  assert.equal(scopeAccepts("content", "folder", "md"), false);
  assert.equal(scopeAccepts("all", "folder", "md"), true);
  assert.equal(scopeAccepts("attachments", "folder", "png"), true);
});
