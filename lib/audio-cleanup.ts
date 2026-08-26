import type { PoolClient } from "pg";

import {
  attemptQueuedAudioCleanupWith,
  type AudioCleanupDependencies,
  type AudioCleanupResult,
} from "@/lib/audio-cleanup-core";
import { removeAudioFile, resolveAudioPath } from "@/lib/audio-storage";
import { db } from "@/lib/db";

export type { AudioCleanupResult } from "@/lib/audio-cleanup-core";

function assertValidStoragePath(storagePath: string): void {
  // resolveAudioPath applies the same basename, UUID, extension, and isolated
  // namespace rules as playback. The resolved path is intentionally discarded.
  resolveAudioPath(storagePath);
}

async function referencedInDatabase(storagePath: string): Promise<boolean> {
  const result = await db.query<{ referenced: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM take_recording WHERE storage_path = $1
       UNION ALL
       SELECT 1 FROM riff_track WHERE storage_path = $1
     ) AS referenced`,
    [storagePath],
  );
  return result.rows[0]?.referenced ?? false;
}

const productionDependencies: AudioCleanupDependencies = {
  isReferenced: referencedInDatabase,
  removeFile: removeAudioFile,
  acknowledge: async (storagePath) => {
    await db.query("DELETE FROM audio_cleanup_queue WHERE storage_path = $1", [
      storagePath,
    ]);
  },
  recordFailure: async (storagePath, cleanupErrorCode) => {
    await db.query(
      `UPDATE audio_cleanup_queue
          SET attempts = attempts + 1,
              last_error = $2
        WHERE storage_path = $1`,
      [storagePath, cleanupErrorCode],
    );
  },
  logFailure: (cleanupErrorCode) => {
    console.error(
      `오디오 파일 정리를 다음 실행으로 미뤘어요. 오류 코드: ${cleanupErrorCode}`,
    );
  },
};

export async function enqueueAudioCleanup(
  client: PoolClient,
  storagePath: string,
): Promise<void> {
  assertValidStoragePath(storagePath);
  await client.query(
    `INSERT INTO audio_cleanup_queue (storage_path)
     VALUES ($1)
     ON CONFLICT (storage_path) DO NOTHING`,
    [storagePath],
  );
}

export async function attemptQueuedAudioCleanup(
  storagePath: string,
  dependencies: AudioCleanupDependencies = productionDependencies,
): Promise<AudioCleanupResult> {
  assertValidStoragePath(storagePath);
  return attemptQueuedAudioCleanupWith(storagePath, dependencies);
}

export async function drainAudioCleanupQueue(options?: {
  limit?: number;
}): Promise<{ processed: number; cleared: number; pending: number }> {
  const limit = options?.limit ?? 1_000;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
    throw new TypeError("Audio cleanup limit must be between 1 and 10000.");
  }

  const result = await db.query<{ storage_path: string }>(
    `SELECT storage_path
       FROM audio_cleanup_queue
      ORDER BY queued_at, storage_path
      LIMIT $1`,
    [limit],
  );
  let cleared = 0;
  let pending = 0;
  for (const row of result.rows) {
    const cleanup = await attemptQueuedAudioCleanup(row.storage_path);
    if (cleanup.cleanupPending) pending += 1;
    else cleared += 1;
  }
  return { processed: result.rows.length, cleared, pending };
}
