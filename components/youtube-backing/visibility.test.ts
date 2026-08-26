import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error Node's type-stripping test runner requires the .ts extension.
import { isRectMostlyVisible } from "./visibility.ts";

function rect(
  left: number,
  top: number,
  width: number,
  height: number,
) {
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
  };
}

const VIEWPORT = { width: 1_000, height: 800 };

test("accepts a player meeting the minimum size when at least half is visible", () => {
  assert.equal(isRectMostlyVisible(rect(100, 100, 200, 200), VIEWPORT), true);
  assert.equal(isRectMostlyVisible(rect(-100, 100, 200, 200), VIEWPORT), true);
  assert.equal(isRectMostlyVisible(rect(100, -100, 200, 200), VIEWPORT), true);
});

test("rejects a player when less than half of its area is visible", () => {
  assert.equal(isRectMostlyVisible(rect(-101, 100, 200, 200), VIEWPORT), false);
  assert.equal(isRectMostlyVisible(rect(901, 100, 200, 200), VIEWPORT), false);
  assert.equal(isRectMostlyVisible(rect(100, 701, 200, 200), VIEWPORT), false);
});

test("rejects undersized, outside, and invalid rectangles", () => {
  assert.equal(isRectMostlyVisible(rect(100, 100, 199, 300), VIEWPORT), false);
  assert.equal(isRectMostlyVisible(rect(100, 100, 300, 199), VIEWPORT), false);
  assert.equal(isRectMostlyVisible(rect(1_100, 900, 300, 300), VIEWPORT), false);
  assert.equal(
    isRectMostlyVisible(rect(0, 0, Number.NaN, 300), VIEWPORT),
    false,
  );
});

