// Translucent windows keep stale frames behind compositing layers: backdrop-filter in a modal blacked out
// the window (WeChat Publisher 0.2.3), 3D transforms and will-change left ghosts (Reading Rail, File Explorer).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

test("styles create no extra compositing layers", () => {
  for (const banned of [/backdrop-filter/, /will-change/, /translate3d|translateZ|perspective/, /mask-image/, /filter\s*:/]) {
    assert.doesNotMatch(css, banned);
  }
});
