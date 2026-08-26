import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error Node's type-stripping test runner requires the .ts extension.
import { cleanMarkerLabel, isMarkerColor, markerPositionPercent, reconcileMarkerPatch, sortMarkers } from "./markers.ts";

test("marker labels are normalized into a concise single-line value", () => {
  assert.equal(cleanMarkerLabel("  Ｖｅｒｓｅ\t  2  "), "Verse 2");
  assert.equal(cleanMarkerLabel(" 인트로   리프 "), "인트로 리프");
});

test("marker colors only accept the persisted preset allowlist", () => {
  assert.equal(isMarkerColor("rose"), true);
  assert.equal(isMarkerColor("sky"), true);
  assert.equal(isMarkerColor("#ff0000"), false);
  assert.equal(isMarkerColor(null), false);
});

test("markers sort by timeline position then stable creation order", () => {
  const source = [
    { id: "c", positionMs: 2_000, sortOrder: 2 },
    { id: "b", positionMs: 1_000, sortOrder: 1 },
    { id: "a", positionMs: 1_000, sortOrder: 0 },
  ];
  assert.deepEqual(sortMarkers(source).map((marker) => marker.id), ["a", "b", "c"]);
  assert.deepEqual(source.map((marker) => marker.id), ["c", "b", "a"]);
});

test("marker lane percentages clamp safely to the timeline", () => {
  assert.equal(markerPositionPercent(500, 2_000), 25);
  assert.equal(markerPositionPercent(3_000, 2_000), 100);
  assert.equal(markerPositionPercent(-10, 2_000), 0);
  assert.equal(markerPositionPercent(500, 0), 0);
});

test("persisted marker patches only rebase when their revision is still current", () => {
  const current = { revision: 4, label: "Verse", color: "sky" };
  assert.equal(
    reconcileMarkerPatch(4, current, 4, { label: "Chorus" }),
    "ready",
  );
  assert.equal(
    reconcileMarkerPatch(4, current, 3, { label: "Verse" }),
    "applied",
  );
  assert.equal(
    reconcileMarkerPatch(4, current, 3, { label: "Chorus" }),
    "conflict",
  );
  assert.equal(
    reconcileMarkerPatch(4, current, null, { color: "amber" }),
    "conflict",
  );
});
