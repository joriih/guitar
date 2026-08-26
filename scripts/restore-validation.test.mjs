import assert from "node:assert/strict";
import test from "node:test";

import {
  assertStorageExact,
  databaseStateMatchesManifest,
} from "./restore-validation.mjs";

const expectedCounts = { albums: 1, riffs: 2, takes: 1 };
const expectedFiles = [
  { name: "take.webm", bytes: 123, kind: "take" },
  { name: "backing.wav", bytes: 456, kind: "track" },
];
const exactState = {
  counts: { ...expectedCounts },
  storage: [
    { storage_path: "backing.wav", byte_size: "456", kind: "track" },
    { storage_path: "take.webm", byte_size: "123", kind: "take" },
  ],
};

test("commit ambiguity accepts only exact manifest counts, paths, sizes, and kinds", () => {
  assert.equal(
    databaseStateMatchesManifest(exactState, expectedCounts, expectedFiles),
    true,
  );

  for (const state of [
    { ...exactState, counts: { ...expectedCounts, riffs: 1 } },
    { ...exactState, storage: exactState.storage.slice(0, 1) },
    {
      ...exactState,
      storage: exactState.storage.map((row) =>
        row.storage_path === "take.webm" ? { ...row, byte_size: "124" } : row,
      ),
    },
    {
      ...exactState,
      storage: exactState.storage.map((row) =>
        row.storage_path === "take.webm" ? { ...row, kind: "track" } : row,
      ),
    },
  ]) {
    assert.equal(
      databaseStateMatchesManifest(state, expectedCounts, expectedFiles),
      false,
    );
  }
});

test("unsafe and duplicate restored storage metadata is rejected", () => {
  assert.throws(() =>
    assertStorageExact(
      [{ storage_path: "../take.webm", byte_size: 123, kind: "take" }],
      [{ name: "../take.webm", bytes: 123, kind: "take" }],
    ),
  );
  assert.throws(() =>
    assertStorageExact(
      [
        { storage_path: "take.webm", byte_size: 123, kind: "take" },
        { storage_path: "take.webm", byte_size: 123, kind: "take" },
      ],
      [{ name: "take.webm", bytes: 123, kind: "take" }],
    ),
  );
});

