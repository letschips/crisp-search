import esbuild from "esbuild";
import builtins from "builtin-modules";
import process from "node:process";
import { readFileSync } from "node:fs";

// BRAT installs only main.js, manifest.json and styles.css, so the bundled packages' MIT notices
// travel inside main.js as well.
const notices = readFileSync("THIRD_PARTY_NOTICES.md", "utf8").replaceAll("*/", "* /");

const production = process.argv[2] === "production";
const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", ...builtins],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: production,
  banner: { js: `/*!\n${notices}*/` },
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
