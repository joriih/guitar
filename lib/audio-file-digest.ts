import { createHash } from "node:crypto";

/** Hashes an uploaded Blob without materializing a second full-size buffer. */
export async function sha256AudioBlob(
  blob: { stream: () => ReadableStream<Uint8Array<ArrayBufferLike>> },
  prefix?: string | Uint8Array,
): Promise<string> {
  const hash = createHash("sha256");
  if (prefix !== undefined) hash.update(prefix);
  const reader = blob.stream().getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > 0) hash.update(value);
    }
  } finally {
    reader.releaseLock();
  }
  return hash.digest("hex");
}
