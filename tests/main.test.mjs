// Index lifecycle against a stubbed vault: read failures and excluded files (audit 2026-10-29 B1, B2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";
import { TFile } from "./fakes/obsidian.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stub = path.join(root, "tests/fakes/obsidian.mjs");
const outDir = mkdtempSync(path.join(tmpdir(), "crisp-search-main-"));
await esbuild.build({
  entryPoints: [path.join(root, "src/main.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: path.join(outDir, "main.mjs"),
  logLevel: "error",
  plugins: [{ name: "obsidian-stub", setup: (b) => b.onResolve({ filter: /^obsidian$/ }, () => ({ path: pathToFileURL(stub).href, external: true })) }],
});
// onload schedules the licence expiry check on window.
globalThis.window ??= { setInterval: () => 0, clearInterval() {}, setTimeout };
const { default: CrispSearchPlugin } = await import(pathToFileURL(path.join(outDir, "main.mjs")).href);

async function setup(options = {}) {
  const { fail = () => false, ignored = () => false } = options;
  // Passed explicitly as undefined to mean "data.json exists but could not be read".
  const data = "data" in options ? options.data : null;
  const files = (options.paths ?? ["a.md", "bad.md", "z.md"]).map((p) => new TFile(p));
  const events = {};
  const app = {
    workspace: { layoutReady: true, onLayoutReady: (fn) => fn() },
    vault: {
      on: (name, fn) => (events[`vault:${name}`] = fn),
      getFiles: () => files,
      cachedRead: async (file) => {
        if (options.read) return options.read(file);
        if (fail(file.path)) throw new Error("EIO");
        return `正文 ${file.basename}`;
      },
      getAbstractFileByPath: (p) => files.find((f) => f.path === p) ?? null,
    },
    metadataCache: { on: (name, fn) => (events[`cache:${name}`] = fn), isUserIgnored: ignored, getFileCache: () => null },
  };
  const plugin = new CrispSearchPlugin(app);
  plugin.saved = [];
  plugin.loadData = async () => data;
  plugin.saveData = async (value) => plugin.saved.push(value);
  await plugin.onload();
  return { plugin, files, events };
}

test("a file that cannot be read is counted as failed and indexing still finishes", async () => {
  const { plugin } = await setup({ fail: (p) => p === "bad.md" });
  await plugin.rebuildIndex();
  assert.equal(plugin.ready, true);
  assert.equal(plugin.engine.has("z.md"), true);
  assert.deepEqual(plugin.failed, ["bad.md"]);
});

test("rebuilding retries files that failed before", async () => {
  let broken = true;
  const { plugin } = await setup({ fail: (p) => broken && p === "bad.md" });
  await plugin.rebuildIndex();
  broken = false;
  await plugin.rebuildIndex();
  assert.equal(plugin.engine.has("bad.md"), true);
  assert.deepEqual(plugin.failed, []);
});

test("an excluded file stays out of the index when its metadata changes", async () => {
  const { plugin, files, events } = await setup({ ignored: (p) => p === "bad.md" });
  await plugin.rebuildIndex();
  events["cache:changed"](files[1], "secretmarker", null);
  assert.equal(plugin.engine.has("bad.md"), false);
  assert.deepEqual(plugin.engine.search("secretmarker"), []);
});

test("recent commands load from data.json and are saved most recent first", async () => {
  const { plugin } = await setup({ data: { recentCommands: ["a:one", 3, "b:two"] } });
  assert.deepEqual(plugin.recentCommands, ["a:one", "b:two"]);
  plugin.recordCommand("b:two");
  plugin.recordCommand("c:three");
  await plugin.saving;
  // Saves run one after another, so the last write is the latest list.
  assert.deepEqual(plugin.saved.at(-1), {
    licenseCode: "",
    recentCommands: ["c:three", "b:two", "a:one"],
    sortOrder: "recent",
    newNoteFolder: "",
    excludedFolders: [],
    recentQueries: [],
  });
});

test("an unreadable data.json is never overwritten", async () => {
  const { plugin } = await setup({ data: undefined });
  plugin.recordCommand("a:one");
  assert.deepEqual(plugin.recentCommands, ["a:one"]);
  assert.deepEqual(plugin.saved, []);
});

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

// R2-2: an older read that resolves late must not overwrite what a newer pass or event indexed.
test("a slow read from a superseded rebuild cannot overwrite the newer index", async () => {
  const reads = [];
  const { plugin } = await setup({ read: () => { const d = deferred(); reads.push(d); return d.promise; } });
  plugin.rebuildIndex();
  // The first rebuild's read of a.md is pending.
  await new Promise((r) => setImmediate(r));
  const first = reads.length;
  const newer = plugin.rebuildIndex();
  await new Promise((r) => setImmediate(r));
  for (const d of reads.slice(first)) d.resolve("newmarker");
  // Later reads of the newer pass resolve with the new content too.
  const settle = async () => {
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setImmediate(r));
      for (const d of reads.slice(first)) d.resolve("newmarker");
    }
  };
  await settle();
  await newer;
  for (const d of reads.slice(0, first)) d.resolve("oldmarker");
  await settle();
  assert.equal(plugin.engine.search("newmarker").length, 3);
  assert.deepEqual(plugin.engine.search("oldmarker"), []);
  assert.equal(plugin.indexed, plugin.total);
});

