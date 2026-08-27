import { constants as fsConstants } from "node:fs";
import { open, unlink } from "node:fs/promises";

type AudioWriteHandle = {
  write: (
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: null,
  ) => Promise<{ bytesWritten: number }>;
  close: () => Promise<void>;
};

export type AudioStreamWriteDependencies = {
  openExclusiveFile: (absolutePath: string) => Promise<AudioWriteHandle>;
  removeFile: (absolutePath: string) => Promise<void>;
};

const productionDependencies: AudioStreamWriteDependencies = {
  openExclusiveFile: (absolutePath) => open(
    absolutePath,
    fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      fsConstants.O_WRONLY |
      fsConstants.O_NOFOLLOW,
    0o600,
  ),
  removeFile: unlink,
};

/**
 * Writes a browser Blob stream to one new file without buffering the whole
 * upload. A short or failed stream never leaves an untracked partial file.
 */
export async function writeExclusiveAudioStream(
  absolutePath: string,
  stream: ReadableStream<Uint8Array>,
  expectedByteSize: number,
  dependencies: AudioStreamWriteDependencies = productionDependencies,
): Promise<void> {
  if (!Number.isSafeInteger(expectedByteSize) || expectedByteSize < 0) {
    throw new TypeError("Expected audio byte size must be a nonnegative safe integer.");
  }

  const handle = await dependencies.openExclusiveFile(absolutePath);
  const reader = stream.getReader();
  const failures: unknown[] = [];
  let writtenBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      let offset = 0;
      while (offset < value.byteLength) {
        const { bytesWritten } = await handle.write(
          value,
          offset,
          value.byteLength - offset,
          null,
        );
        if (bytesWritten <= 0) throw new Error("Audio file write made no progress.");
        offset += bytesWritten;
        writtenBytes += bytesWritten;
      }
    }
    if (writtenBytes !== expectedByteSize) {
      throw new Error("Audio upload ended before all declared bytes were written.");
    }
  } catch (error) {
    failures.push(error);
    try {
      await reader.cancel(error);
    } catch (cancelError) {
      failures.push(cancelError);
    }
  }

  try {
    reader.releaseLock();
  } catch (releaseError) {
    failures.push(releaseError);
  }
  try {
    await handle.close();
  } catch (closeError) {
    failures.push(closeError);
  }

  if (failures.length === 0) return;

  try {
    await dependencies.removeFile(absolutePath);
  } catch (cleanupError) {
    if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
      failures.push(cleanupError);
    }
  }

  if (failures.length === 1) throw failures[0];
  throw new AggregateError(
    failures,
    "Audio stream write failed and one or more cleanup operations also failed.",
  );
}
