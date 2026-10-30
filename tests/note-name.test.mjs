// The query offered as a new note: cleaned into a file name, and not offered when a note already has it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(path.join(tmpdir(), "crisp-search-note-name-"));
await esbuild.build({
  entryPoints: [path.join(root, "src/note-name.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: path.join(outDir, "note-name.mjs"),
  logLevel: "error",
});
const { noteName, newNoteName } = await import(pathToFileURL(path.join(outDir, "note-name.mjs")).href);

const files = (...paths) =>
  paths.map((p) => ({ basename: p.split("/").pop().replace(/\.[^.]+$/, ""), extension: p.split(".").pop() }));

test("unsafe characters become spaces and leading dots go", () => {
  assert.equal(noteName("zqx 新建测试/冒号:20261030"), "zqx 新建测试 冒号 20261030");
  assert.equal(noteName("..hidden"), "hidden");
  assert.equal(noteName("[[]]"), "");
});

test("B2: an attachment of the same name does not block a new note", () => {
  assert.equal(newNoteName("photo", files("assets/photo.png")), "photo");
  assert.equal(newNoteName("Crisp-Focus", files("images/Crisp-Focus.jpg", "a/other.md")), "Crisp-Focus");
});

test("B1: a note of that name anywhere in the vault suppresses the offer, in any case", () => {
  assert.equal(newNoteName("Needle", files("deep/folder/needle.md")), "");
  assert.equal(newNoteName("needle", files("needle.canvas")), "needle");
});

test("typing an existing file's full name opens that file rather than offering a note of that name", () => {
  assert.equal(newNoteName("Crisp-Focus.jpg", files("images/Crisp-Focus.jpg")), "");
  assert.equal(newNoteName("needle.md", files("needle.md")), "");
  assert.equal(newNoteName("photo.jpg", files("images/photo.png")), "photo.jpg");
});