test("a metadata change beats a read that was already in flight", async () => {
  const reads = [];
  const { plugin, files, events } = await setup({ read: () => { const d = deferred(); reads.push(d); return d.promise; } });
  plugin.rebuildIndex();
  await new Promise((r) => setImmediate(r));
  events["cache:changed"](files[0], "freshmarker", null);
  reads[0].resolve("stalemarker");
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setImmediate(r));
    for (const d of reads) d.resolve("stalemarker");
  }
  assert.deepEqual(plugin.engine.search("freshmarker").map((r) => r.path), ["a.md"]);
  assert.deepEqual(plugin.engine.search("stalemarker").map((r) => r.path).sort(), ["bad.md", "z.md"]);
});

// Audit round 3, R3-1: a read that started before a rename must not land under the new path.
test("a read started before a rename cannot overwrite what was read after it", async () => {
  const reads = [];
  const { plugin, files, events } = await setup({
    read: (file) => {
      const d = deferred();
      reads.push({ path: file.path, d });
      return d.promise;
    },
  });
  plugin.rebuildIndex();
  await new Promise((r) => setImmediate(r));
  const pending = reads.find((r) => r.path === "a.md");
  const file = files[0];
  file.path = "new.md";
  file.basename = "new";
  events["vault:rename"](file, "a.md");
  await new Promise((r) => setImmediate(r));
  reads.find((r) => r.path === "new.md").d.resolve("newmarker");
  await new Promise((r) => setImmediate(r));
  pending.d.resolve("stalemarker");
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setImmediate(r));
    for (const r of reads) r.d.resolve("other");
  }
  assert.deepEqual(plugin.engine.search("newmarker").map((r) => r.path), ["new.md"]);
  assert.deepEqual(plugin.engine.search("stalemarker"), []);
});

// R3-4: the failure list must describe the current state, not only the last rebuild.
test("a failed file that later indexes is no longer reported as failed", async () => {
  const { plugin, files, events } = await setup({ fail: (p) => p === "bad.md" });
  await plugin.rebuildIndex();
  assert.deepEqual(plugin.failed, ["bad.md"]);
  let notified = 0;
  plugin.onProgress(() => notified++);
  events["cache:changed"](files[1], "recoveredmarker", null);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(plugin.failed, []);
  assert.ok(notified > 0);
  assert.deepEqual(plugin.engine.search("recoveredmarker").map((r) => r.path), ["bad.md"]);
});

test("a deleted failed file leaves the failure list", async () => {
  const { plugin, files, events } = await setup({ fail: (p) => p === "bad.md" });
  await plugin.rebuildIndex();
  events["vault:delete"](files[1]);
  assert.deepEqual(plugin.failed, []);
});

test("an edit while the panel is open notifies listeners once per burst", async () => {
  const { plugin, files, events } = await setup();
  await plugin.rebuildIndex();
  let notified = 0;
  plugin.onProgress(() => notified++);
  events["cache:changed"](files[0], "one", null);
  events["cache:changed"](files[2], "two", null);
  await new Promise((r) => setImmediate(r));
  assert.equal(notified, 1);
});

