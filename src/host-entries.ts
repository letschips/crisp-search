// Obsidian has no public API to list plugins or settings pages, or to switch a plugin on and off; these read
// the same app objects Obsidian's own settings use. Every call fails quietly, so a future Obsidian that
// moves them only hides these results.

export interface PluginEntry {
  id: string;
  name: string;
  description: string;
  core: boolean;
  enabled: boolean;
  // Only enabled plugins have their settings page registered.
  hasSettings: boolean;
}

export interface SettingPage {
  id: string;
  name: string;
}

interface Tab {
  id: string;
  name: string;
}

interface CorePlugin {
  enabled: boolean;
  instance?: { name?: string; description?: string };
  enable(user: boolean): unknown;
  disable(user: boolean): unknown;
}

interface HotkeysTab {
  searchComponent?: { setValue(value: string): unknown; inputEl?: { dispatchEvent(event: Event): unknown } };
}

interface Host {
  setting?: {
    settingTabs?: Tab[];
    pluginTabs?: Tab[];
    activeTab?: HotkeysTab | null;
    open?(): void;
    openTabById?(id: string): void;
  } | null;
  plugins?: {
    manifests?: Record<string, { id: string; name: string; description?: string }> | null;
    enabledPlugins?: Set<string>;
    enablePluginAndSave?(id: string): Promise<boolean>;
    disablePluginAndSave?(id: string): Promise<boolean>;
  } | null;
  internalPlugins?: { plugins?: Record<string, CorePlugin & { instance?: { options?: { pinned?: unknown } } }> } | null;
}

function tabs(list: unknown): Tab[] {
  return Array.isArray(list) ? list.filter((tab): tab is Tab => typeof tab?.id === "string" && typeof tab?.name === "string") : [];
}

export function listSettingPages(app: unknown): SettingPage[] {
  try {
    return tabs((app as Host).setting?.settingTabs).map(({ id, name }) => ({ id, name }));
  } catch {
    return [];
  }
}

export function listPlugins(app: unknown): PluginEntry[] {
  try {
    const host = app as Host;
    const withSettings = new Set(tabs(host.setting?.pluginTabs).map((tab) => tab.id));
    const entries: PluginEntry[] = [];
    const manifests = host.plugins?.manifests;
    if (manifests && typeof manifests === "object") {
      const enabled = host.plugins?.enabledPlugins;
      for (const manifest of Object.values(manifests)) {
        if (typeof manifest?.id !== "string") continue;
        entries.push({
          id: manifest.id,
          name: manifest.name || manifest.id,
          description: manifest.description ?? "",
          core: false,
          enabled: enabled instanceof Set && enabled.has(manifest.id),
          hasSettings: withSettings.has(manifest.id),
        });
      }
    }
    const core = host.internalPlugins?.plugins;
    if (core && typeof core === "object") {
      for (const [id, plugin] of Object.entries(core)) {
        if (!plugin || typeof plugin !== "object") continue;
        entries.push({
          id,
          name: plugin.instance?.name || id,
          description: plugin.instance?.description ?? "",
          core: true,
          enabled: !!plugin.enabled,
          hasSettings: withSettings.has(id),
        });
      }
    }
    return entries;
  } catch {
    return [];
  }
}

export function openSettingPage(app: unknown, id: string): boolean {
  try {
    const setting = (app as Host).setting;
    if (typeof setting?.open !== "function" || typeof setting.openTabById !== "function") return false;
    setting.open();
    setting.openTabById(id);
    return true;
  } catch {
    return false;
  }
}

// Saves the change the way Obsidian's own plugin lists do. Resolves false when it could not be made.
export async function setPluginEnabled(app: unknown, plugin: Pick<PluginEntry, "id" | "core">, on: boolean): Promise<boolean> {
  try {
    const host = app as Host;
    if (plugin.core) {
      const core = host.internalPlugins?.plugins?.[plugin.id];
      if (!core || typeof core.enable !== "function") return false;
      await (on ? core.enable(true) : core.disable(true));
      return true;
    }
    const plugins = host.plugins;
    const change = on ? plugins?.enablePluginAndSave : plugins?.disablePluginAndSave;
    if (typeof change !== "function") return false;
    return (await change.call(plugins, plugin.id)) !== false;
  } catch {
    return false;
  }
}

// Commands pinned in Obsidian's command palette, in their pinned order.
export function pinnedCommandIds(app: unknown): string[] {
  try {
    const palette = (app as Host).internalPlugins?.plugins?.["command-palette"];
    const pinned = palette?.enabled ? palette.instance?.options?.pinned : undefined;
    return Array.isArray(pinned) ? pinned.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

// Opens Settings → Hotkeys with its search box set to the command, so the hotkey can be set right there.
export function openHotkeysFor(app: unknown, text: string): boolean {
  if (!openSettingPage(app, "hotkeys")) return false;
  try {
    const search = (app as Host).setting?.activeTab?.searchComponent;
    search?.setValue(text);
    // The page filters on the field's input event, not on setValue.
    search?.inputEl?.dispatchEvent(new Event("input"));
  } catch {
    // The page is open, unfiltered.
  }
  return true;
}
