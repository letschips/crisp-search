// The slice of the Obsidian API that src/main.ts touches during indexing.
export class Plugin {
  constructor(app) {
    this.app = app;
    this.commands = [];
  }
  registerEvent() {}
  addCommand(command) {
    this.commands.push(command);
  }
  addRibbonIcon() {}
  async loadData() {
    return null;
  }
  async saveData() {}
}
export class TAbstractFile {}
export class TFile extends TAbstractFile {
  constructor(path) {
    super();
    this.path = path;
    this.extension = path.split(".").pop();
    this.basename = path.split("/").pop().replace(/\.[^.]+$/, "");
  }
}
export class Modal {}
export class Scope {}
export class Notice {}
export const Platform = { isMacOS: true };
export const Keymap = {};
export function setIcon() {}
export function getAllTags() {
  return [];
}
export function parseFrontMatterAliases() {
  return [];
}
