// Result orders the panel offers: relevance stays the base of the mixed order, time and name orders ignore it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(path.join(tmpdir(), "crisp-search-sort-"));
await esbuild.build({
  entryPoints: [path.join(root, "src/sort.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: path.join(outDir, "sort.mjs"),
  logLevel: "error",
});
const { resultOrder, isSortOrder } = await import(pathToFileURL(path.join(outDir, "sort.mjs")).href);

const DAY = 86_400_000;
const NOW = 100 * DAY;
const stats = {
  "old.md": { mtime: NOW - 60 * DAY, ctime: NOW - 90 * DAY },
  "fresh.md": { mtime: NOW - DAY, ctime: NOW - 30 * DAY },
  "new.md": { mtime: NOW - 10 * DAY, ctime: NOW - 2 * DAY },
};
const r = (p, score, basename = p.replace(".md", "")) => ({ path: p, basename, score });
const sorted = (order, results) =>
  [...results].sort(resultOrder(order, (p) => stats[p], NOW) ?? ((a, b) => b.score - a.score)).map((x) => x.path);

test("relevance keeps the engine order", () => {
  assert.equal(resultOrder("relevance", () => undefined, NOW), undefined);
});

test("the mixed order lifts a recent note past a slightly better old one, not past a much better one", () => {
  assert.deepEqual(sorted("recent", [r("old.md", 10), r("fresh.md", 9)]), ["fresh.md", "old.md"]);
  assert.deepEqual(sorted("recent", [r("old.md", 20), r("fresh.md", 9)]), ["old.md", "fresh.md"]);
});

test("time orders put the newest first, and name order is alphabetical with numbers in order", () => {
  const all = [r("old.md", 30), r("fresh.md", 20), r("new.md", 10)];
  assert.deepEqual(sorted("modified", all), ["fresh.md", "new.md", "old.md"]);
  assert.deepEqual(sorted("created", all), ["new.md", "fresh.md", "old.md"]);
  assert.deepEqual(sorted("name", [r("a.md", 1, "笔记 10"), r("b.md", 2, "笔记 2")]), ["b.md", "a.md"]);
});

test("unknown stored values are rejected", () => {
  assert.equal(isSortOrder("modified"), true);
  assert.equal(isSortOrder("random"), false);
});
