export type AudioCleanupResult = Readonly<{
  cleanupPending: boolean;
  outcome: "removed" | "missing" | "referenced" | "pending";
}>;

export type AudioCleanupDependencies = Readonly<{
  isReferenced: (storagePath: string) => Promise<boolean>;
  removeFile: (storagePath: string) => Promise<void>;
  acknowledge: (storagePath: string) => Promise<void>;
  recordFailure: (storagePath: string, errorCode: string) => Promise<void>;
  logFailure: (errorCode: string) => void;
}>;

export function audioCleanupErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const value = (error as { code?: unknown }).code;
    if (typeof value === "string" && /^[A-Z][A-Z0-9_]{0,62}$/.test(value)) {
      return value;
    }
  }
  return "AUDIO_CLEANUP_IO_ERROR";
}

async function retainWithFailure(
  storagePath: string,
  cleanupErrorCode: string,
  dependencies: AudioCleanupDependencies,
): Promise<AudioCleanupResult> {
  await dependencies.recordFailure(storagePath, cleanupErrorCode).catch(() => {
    dependencies.logFailure("AUDIO_CLEANUP_QUEUE_UPDATE_FAILED");
  });
  dependencies.logFailure(cleanupErrorCode);
  return { cleanupPending: true, outcome: "pending" };
}

export async function attemptQueuedAudioCleanupWith(
  storagePath: string,
  dependencies: AudioCleanupDependencies,
): Promise<AudioCleanupResult> {
  let referenced: boolean;
  try {
    referenced = await dependencies.isReferenced(storagePath);
  } catch {
    return retainWithFailure(
      storagePath,
      "AUDIO_REFERENCE_CHECK_FAILED",
      dependencies,
    );
  }

  if (referenced) {
    try {
      await dependencies.acknowledge(storagePath);
      return { cleanupPending: false, outcome: "referenced" };
    } catch {
      return retainWithFailure(
        storagePath,
        "AUDIO_CLEANUP_QUEUE_ACK_FAILED",
        dependencies,
      );
    }
  }

  let outcome: AudioCleanupResult["outcome"] = "removed";
  try {
    await dependencies.removeFile(storagePath);
  } catch (error) {
    if (audioCleanupErrorCode(error) === "ENOENT") {
      outcome = "missing";
    } else {
      return retainWithFailure(
        storagePath,
        audioCleanupErrorCode(error),
        dependencies,
      );
    }
  }

  try {
    await dependencies.acknowledge(storagePath);
    return { cleanupPending: false, outcome };
  } catch {
    return retainWithFailure(
      storagePath,
      "AUDIO_CLEANUP_QUEUE_ACK_FAILED",
      dependencies,
    );
  }
}
