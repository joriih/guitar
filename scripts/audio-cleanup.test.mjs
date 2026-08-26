import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, symlink, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { drainAudioCleanup, safeRemoveStoredAudioFile } from "./audio-cleanup.mjs";

function queuedClient(storagePath) {
  const state = { queued: true, attempts: 0, lastError: null };
  return {
    state,
    async query(sql, values) {
      if (sql.includes("SELECT storage_path")) {
        return { rows: state.queued ? [{ storage_path: storagePath }] : [] };
      }
      if (sql.includes("AS referenced")) return { rows: [{ referenced: false }] };
      if (sql.startsWith("DELETE FROM audio_cleanup_queue")) {
        state.queued = false;
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("UPDATE audio_cleanup_queue")) {
        state.attempts += 1;
        state.lastError = values[1];
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected test query: ${sql}`);
    },
  };
}

test("the next drain removes a crash-left queued file and acknowledges it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "riff-cleanup-"));
  const storagePath = `${randomUUID()}.wav`;
  try {
    await mkdir(path.join(root, "storage", "audio"), { recursive: true });
    await writeFile(path.join(root, "storage", "audio", storagePath), "wave");
    const client = queuedClient(storagePath);
    assert.deepEqual(await drainAudioCleanup({ client, root }), {
      processed: 1,
      cleared: 1,
      pending: 0,
    });
    assert.equal(client.state.queued, false);
    await assert.rejects(
      readFile(path.join(root, "storage", "audio", storagePath)),
      { code: "ENOENT" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing queued files clear, while unlink failures stay queued and increment", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "riff-cleanup-"));
  const storagePath = `${randomUUID()}.wav`;
  try {
    await mkdir(path.join(root, "storage", "audio"), { recursive: true });
    const missingClient = queuedClient(storagePath);
    assert.equal((await drainAudioCleanup({ client: missingClient, root })).cleared, 1);

    const failureClient = queuedClient(storagePath);
    const permissionError = Object.assign(new Error("private filename"), {
      code: "EPERM",
    });
    const result = await drainAudioCleanup({
      client: failureClient,
      root,
      removeFile: async () => {
        throw permissionError;
      },
    });
    assert.deepEqual(result, { processed: 1, cleared: 0, pending: 1 });
    assert.equal(failureClient.state.queued, true);
    assert.equal(failureClient.state.attempts, 1);
    assert.equal(failureClient.state.lastError, "EPERM");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cleanup rejects traversal and never follows file or directory symlinks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "riff-cleanup-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "riff-cleanup-outside-"));
  const storagePath = `${randomUUID()}.wav`;
  const outsideFile = path.join(outside, "recording.wav");
  try {
    await mkdir(path.join(root, "storage", "audio"), { recursive: true });
    await writeFile(outsideFile, "keep");
    await symlink(outsideFile, path.join(root, "storage", "audio", storagePath));
    await assert.rejects(
      safeRemoveStoredAudioFile({ root, storagePath }),
      { code: "UNSAFE_AUDIO_TARGET" },
    );
    assert.equal(await readFile(outsideFile, "utf8"), "keep");
    await assert.rejects(
      safeRemoveStoredAudioFile({ root, storagePath: `../${storagePath}` }),
      { code: "INVALID_AUDIO_STORAGE_PATH" },
    );

    const linkedRoot = await mkdtemp(path.join(os.tmpdir(), "riff-cleanup-link-"));
    try {
      await symlink(outside, path.join(linkedRoot, "storage"));
      await assert.rejects(
        safeRemoveStoredAudioFile({ root: linkedRoot, storagePath }),
        { code: "UNSAFE_STORAGE_DIRECTORY" },
      );
    } finally {
      await rm(linkedRoot, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
