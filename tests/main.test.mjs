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
const { default: CrispSearchPlugin } = await import(pathToFileURL(path.join(outDir, "main.mjs")).href);
globalThis.window = { setTimeout };

function setup({ fail = () => false, ignored = () => false } = {}) {
  const files = ["a.md", "bad.md", "z.md"].map((p) => new TFile(p));
  const events = {};
  const app = {
    workspace: { onLayoutReady: (fn) => fn() },
    vault: {
      on: (name, fn) => (events[`vault:${name}`] = fn),
      getFiles: () => files,
      cachedRead: async (file) => {
        if (fail(file.path)) throw new Error("EIO");
        return `正文 ${file.basename}`;
      },
      getAbstractFileByPath: (p) => files.find((f) => f.path === p) ?? null,
    },
    metadataCache: { on: (name, fn) => (events[`cache:${name}`] = fn), isUserIgnored: ignored, getFileCache: () => null },
  };
  const plugin = new CrispSearchPlugin(app);
  plugin.onload();
  return { plugin, files, events };
}

test("a file that cannot be read is counted as failed and indexing still finishes", async () => {
  const { plugin } = setup({ fail: (p) => p === "bad.md" });
  await plugin.rebuildIndex();
  assert.equal(plugin.ready, true);
  assert.equal(plugin.engine.has("z.md"), true);
  assert.deepEqual(plugin.failed, ["bad.md"]);
});

test("rebuilding retries files that failed before", async () => {
  let broken = true;
  const { plugin } = setup({ fail: (p) => broken && p === "bad.md" });
  await plugin.rebuildIndex();
  broken = false;
  await plugin.rebuildIndex();
  assert.equal(plugin.engine.has("bad.md"), true);
  assert.deepEqual(plugin.failed, []);
});

test("an excluded file stays out of the index when its metadata changes", async () => {
  const { plugin, files, events } = setup({ ignored: (p) => p === "bad.md" });
  await plugin.rebuildIndex();
  events["cache:changed"](files[1], "secretmarker", null);
  assert.equal(plugin.engine.has("bad.md"), false);
  assert.deepEqual(plugin.engine.search("secretmarker"), []);
});
