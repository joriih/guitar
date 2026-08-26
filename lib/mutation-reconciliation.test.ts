import assert from "node:assert/strict";
import test from "node:test";

import {
  conflictCurrent,
  deletionAlreadyApplied,
  mutationAlreadyApplied,
  nonnegativeRevision,
  reconciledTakeDuplicate,
  reconciledTakeSplit,
  type TakeMutationSnapshot,
} from
// @ts-expect-error Node's type-stripping test runner requires the .ts extension.
"./mutation-reconciliation.ts";

const source: TakeMutationSnapshot = {
  id: "source",
  revision: 3,
  name: "Verse",
  durationMs: 8_000,
  trimStartMs: 1_000,
  trimEndMs: 7_000,
  offsetMs: 500,
  isPrimary: true,
};

test("strict revision parsing and conflict entity extraction", () => {
  assert.equal(nonnegativeRevision(0), 0);
  assert.equal(nonnegativeRevision(2.5), null);
  assert.equal(nonnegativeRevision("2"), null);
  assert.deepEqual(conflictCurrent({ current: { id: "a", revision: 4 } }), {
    id: "a",
    revision: 4,
  });
  assert.equal(conflictCurrent({ current: { id: "a", revision: "4" } }), null);
});

test("PATCH and DELETE response-loss checks only accept achieved state", () => {
  const current = { ...source, name: "Verse lead", offsetMs: 900 };
  assert.equal(mutationAlreadyApplied(current, { name: "Verse lead" }), true);
  assert.equal(mutationAlreadyApplied(current, { name: "Other" }), false);
  assert.equal(deletionAlreadyApplied("source", [current]), false);
  assert.equal(deletionAlreadyApplied("source", []), true);
});

test("duplicate reconciliation requires a new matching take", () => {
  const duplicate = {
    ...source,
    id: "copy",
    revision: 0,
    name: "Verse 복사본",
    isPrimary: false,
  };
  assert.equal(
    reconciledTakeDuplicate(source, new Set([source.id]), [source, duplicate])?.id,
    "copy",
  );
  assert.equal(
    reconciledTakeDuplicate(source, new Set([source.id, duplicate.id]), [source, duplicate]),
    null,
  );
});

test("split reconciliation verifies both updated source and a new second half", () => {
  const original = { ...source, revision: 4, trimEndMs: 4_000 };
  const secondHalf = {
    ...source,
    id: "second",
    revision: 0,
    name: "Verse B",
    trimStartMs: 4_000,
    trimEndMs: 7_000,
    offsetMs: 3_500,
    isPrimary: false,
  };
  assert.equal(
    reconciledTakeSplit(source, 4_000, new Set([source.id]), [original, secondHalf])?.id,
    "second",
  );
  assert.equal(
    reconciledTakeSplit(source, 4_000, new Set([source.id]), [source, secondHalf]),
    null,
  );
});
