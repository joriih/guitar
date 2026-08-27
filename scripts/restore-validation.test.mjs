import assert from "node:assert/strict";
import test from "node:test";

import {
  assertStorageExact,
  databaseStateMatchesManifest,
  isRestorableAudioStoragePath,
} from "./restore-validation.mjs";

const expectedCounts = { albums: 1, riffs: 2, takes: 1 };
const TAKE_PATH = "11111111-1111-4111-8111-111111111111.webm";
const TRACK_PATH = "22222222-2222-4222-8222-222222222222.wav";
const expectedFiles = [
  { name: TAKE_PATH, bytes: 123, kind: "take" },
  { name: TRACK_PATH, bytes: 456, kind: "track" },
];
const exactState = {
  counts: { ...expectedCounts },
  storage: [
    { storage_path: TRACK_PATH, byte_size: "456", kind: "track" },
    { storage_path: TAKE_PATH, byte_size: "123", kind: "take" },
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
        row.storage_path === TAKE_PATH ? { ...row, byte_size: "124" } : row,
      ),
    },
    {
      ...exactState,
      storage: exactState.storage.map((row) =>
        row.storage_path === TAKE_PATH ? { ...row, kind: "track" } : row,
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
        { storage_path: TAKE_PATH, byte_size: 123, kind: "take" },
        { storage_path: TAKE_PATH, byte_size: 123, kind: "take" },
      ],
      [{ name: TAKE_PATH, bytes: 123, kind: "take" }],
    ),
  );
});

test("only canonical application audio paths can enter a restored generation", () => {
  for (const value of [
    TAKE_PATH,
    TRACK_PATH,
    "33333333-3333-4333-8333-333333333333.aiff",
    "44444444-4444-4444-8444-444444444444.flac",
  ]) {
    assert.equal(isRestorableAudioStoragePath(value), true);
  }
  for (const value of [
    "take.webm",
    "../take.webm",
    "11111111-1111-4111-8111-111111111111.exe",
    "11111111-1111-4111-8111-111111111111.wave",
    "11111111-1111-4111-8111-111111111111.WEBM.extra",
    "",
  ]) {
    assert.equal(isRestorableAudioStoragePath(value), false);
  }

  assert.throws(() =>
    assertStorageExact(
      [{ storage_path: TAKE_PATH, byte_size: 123, kind: "take" }],
      [{ name: "take.webm", bytes: 123, kind: "take" }],
    ),
  );
  assert.throws(() =>
    assertStorageExact(
      [{ storage_path: TAKE_PATH, byte_size: 123, kind: "take" }],
      [{ name: TAKE_PATH, bytes: 0, kind: "take" }],
    ),
  );
});
