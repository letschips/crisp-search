// Results from other plugins (0.8.0): Crisp Tempo lists tasks, Crisp Pulse lists memos. Failure modes:
// - a provider with a missing id, label or callbacks is accepted and breaks the panel later;
// - registering the same id twice shows two tabs, or an old registration's cleanup removes the new one;
// - one provider throwing, hanging or returning junk empties or freezes every other result;
// - duplicate or malformed entries reach the list; a huge list is taken whole;
// - text only in the body of an entry (a memo's second line) cannot be found;
// - finished tasks rank above open ones (seen live: three done "测试" tasks hid the open "去测试下");
// - pinyin and initials, which work for notes and commands, do not work here;
// - finished items fill the "全部" tab when fewer than three open ones match (live ANKS: 72 of 89 tasks are done).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(path.join(tmpdir(), "crisp-search-providers-"));
await esbuild.build({
  entryPoints: [path.join(root, "src/providers.ts")],
  bundle: true, format: "esm", platform: "node", outfile: path.join(outDir, "providers.mjs"), logLevel: "error",
});
const { ProviderRegistry, ProviderIndex, cleanEntries, loadEntries, mixedMatches, providerScope, scopeProvider, SEARCH_PROVIDER_API_VERSION, MAX_PROVIDER_ENTRIES } =
  await import(pathToFileURL(path.join(outDir, "providers.mjs")).href);

const provider = (extra = {}) => ({ id: "crisp-tempo", label: "任务", list: () => [], open() {}, ...extra });

test("a provider needs an id, a label and both callbacks", () => {
  const registry = new ProviderRegistry();
  for (const bad of [null, {}, provider({ id: "" }), provider({ id: "has space" }), provider({ label: " " }), provider({ list: null }), provider({ open: "x" })]) {
    assert.throws(() => registry.register(bad), /provider/i);
  }
  assert.equal(registry.list().length, 0);
  assert.equal(SEARCH_PROVIDER_API_VERSION, 1);
});

test("registering an id again replaces it, and the old cleanup leaves the new one alone", () => {
  const registry = new ProviderRegistry();
  let changes = 0;
  registry.onChange(() => changes++);
  const offOld = registry.register(provider({ label: "旧" }));
  const offNew = registry.register(provider({ label: "任务" }));
  registry.register(provider({ id: "crisp-pulse", label: "速记", mixed: false }));
  assert.deepEqual(registry.list().map((p) => [p.id, p.label]), [["crisp-tempo", "任务"], ["crisp-pulse", "速记"]]);
  offOld();
  assert.equal(registry.list().length, 2, "a stale cleanup removes nothing");
  offNew();
  assert.deepEqual(registry.list().map((p) => p.id), ["crisp-pulse"]);
  assert.equal(changes, 4);
  assert.equal(scopeProvider(providerScope("crisp-pulse")), "crisp-pulse");
  assert.equal(scopeProvider("notes"), null);
});

test("entries are cleaned: junk and duplicates dropped, long text clipped, the list capped", () => {
  const cleaned = cleanEntries([
    { id: "a", title: "  写周报  ", subtitle: "ANKS", accessory: "还剩 2 天", icon: "list-checks", done: false, extra: 1 },
    { id: "a", title: "重复的 id" },
    { id: "", title: "没有 id" }, { id: "b" }, { id: "c", title: "   " }, null, "x", { id: 5, title: "数字 id" },
    { id: "d", title: "长".repeat(900), text: "体".repeat(9000) },
  ]);
  assert.deepEqual(cleaned.map((e) => e.id), ["a", "d"]);
  assert.deepEqual(cleaned[0], { id: "a", title: "写周报", subtitle: "ANKS", accessory: "还剩 2 天", icon: "list-checks", done: false });
  assert.ok(cleaned[1].title.length <= 300 && cleaned[1].text.length <= 4000);
  assert.deepEqual(cleanEntries("nope"), []);
  const many = Array.from({ length: MAX_PROVIDER_ENTRIES + 50 }, (_, i) => ({ id: `t${i}`, title: `任务 ${i}` }));
  assert.equal(cleanEntries(many).length, MAX_PROVIDER_ENTRIES);
});

test("a provider that throws, hangs or returns junk gives no entries and does not reject", async () => {
  const logged = [];
  const log = (...args) => logged.push(args);
  assert.deepEqual(await loadEntries(provider({ list: () => { throw new Error("boom"); } }), 50, log), []);
  assert.deepEqual(await loadEntries(provider({ list: async () => { throw new Error("async boom"); } }), 50, log), []);
  assert.deepEqual(await loadEntries(provider({ list: () => new Promise(() => {}) }), 30, log), []);
  assert.deepEqual(await loadEntries(provider({ list: async () => ({ not: "a list" }) }), 50, log), []);
  assert.equal(logged.length, 3, "failures are logged, junk is just empty");
  assert.deepEqual((await loadEntries(provider({ list: async () => [{ id: "a", title: "好的" }] }), 50, log)).map((e) => e.id), ["a"]);
});

test("search matches titles like commands do, finds body text, and keeps open work above finished", () => {
  const index = new ProviderIndex(cleanEntries([
    { id: "done", title: "写周报", done: true },
    { id: "open", title: "写周报", accessory: "还剩 2 天" },
    { id: "long", title: "准备写周报的材料" },
    { id: "memo", title: "搜索插件大改", text: "搜索插件大改\n把任务和速记也接进来" },
    { id: "en", title: "Review quarterly plan" },
  ]));
  assert.deepEqual(index.search("写周报").map((m) => m.entry.id), ["open", "long", "done"], "a weaker open match still beats an exact finished one");
  assert.deepEqual(index.search("写周报")[0].ranges, [[0, 3]]);
  const byPinyin = index.search("xzb").map((m) => m.entry.id);
  assert.ok(byPinyin.includes("open") && byPinyin.indexOf("open") < byPinyin.indexOf("done"), "pinyin initials, open work first");
  assert.deepEqual(index.search("rqp").map((m) => m.entry.id), ["en"], "English initials");
  const body = index.search("速记 接进来");
  assert.deepEqual(body.map((m) => m.entry.id), ["memo"]);
  assert.deepEqual(body[0].ranges, [], "a body match highlights nothing in the title");
  assert.deepEqual(index.search("不存在的词"), []);
  assert.deepEqual(index.search("").map((m) => m.entry.id), ["done", "open", "long", "memo", "en"], "an empty query lists in the provider's order");
});

test("the 全部 tab takes only open entries, at most the limit; their own tab still lists finished ones", () => {
  const index = new ProviderIndex(cleanEntries([
    { id: "open", title: "写周报" },
    { id: "done1", title: "写周报", done: true },
    { id: "done2", title: "写周报初稿", done: true },
    { id: "long", title: "准备写周报的材料" },
  ]));
  const matches = index.search("写周报");
  assert.deepEqual(mixedMatches(matches, 3).map((m) => m.entry.id), ["open", "long"], "two open matches do not get topped up with finished ones");
  assert.deepEqual(mixedMatches(matches, 1).map((m) => m.entry.id), ["open"]);
  assert.deepEqual(mixedMatches(new ProviderIndex(cleanEntries([{ id: "d", title: "写周报", done: true }])).search("写周报"), 3), []);
  assert.deepEqual(matches.map((m) => m.entry.id), ["open", "long", "done1", "done2"], "the provider's own tab is unchanged");
});
