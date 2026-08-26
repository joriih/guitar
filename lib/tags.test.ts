import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error Node's type-stripping test runner requires the .ts extension.
import { cleanTagName, normalizeTagName } from "./tags.ts";

test("cleanTagName accepts a leading hash and collapses whitespace", () => {
  assert.equal(cleanTagName("  ##Dream   Pop  "), "Dream Pop");
});

test("cleanTagName normalizes full-width text", () => {
  assert.equal(cleanTagName("ＪＡＺＺ"), "JAZZ");
});

test("normalizeTagName creates a stable case-insensitive key", () => {
  assert.equal(normalizeTagName("  Shoegaze "), normalizeTagName("SHOEGAZE"));
});
