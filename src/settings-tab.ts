import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type CrispSearchPlugin from "./main";

const AUTHOR_URL = "https://xhslink.cn/m/3MwtKu4822b";

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
