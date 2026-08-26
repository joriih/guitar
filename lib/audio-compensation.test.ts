import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error Node's type-stripping test runner requires the .ts extension.
import { removeUnreferencedAudioFilesWith } from "./audio-compensation-core.ts";

test("audio compensation removes only paths proven to be unreferenced", async () => {
  const removed: string[] = [];
  const result = await removeUnreferencedAudioFilesWith(["new.wav", "committed.wav"], {
    findReferencedPaths: async () => new Set(["committed.wav"]),
    removeFile: async (storagePath: string) => {
      removed.push(storagePath);
    },
    logError: () => undefined,
  });

  assert.deepEqual(removed, ["new.wav"]);
  assert.deepEqual(result, {
    removed: ["new.wav"],
    preserved: ["committed.wav"],
  });
});

test("audio compensation preserves every file when reference verification fails", async () => {
  const removed: string[] = [];
  const logs: unknown[] = [];

  await assert.rejects(
    removeUnreferencedAudioFilesWith(["uncertain.wav"], {
      findReferencedPaths: async () => {
        throw new Error("connection lost");
      },
      removeFile: async (storagePath: string) => {
        removed.push(storagePath);
      },
      logError: (_message: string, error: unknown) => {
        logs.push(error);
      },
    }),
    /안전을 위해 파일을 보존/,
  );

  assert.deepEqual(removed, []);
  assert.equal(logs.length, 1);
});

test("audio compensation de-duplicates paths before checking and deleting", async () => {
  const checked: string[][] = [];
  const removed: string[] = [];
  await removeUnreferencedAudioFilesWith(["same.wav", "same.wav"], {
    findReferencedPaths: async (storagePaths: readonly string[]) => {
      checked.push([...storagePaths]);
      return new Set();
    },
    removeFile: async (storagePath: string) => {
      removed.push(storagePath);
    },
    logError: () => undefined,
  });

  assert.deepEqual(checked, [["same.wav"]]);
  assert.deepEqual(removed, ["same.wav"]);
});
