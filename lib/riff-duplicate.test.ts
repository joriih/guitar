import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error Node's type-stripping test runner requires the .ts extension.
import { duplicateRiffTitle } from "./riff-duplicate.ts";

test("duplicateRiffTitle adds a clear Korean copy suffix", () => {
  assert.equal(duplicateRiffTitle("Midnight Drive"), "Midnight Drive 복사본");
});

test("duplicateRiffTitle preserves the suffix inside the database title limit", () => {
  const title = duplicateRiffTitle("리".repeat(120));
  assert.equal(title.length, 120);
  assert.ok(title.endsWith(" 복사본"));
});

test("duplicateRiffTitle never splits a Unicode character at the title boundary", () => {
  const title = duplicateRiffTitle(`${"리".repeat(115)}🎸끝`);
  assert.equal(Array.from(title).length, 120);
  assert.ok(title.includes("🎸"));
  assert.ok(title.endsWith(" 복사본"));
});

test("duplicateRiffTitle has a safe fallback for blank legacy titles", () => {
  assert.equal(duplicateRiffTitle("   "), "새 리프 복사본");
});
