// Plugins and settings pages read from Obsidian's private app objects: their shape, and quiet failure when
// a future Obsidian moves them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(path.join(tmpdir(), "crisp-search-host-"));
await esbuild.build({
  entryPoints: [path.join(root, "src/host-entries.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: path.join(outDir, "host-entries.mjs"),
  logLevel: "error",
});
const { listPlugins, listSettingPages, openSettingPage, setPluginEnabled } = await import(
  pathToFileURL(path.join(outDir, "host-entries.mjs")).href
);

function fakeApp() {
  const calls = [];
  const core = (name, enabled) => ({
    enabled,
    instance: { name, description: `${name}说明` },
    enable(user) { calls.push(["core-enable", name, user]); this.enabled = true; },
    disable(user) { calls.push(["core-disable", name, user]); this.enabled = false; },
  });
  const app = {
    setting: {
      settingTabs: [{ id: "editor", name: "编辑器" }, { id: "hotkeys", name: "快捷键" }],
      pluginTabs: [{ id: "templates", name: "模板" }, { id: "crisp-tempo", name: "Crisp Tempo" }],
      open() { calls.push(["open"]); },
      openTabById(id) { calls.push(["tab", id]); },
    },
    plugins: {
      manifests: { "crisp-tempo": { id: "crisp-tempo", name: "Crisp Tempo", description: "日计划" }, dataview: { id: "dataview", name: "Dataview" } },
      enabledPlugins: new Set(["crisp-tempo"]),
      async enablePluginAndSave(id) { calls.push(["enable", id]); this.enabledPlugins.add(id); return true; },
      async disablePluginAndSave(id) { calls.push(["disable", id]); this.enabledPlugins.delete(id); return true; },
    },
    internalPlugins: { plugins: { templates: core("模板", true), "daily-notes": core("日记", false) } },
  };
  return { app, calls };
}

test("plugins list community and core plugins with their state and whether they have a settings page", () => {
  const { app } = fakeApp();
  const byId = Object.fromEntries(listPlugins(app).map((p) => [p.id, p]));
  assert.deepEqual(byId["crisp-tempo"], { id: "crisp-tempo", name: "Crisp Tempo", description: "日计划", core: false, enabled: true, hasSettings: true });
  assert.deepEqual(byId.dataview, { id: "dataview", name: "Dataview", description: "", core: false, enabled: false, hasSettings: false });
  assert.equal(byId.templates.core, true);
  assert.equal(byId.templates.hasSettings, true);
  assert.deepEqual([byId["daily-notes"].name, byId["daily-notes"].enabled], ["日记", false]);
});

test("settings pages are Obsidian's own pages", () => {
  const { app } = fakeApp();
  assert.deepEqual(listSettingPages(app), [{ id: "editor", name: "编辑器" }, { id: "hotkeys", name: "快捷键" }]);
});

test("opening a page and switching plugins go through Obsidian's own calls", async () => {
  const { app, calls } = fakeApp();
  assert.equal(openSettingPage(app, "hotkeys"), true);
  const byId = Object.fromEntries(listPlugins(app).map((p) => [p.id, p]));
  const [tempo, dataview, daily] = [byId["crisp-tempo"], byId.dataview, byId["daily-notes"]];
  assert.equal(await setPluginEnabled(app, tempo, false), true);
  assert.equal(await setPluginEnabled(app, dataview, true), true);
  assert.equal(await setPluginEnabled(app, daily, true), true);
  assert.deepEqual(calls, [["open"], ["tab", "hotkeys"], ["disable", "crisp-tempo"], ["enable", "dataview"], ["core-enable", "日记", true]]);
});

test("a host without these objects yields nothing and reports failure instead of throwing", async () => {
  for (const app of [{}, { setting: null, plugins: { manifests: null }, internalPlugins: { plugins: 3 } }]) {
    assert.deepEqual(listPlugins(app), []);
    assert.deepEqual(listSettingPages(app), []);
    assert.equal(openSettingPage(app, "editor"), false);
    assert.equal(await setPluginEnabled(app, { id: "x", core: false, enabled: false }, true), false);
  }
});
