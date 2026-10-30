import { AbstractInputSuggest, App, Notice, PluginSettingTab, Setting, TFolder, normalizePath } from "obsidian";
import type CrispSearchPlugin from "./main";
import { SORT_ORDERS, isSortOrder } from "./sort";

const AUTHOR_URL = "https://xhslink.cn/m/3MwtKu4822b";

class FolderSuggest extends AbstractInputSuggest<TFolder> {
  constructor(
    app: App,
    private readonly input: HTMLInputElement,
  ) {
    super(app, input);
  }

  getSuggestions(query: string): TFolder[] {
    const lower = query.toLowerCase();
    return this.app.vault
      .getAllLoadedFiles()
      .filter((file): file is TFolder => file instanceof TFolder && !file.isRoot() && file.path.toLowerCase().includes(lower))
      .slice(0, 50);
  }

  renderSuggestion(folder: TFolder, el: HTMLElement): void {
    el.setText(folder.path);
  }

  selectSuggestion(folder: TFolder): void {
    this.setValue(folder.path);
    this.input.dispatchEvent(new Event("input"));
    this.close();
  }
}

export class CrispSearchSettingTab extends PluginSettingTab {
  private licenseDraft = "";
  private checking = false;

  constructor(
    app: App,
    private readonly plugin: CrispSearchPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    this.renderLicense(containerEl);
    this.renderSearch(containerEl);
    this.renderAbout(containerEl);
  }

  private renderLicense(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("软件授权与激活").setHeading();
    const plugin = this.plugin;
    const license = plugin.license;
    const status = new Setting(containerEl).setName("激活状态");
    if (plugin.licensed) {
      const payload = license.payload;
      const user = payload?.userName || "Crisp 用户";
      const expiry = payload?.expiresAt ? `到期时间：${String(payload.expiresAt).split("T")[0]}` : "永久授权";
      status.setDesc(`已激活（授权用户：${user} · ${expiry}）`);
      if (plugin.licenseUnsaved) {
        new Setting(containerEl)
          .setName("授权码未保存")
          .setDesc("授权码没能写入设置文件：本次可以使用，重启后需要重新激活。")
          .addButton((button) =>
            button.setButtonText("重试保存").onClick(async () => {
              const saved = await plugin.retrySaveLicense();
              new Notice(saved ? "授权码已保存" : "仍然没能写入设置文件", saved ? undefined : 0);
              this.display();
            }),
          );
      }
      status.addButton((button) =>
        button
          .setButtonText("清除授权")
          .setWarning()
          .onClick(async () => {
            const saved = await plugin.clearLicense();
            this.licenseDraft = "";
            new Notice(
              saved ? "已清除授权信息" : "本次运行已清除授权，但没能写入设置文件：重启后授权会恢复。",
              saved ? undefined : 0,
            );
            this.display();
          }),
      );
      return;
    }
    status.setDesc(license.reason ? `未激活：${license.reason}` : "未激活。激活后才能搜索笔记、内容和命令。");
    new Setting(containerEl)
      .setName("授权码")
      .setDesc("支持 Crisp Suite 全家桶授权码。启动时会自动继承库内其他 Crisp 插件的授权。")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("粘贴 Crisp 授权码…")
          .setValue(this.licenseDraft)
          .onChange((value) => {
            this.licenseDraft = value.trim();
          });
      })
      .addButton((button) =>
        button
          .setButtonText(this.checking ? "验证中…" : "激活")
          .setCta()
          .setDisabled(this.checking)
          .onClick(async () => {
            const code = this.licenseDraft || plugin.settings.licenseCode;
            if (!code) {
              new Notice("请先输入授权码");
              return;
            }
            this.checking = true;
            this.display();
            try {
              const { result, applied, saved } = await plugin.activate(code);
              if (!applied) return;
              if (!result.valid) {
                new Notice(`激活未通过：${result.reason || "未知原因"}`);
                return;
              }
              this.licenseDraft = "";
              new Notice(
                saved
                  ? `Crisp Search 激活成功，欢迎使用，${result.payload?.userName || "Crisp 用户"}`
                  : "授权验证通过，但没能写入设置文件：本次可以使用，重启后需要重新激活。",
                saved ? 4000 : 0,
              );
            } finally {
              this.checking = false;
              this.display();
            }
          }),
      );
  }

  private renderSearch(containerEl: HTMLElement): void {
    const plugin = this.plugin;
    new Setting(containerEl).setName("搜索").setHeading();
    new Setting(containerEl)
      .setName("结果排序")
      .setDesc("笔记名命中的结果始终排在正文命中之前，排序只调整各组内部的先后。面板左下角的齿轮菜单里可以临时切换。")
      .addDropdown((dropdown) =>
        dropdown
          .addOptions(SORT_ORDERS)
          .setValue(plugin.settings.sortOrder)
          .onChange((value) => {
            if (!isSortOrder(value)) return;
            plugin.settings.sortOrder = value;
            void plugin.saveSettings();
          }),
      );
    new Setting(containerEl)
      .setName("新建笔记位置")
      .setDesc("搜索词作为笔记名新建时放在哪个文件夹。留空则跟随 Obsidian「文件与链接」里的新建笔记位置。")
      .addText((text) => {
        new FolderSuggest(this.app, text.inputEl);
        text
          .setPlaceholder("跟随 Obsidian 设置")
          .setValue(plugin.settings.newNoteFolder)
          .onChange((value) => {
            const trimmed = value.trim();
            plugin.settings.newNoteFolder = trimmed ? normalizePath(trimmed) : "";
            void plugin.saveSettings();
          });
      });
    new Setting(containerEl)
      .setName("排除的文件夹")
      .setDesc("每行一个文件夹，其中的文件不进入搜索。Obsidian「文件与链接」里排除的文件本来就不会被搜到。离开输入框后重建索引。")
      .addTextArea((text) => {
        text.inputEl.rows = 4;
        text.setPlaceholder("Sidecar\nraw/inbox").setValue(plugin.settings.excludedFolders.join("\n"));
        text.inputEl.addEventListener("blur", () => {
          const folders = text.getValue().split("\n");
          const before = plugin.settings.excludedFolders.join("\n");
          void plugin.setExcludedFolders(folders).then(() => {
            if (plugin.settings.excludedFolders.join("\n") !== before) new Notice("排除列表已更新，索引已重建");
          });
          text.setValue(plugin.settings.excludedFolders.join("\n"));
        });
      });
    new Setting(containerEl)
      .setName("最近搜索")
      .setDesc("打开过结果的搜索词会出现在空白面板里，最多记 10 条。")
      .addButton((button) =>
        button.setButtonText("清除").onClick(() => {
          plugin.clearQueries();
          new Notice("已清除最近搜索");
        }),
      );
  }

  private renderAbout(containerEl: HTMLElement): void {
    const card = containerEl.createDiv({ cls: "crisp-search-about" });
    card.createDiv({ cls: "crisp-search-about__title", text: `关于 Crisp Search ${this.plugin.manifest.version}` });
    card.createDiv({
      cls: "crisp-search-about__description",
      text: "启动器式的搜索面板：搜笔记、正文和命令，中文与拼音优先。",
    });
    const byline = card.createEl("p", { cls: "crisp-search-about__author" });
    byline.createSpan({ text: "作者：" });
    const link = byline.createEl("a", { cls: "crisp-search-about__author-link", text: "小红书 letschips", href: AUTHOR_URL });
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  }
}
