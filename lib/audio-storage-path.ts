const STORED_EXTENSIONS = new Set([
  "webm",
  "ogg",
  "wav",
  "aiff",
  "mp3",
  "m4a",
  "aac",
  "flac",
  "opus",
]);

const STORED_FILE_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.([a-z0-9]+)$/i;

export function isValidAudioStoragePath(storagePath: unknown): storagePath is string {
  if (typeof storagePath !== "string" || storagePath.includes("/") || storagePath.includes("\\")) {
    return false;
  }
  const match = STORED_FILE_PATTERN.exec(storagePath);
  return Boolean(match && STORED_EXTENSIONS.has(match[1]?.toLowerCase() ?? ""));
}
