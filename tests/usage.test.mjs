// What opening notes teaches the ranking, and that it survives a restart, a rename and a failed write.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(path.join(tmpdir(), "crisp-search-usage-"));
await esbuild.build({
  entryPoints: [path.join(root, "src/usage.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: path.join(outDir, "usage.mjs"),
  logLevel: "error",
});
const { UsageStore } = await import(pathToFileURL(path.join(outDir, "usage.mjs")).href);

const DAY = 86_400_000;
function fakeBackend() {
  const tables = { visits: new Map(), queries: new Map() };
  return {
    tables,
    all: async (table) => [...tables[table]],
    put: async (table, key, value) => void tables[table].set(key, value),
    remove: async (table, key) => void tables[table].delete(key),
    clear: async () => {
      tables.visits.clear();
      tables.queries.clear();
    },
  };
}

test("a note is learned for its words on the second open, not the first", () => {
  const usage = new UsageStore(fakeBackend());
  usage.recordOpen("知识库", "a.md");
  assert.deepEqual(usage.learned("知识库"), []);
  usage.recordOpen("  知识库 ", "a.md");
  assert.deepEqual(usage.learned("知识库"), ["a.md"]);
  assert.deepEqual(usage.learned("知识"), []);
});

test("case and spacing do not split what was learned", () => {
  const usage = new UsageStore(fakeBackend());
  usage.recordOpen("Health  Check", "a.md");
  usage.recordOpen("health check", "a.md");
  assert.deepEqual(usage.learned("HEALTH CHECK"), ["a.md"]);
});

test("the most opened note comes first and at most three are returned", () => {
  const usage = new UsageStore(fakeBackend());
  const opens = { "a.md": 2, "b.md": 5, "c.md": 3, "d.md": 4 };
  for (const [note, count] of Object.entries(opens)) for (let i = 0; i < count; i++) usage.recordOpen("q", note);
  assert.deepEqual(usage.learned("q"), ["b.md", "d.md", "c.md"]);
});

test("switching back to a note within minutes is one visit", () => {
  let now = 100 * DAY;
  const backend = fakeBackend();
  const usage = new UsageStore(backend, () => now);
  usage.recordVisit("a.md");
  now += 60_000;
  usage.recordVisit("a.md");
  assert.equal(backend.tables.visits.get("a.md").length, 1);
  now += 10 * 60_000;
  usage.recordVisit("a.md");
  assert.equal(backend.tables.visits.get("a.md").length, 2);
});

test("visits lift a note a little and fade with time; opening it from these words lifts it more", () => {
  let now = 100 * DAY;
  const usage = new UsageStore(fakeBackend(), () => now);
  assert.equal(usage.boost("q", "a.md"), 0);
  usage.recordVisit("a.md");
  const fresh = usage.boost("q", "a.md");
  assert.ok(fresh > 0 && fresh <= 0.3);
  now += 60 * DAY;
  assert.ok(usage.boost("q", "a.md") < fresh);
  usage.recordOpen("q", "a.md");
  assert.ok(usage.boost("q", "a.md") >= 0.5);
  assert.ok(usage.boost("other", "a.md") < 0.5);
});

test("everything comes back after a restart", async () => {
  const backend = fakeBackend();
  const first = new UsageStore(backend, () => 100 * DAY);
  first.recordVisit("a.md");
  first.recordOpen("q", "a.md");
  first.recordOpen("q", "a.md");
  const second = new UsageStore(backend, () => 100 * DAY);
  await second.load();
  assert.deepEqual(second.learned("q"), ["a.md"]);
  assert.ok(second.boost("x", "a.md") > 0);
});

test("a path holding unusual characters survives the stored key", async () => {
  const backend = fakeBackend();
  const first = new UsageStore(backend);
  first.recordOpen("a b", "目录 x/笔记|1.md");
  first.recordOpen("a b", "目录 x/笔记|1.md");
  const second = new UsageStore(backend);
  await second.load();
  assert.deepEqual(second.learned("a b"), ["目录 x/笔记|1.md"]);
});

test("a rename carries the history to the new path, in memory and on disk", async () => {
  const backend = fakeBackend();
  const usage = new UsageStore(backend);
  usage.recordVisit("old.md");
  usage.recordOpen("q", "old.md");
  usage.recordOpen("q", "old.md");
  usage.rename("old.md", "new.md");
  assert.deepEqual(usage.learned("q"), ["new.md"]);
  assert.equal(usage.boost("x", "old.md"), 0);
  const again = new UsageStore(backend);
  await again.load();
  assert.deepEqual(again.learned("q"), ["new.md"]);
  assert.ok(again.boost("x", "new.md") > 0);
});

test("a deleted note and a clear leave nothing behind", async () => {
  const backend = fakeBackend();
  const usage = new UsageStore(backend);
  usage.recordVisit("a.md");
  usage.recordOpen("q", "a.md");
  usage.recordOpen("q", "b.md");
  usage.remove("a.md");
  assert.equal(backend.tables.visits.size, 0);
  assert.equal(backend.tables.queries.size, 1);
  await usage.clear();
  assert.equal(backend.tables.queries.size, 0);
  assert.equal(usage.boost("q", "b.md"), 0);
});

test("a failed write keeps the session working", async () => {
  const backend = fakeBackend();
  backend.put = () => Promise.reject(new Error("quota"));
  const warn = console.warn;
  console.warn = () => {};
  try {
    const usage = new UsageStore(backend);
    usage.recordOpen("q", "a.md");
    usage.recordOpen("q", "a.md");
    assert.deepEqual(usage.learned("q"), ["a.md"]);
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    console.warn = warn;
  }
});
