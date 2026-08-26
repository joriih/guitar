export type AudioCompensationDependencies = {
  findReferencedPaths: (storagePaths: readonly string[]) => Promise<Set<string>>;
  removeFile: (storagePath: string) => Promise<void>;
  logError: (message: string, error: unknown) => void;
};

export async function removeUnreferencedAudioFilesWith(
  storagePaths: readonly string[],
  dependencies: AudioCompensationDependencies,
): Promise<{
  removed: string[];
  preserved: string[];
}> {
  const candidates = [...new Set(storagePaths)].filter(Boolean);
  if (candidates.length === 0) return { removed: [], preserved: [] };

  let referenced: Set<string>;
  try {
    referenced = await dependencies.findReferencedPaths(candidates);
  } catch (error) {
    dependencies.logError(
      "오디오 보상 삭제 전 데이터베이스 참조를 확인하지 못해 파일을 보존했어요.",
      error,
    );
    throw new AggregateError(
      [error],
      "오디오 파일 참조를 확인하지 못해 안전을 위해 파일을 보존했어요.",
    );
  }

  const removed: string[] = [];
  const preserved: string[] = [];
  const cleanupErrors: unknown[] = [];
  for (const storagePath of candidates) {
    if (referenced.has(storagePath)) {
      preserved.push(storagePath);
      continue;
    }
    try {
      await dependencies.removeFile(storagePath);
      removed.push(storagePath);
    } catch (error) {
      cleanupErrors.push(error);
      dependencies.logError("참조되지 않은 오디오 파일을 정리하지 못했어요.", error);
    }
  }

  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      cleanupErrors,
      "실패한 저장 작업의 오디오 파일 일부를 정리하지 못했어요.",
    );
  }
  return { removed, preserved };
}
