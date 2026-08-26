import type { PoolClient } from "pg";

import { removeAudioFile } from "@/lib/audio-storage";
import {
  removeUnreferencedAudioFilesWith,
  type AudioCompensationDependencies,
} from "@/lib/audio-compensation-core";
import { AmbiguousTransactionCommitError, db } from "@/lib/db";

async function queryReferencedAudioPaths(
  storagePaths: readonly string[],
): Promise<Set<string>> {
  // Always leave the failed transaction before asking PostgreSQL whether a
  // path committed. A fresh pool checkout makes an uncertain COMMIT safe:
  // referenced files are preserved, and an unverifiable file is never deleted.
  let client: PoolClient | null = null;
  try {
    client = await db.connect();
    const result = await client.query<{ storage_path: string }>(
      `SELECT candidate.storage_path
         FROM unnest($1::text[]) AS candidate(storage_path)
        WHERE EXISTS (
                SELECT 1
                  FROM take_recording
                 WHERE take_recording.storage_path = candidate.storage_path
              )
           OR EXISTS (
                SELECT 1
                  FROM riff_track
                 WHERE riff_track.storage_path = candidate.storage_path
              )`,
      [storagePaths],
    );
    return new Set(result.rows.map((row) => row.storage_path));
  } finally {
    client?.release();
  }
}

const productionDependencies: AudioCompensationDependencies = {
  findReferencedPaths: queryReferencedAudioPaths,
  removeFile: removeAudioFile,
  logError: (message, error) => console.error(message, error),
};

export async function removeUnreferencedAudioFiles(
  storagePaths: readonly string[],
  dependencies: AudioCompensationDependencies = productionDependencies,
): Promise<{
  removed: string[];
  preserved: string[];
}> {
  return removeUnreferencedAudioFilesWith(storagePaths, dependencies);
}

export async function compensateAudioWriteFailure(
  error: unknown,
  storagePaths: readonly string[],
): Promise<unknown> {
  if (storagePaths.length === 0) return error;
  if (error instanceof AmbiguousTransactionCommitError) {
    console.error(
      "COMMIT 결과가 불확실해 데이터 보호를 위해 새 오디오 파일을 보존했어요.",
      error,
    );
    return error;
  }
  try {
    await removeUnreferencedAudioFiles(storagePaths);
    return error;
  } catch (compensationError) {
    return new AggregateError(
      [error, compensationError],
      "오디오 저장 실패를 안전하게 정리하지 못했어요.",
    );
  }
}
