// @ts-expect-error Node's type-stripping test runner requires the .ts extension.
import { resolveSupportedAudioFileFormat } from "./audio-file-format.ts";
// @ts-expect-error Node's type-stripping test runner requires the .ts extension.
import { isValidAudioStoragePath } from "./audio-storage-path.ts";

export type AudioContentDisposition = "attachment" | "inline";

const AUDIO_EXTENSION_PATTERN =
  /\.(?:aac|aif|aiff|flac|m4a|mp3|oga|ogg|opus|wav|wave|webm)$/i;
const UNSAFE_FILE_NAME_CHARACTERS = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;

function storedAudioExtension(storagePath: string): string | null {
  if (!isValidAudioStoragePath(storagePath)) return null;
  const extension = storagePath.slice(storagePath.lastIndexOf(".") + 1).toLowerCase();
  return extension || null;
}

function mimeTypeExtension(mimeType: string): string | null {
  return resolveSupportedAudioFileFormat(mimeType, "")?.extension ?? null;
}

function replaceLoneSurrogates(value: string): string {
  return Array.from(value, (character) => {
    const codePoint = character.charCodeAt(0);
    return character.length === 1 && codePoint >= 0xd800 && codePoint <= 0xdfff
      ? "_"
      : character;
  }).join("");
}

function truncateUtf8(value: string, maximumBytes: number): string {
  const encoder = new TextEncoder();
  let byteSize = 0;
  let result = "";
  for (const character of value) {
    const characterBytes = encoder.encode(character).byteLength;
    if (byteSize + characterBytes > maximumBytes) break;
    result += character;
    byteSize += characterBytes;
  }
  return result;
}

function safeAudioLabel(value: string): string {
  const cleaned = replaceLoneSurrogates(value.normalize("NFKC"))
    .replace(UNSAFE_FILE_NAME_CHARACTERS, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(AUDIO_EXTENSION_PATTERN, "")
    .replace(/^\.+/, "")
    .replace(/[. ]+$/, "");
  return truncateUtf8(cleaned, 180) || "take";
}

/**
 * Uses the extension of the immutable stored source, not a user-edited take
 * name, so downloading never claims the original bytes are another format.
 */
export function safeAudioDownloadFileName(
  takeName: string,
  storagePath: string,
  mimeType: string,
): string {
  const extension = storedAudioExtension(storagePath)
    ?? mimeTypeExtension(mimeType)
    ?? "webm";
  return `${safeAudioLabel(takeName)}.${extension}`;
}

function safeHeaderFileName(value: string): string {
  const cleaned = replaceLoneSurrogates(value.normalize("NFKC"))
    .replace(UNSAFE_FILE_NAME_CHARACTERS, "_")
    .replace(/\s+/g, " ")
    .trim();
  return truncateUtf8(cleaned, 220) || "audio";
}

function rfc5987FileName(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function asciiFileNameFallback(value: string): string {
  const fallback = value
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\;]/g, "_")
    .replace(/_+/g, "_")
    .trim();
  return fallback || "audio";
}

export function audioContentDispositionHeader(
  disposition: AudioContentDisposition,
  fileName: string,
): string {
  const safeFileName = safeHeaderFileName(fileName);
  return `${disposition}; filename="${asciiFileNameFallback(safeFileName)}"; filename*=UTF-8''${rfc5987FileName(safeFileName)}`;
}
