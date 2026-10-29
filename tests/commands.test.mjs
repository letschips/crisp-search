// Command matching: Chinese names, pinyin, English words and initials, and recent use.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(path.join(tmpdir(), "crisp-search-commands-"));
await esbuild.build({
  entryPoints: [path.join(root, "src/commands.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: path.join(outDir, "commands.mjs"),
  logLevel: "error",
});
const { CommandIndex, isCommandAvailable } = await import(pathToFileURL(path.join(outDir, "commands.mjs")).href);

const index = new CommandIndex([
  { id: "editor:toggle-bold", name: "切换粗体" },
  { id: "editor:toggle-italics", name: "切换斜体" },
  { id: "app:toggle-left-sidebar", name: "Toggle left sidebar" },
  { id: "crisp-tempo:open", name: "Crisp Tempo: 打开日计划" },
  { id: "workspace:split-vertical", name: "左右分屏" },
]);
const ids = (matches) => matches.map((m) => m.id);

test("a Chinese fragment anywhere in the name matches and is marked", () => {
  const [hit, ...rest] = index.search("粗体");
  assert.equal(hit.id, "editor:toggle-bold");
  assert.deepEqual(rest, []);
  assert.deepEqual(hit.ranges.map(([s, e]) => hit.name.slice(s, e)), ["粗体"]);
});

test("pinyin and initials match, including from the middle of the name", () => {
  for (const q of ["qiehuancuti", "cuti", "ct", "fenping", "zyfp"]) {
    assert.ok(["editor:toggle-bold", "workspace:split-vertical"].includes(index.search(q)[0]?.id), q);
  }
});

test("English matches each word, by word prefix or by initials", () => {
  assert.deepEqual(ids(index.search("toggle side")), ["app:toggle-left-sidebar"]);
  assert.deepEqual(ids(index.search("tls")), ["app:toggle-left-sidebar"]);
  assert.deepEqual(ids(index.search("sidebar left")), ["app:toggle-left-sidebar"]);
});

test("the plugin prefix and the command name can be combined", () => {
  assert.deepEqual(ids(index.search("tempo 日计划")), ["crisp-tempo:open"]);
});

test("every query word must match", () => {
  assert.deepEqual(ids(index.search("粗体 tempo")), []);
});

test("recently run commands rank first among equal matches only", () => {
  assert.deepEqual(ids(index.search("切换")), ["editor:toggle-bold", "editor:toggle-italics"]);
  assert.deepEqual(ids(index.search("切换", ["editor:toggle-italics"])), ["editor:toggle-italics", "editor:toggle-bold"]);
});

test("an empty query lists recent commands first, then the rest by name", () => {
  const all = ids(index.search("", ["workspace:split-vertical"]));
  assert.equal(all[0], "workspace:split-vertical");
  assert.equal(all.length, 5);
});

// Audit round 2, R2-1: the SDK hides a command when checkCallback returns false or undefined, and the
// editor callbacks override checkCallback.
test("availability follows the SDK callback order and truthiness", () => {
  const editor = { editor: {} };
  assert.equal(isCommandAvailable({ checkCallback: () => undefined }, null), false);
  assert.equal(isCommandAvailable({ checkCallback: () => true }, null), true);
  assert.equal(isCommandAvailable({ checkCallback: () => false }, null), false);
  assert.equal(isCommandAvailable({ editorCallback: () => {}, checkCallback: () => true }, null), false);
  assert.equal(isCommandAvailable({ editorCallback: () => {}, checkCallback: () => false }, editor), true);
  assert.equal(isCommandAvailable({ editorCheckCallback: () => undefined }, editor), false);
  assert.equal(isCommandAvailable({ editorCheckCallback: () => true, editorCallback: () => {} }, null), false);
  assert.equal(isCommandAvailable({ callback: () => {} }, null), true);
  assert.equal(isCommandAvailable({ checkCallback: () => { throw new Error("x"); } }, null), false);
});

// R2-3: overlapping words produced overlapping ranges and the name was rendered twice.
test("repeated or nested query words give non-overlapping ranges", () => {
  const index = new CommandIndex([{ id: "a", name: "切换行号" }]);
  for (const q of ["切换 切换", "切换 换行", "切 切换"]) {
    const [hit] = index.search(q);
    for (let i = 1; i < hit.ranges.length; i++) assert.ok(hit.ranges[i][0] >= hit.ranges[i - 1][1], q);
  }
});

test("an exact name match stays above a recently run partial match", () => {
  const index = new CommandIndex([
    { id: "open", name: "打开" },
    { id: "reopen", name: "重新打开所有文件" },
  ]);
  assert.deepEqual(ids(index.search("打开", ["reopen"])), ["open", "reopen"]);
});