test("without a licence the vault is not indexed", async () => {
  const { plugin } = await setup();
  await new Promise((r) => setImmediate(r));
  assert.equal(plugin.licensed, false);
  assert.equal(plugin.engine.size, 0);
  assert.equal(plugin.ready, false);
});

// Licence gate: nothing is indexed before activation, and losing the licence drops the index.
function setLicensed(plugin, value) {
  // The settings tab redraws on licence changes; the fake host has no settings DOM.
  plugin.settingTab = null;
  Object.defineProperty(plugin, "licensed", { get: () => value, configurable: true });
  plugin.onLicenseChange();
}

test("edits made before activation are not indexed", async () => {
  const { plugin, files, events } = await setup();
  events["cache:changed"](files[0], "earlymarker", null);
  events["vault:create"](files[2]);
  await new Promise((r) => setImmediate(r));
  assert.equal(plugin.engine.size, 0);
});

test("activation starts indexing, and losing the licence clears the index", async () => {
  const { plugin } = await setup();
  setLicensed(plugin, true);
  for (let i = 0; i < 20 && !plugin.ready; i++) await new Promise((r) => setImmediate(r));
  assert.equal(plugin.engine.size, 3);
  setLicensed(plugin, false);
  assert.equal(plugin.engine.size, 0);
  assert.equal(plugin.ready, false);
  setLicensed(plugin, true);
  for (let i = 0; i < 20 && !plugin.ready; i++) await new Promise((r) => setImmediate(r));
  assert.equal(plugin.engine.size, 3);
});

// 0.1.4: a read that is still in flight when the index stops, the plugin unloads or the file becomes
// excluded must not write the file back into the index.
for (const scenario of ["stop", "unload", "exclude"]) {
  test(`a pending read after ${scenario} leaves the index empty`, async () => {
    const reads = [];
    let excluded = false;
    const { plugin, files, events } = await setup({
      ignored: (p) => excluded && p === "a.md",
      read: () => {
        const d = deferred();
        reads.push(d);
        return d.promise;
      },
    });
    plugin.settingTab = null;
    plugin.indexStarted = true;
    events["vault:create"](files[0]);
    if (scenario === "stop") plugin.stopIndex();
    if (scenario === "unload") plugin.onunload();
    if (scenario === "exclude") excluded = true;
    for (const d of reads) d.resolve("latemarker");
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    assert.equal(plugin.engine.size, 0);
  });
}

test("folders excluded in the plugin stay out of the index, and changing the list re-indexes", async () => {
  const { plugin } = await setup({
    paths: ["notes/a.md", "private/b.md", "private/deep/c.md", "privateer/d.md"],
    data: { excludedFolders: ["private/", 3, " ", "notes/../x"] },
  });
  assert.deepEqual(plugin.settings.excludedFolders, ["private", "notes/../x"]);
  await plugin.rebuildIndex();
  assert.deepEqual(plugin.engine.paths().sort(), ["notes/a.md", "privateer/d.md"]);
  await plugin.setExcludedFolders(["/notes/", "notes", ""]);
  assert.deepEqual(plugin.settings.excludedFolders, ["notes"]);
  assert.deepEqual(plugin.engine.paths().sort(), ["private/b.md", "private/deep/c.md", "privateer/d.md"]);
});

test("recent searches are kept most recent first, once each, and capped", async () => {
  const { plugin } = await setup({ data: { recentQueries: ["旧", 1, ""] } });
  assert.deepEqual(plugin.recentQueries, ["旧"]);
  for (const q of ["a", " b ", "a", ""]) plugin.recordQuery(q);
  assert.deepEqual(plugin.recentQueries, ["a", "b", "旧"]);
  plugin.forgetQuery("b");
  assert.deepEqual(plugin.recentQueries, ["a", "旧"]);
  for (let i = 0; i < 30; i++) plugin.recordQuery(`q${i}`);
  assert.equal(plugin.recentQueries.length, 10);
  assert.equal(plugin.recentQueries[0], "q29");
  plugin.clearQueries();
  await plugin.saving;
  assert.deepEqual(plugin.saved.at(-1).recentQueries, []);
});
