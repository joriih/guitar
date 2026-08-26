export type SupportedAudioFileFormat = {
  extension: string;
  mimeType: string;
};

// Keep the whole multipart request below Cloudflare's 100,000,000-byte proxy
// limit while leaving room for form fields and multipart framing.
export const MAX_AUDIO_FILE_BYTES = 95 * 1024 * 1024;

export type AudioFilePreflightResult =
  | { ok: true; format: SupportedAudioFileFormat }
  | {
      ok: false;
      message: string;
      reason: "empty" | "too-large" | "unsupported";
      status: 400 | 413 | 415;
    };

export const SUPPORTED_AUDIO_FILE_EXTENSIONS = [
  "mp3",
  "wav",
  "wave",
  "aif",
  "aiff",
  "m4a",
  "aac",
  "flac",
  "ogg",
  "oga",
  "opus",
  "webm",
] as const;

type AudioFormatDefinition = SupportedAudioFileFormat & {
  family: string;
};

const MIME_FORMATS: Record<string, AudioFormatDefinition> = {
  "audio/webm": { extension: "webm", mimeType: "audio/webm", family: "webm" },
  "video/webm": { extension: "webm", mimeType: "video/webm", family: "webm" },
  "audio/ogg": { extension: "ogg", mimeType: "audio/ogg", family: "ogg-opus" },
  "application/ogg": { extension: "ogg", mimeType: "application/ogg", family: "ogg-opus" },
  "audio/wav": { extension: "wav", mimeType: "audio/wav", family: "wav" },
  "audio/x-wav": { extension: "wav", mimeType: "audio/x-wav", family: "wav" },
  "audio/wave": { extension: "wav", mimeType: "audio/wave", family: "wav" },
  "audio/vnd.wave": { extension: "wav", mimeType: "audio/vnd.wave", family: "wav" },
  "audio/aiff": { extension: "aiff", mimeType: "audio/aiff", family: "aiff" },
  "audio/x-aiff": { extension: "aiff", mimeType: "audio/x-aiff", family: "aiff" },
  "audio/mpeg": { extension: "mp3", mimeType: "audio/mpeg", family: "mp3" },
  "audio/mp4": { extension: "m4a", mimeType: "audio/mp4", family: "m4a" },
  "audio/x-m4a": { extension: "m4a", mimeType: "audio/x-m4a", family: "m4a" },
  "video/mp4": { extension: "m4a", mimeType: "video/mp4", family: "m4a" },
  "audio/aac": { extension: "aac", mimeType: "audio/aac", family: "aac" },
  "audio/flac": { extension: "flac", mimeType: "audio/flac", family: "flac" },
  "audio/x-flac": { extension: "flac", mimeType: "audio/x-flac", family: "flac" },
  "audio/opus": { extension: "opus", mimeType: "audio/opus", family: "ogg-opus" },
};

const FILE_EXTENSION_FORMATS: Record<string, AudioFormatDefinition> = {
  mp3: MIME_FORMATS["audio/mpeg"]!,
  wav: MIME_FORMATS["audio/wav"]!,
  wave: MIME_FORMATS["audio/wav"]!,
  aif: MIME_FORMATS["audio/aiff"]!,
  aiff: MIME_FORMATS["audio/aiff"]!,
  m4a: MIME_FORMATS["audio/mp4"]!,
  aac: MIME_FORMATS["audio/aac"]!,
  flac: MIME_FORMATS["audio/flac"]!,
  ogg: MIME_FORMATS["audio/ogg"]!,
  oga: MIME_FORMATS["audio/ogg"]!,
  opus: MIME_FORMATS["audio/opus"]!,
  webm: MIME_FORMATS["audio/webm"]!,
};

const GENERIC_BINARY_MIME_TYPES = new Set(["", "application/octet-stream"]);

export function normalizeMimeType(value: string): string {
  return value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function fileNameExtension(fileName: string): string | null {
  const baseName = fileName.split(/[\\/]/).at(-1) ?? "";
  const dot = baseName.lastIndexOf(".");
  if (dot <= 0 || dot === baseName.length - 1) return null;
  return baseName.slice(dot + 1).toLowerCase();
}

function displayFileName(fileName: string): string {
  const baseName = fileName.split(/[\\/]/).at(-1) ?? "";
  return baseName
    .replace(/[\u0000-\u001f\u007f]/g, "_")
    .trim()
    .slice(0, 120) || "선택한 파일";
}

/**
 * Uses the filename only when a browser supplies no useful MIME type. A known
 * MIME paired with a conflicting or unsupported extension is rejected rather
 * than silently relabelled.
 */
export function resolveSupportedAudioFileFormat(
  mimeTypeValue: string,
  fileName: string,
): SupportedAudioFileFormat | null {
  const mimeType = normalizeMimeType(mimeTypeValue);
  const extensionValue = fileNameExtension(fileName);
  const extensionFormat = extensionValue
    ? FILE_EXTENSION_FORMATS[extensionValue] ?? null
    : null;
  const mimeFormat = MIME_FORMATS[mimeType] ?? null;

  if (mimeFormat) {
    if (extensionValue && (!extensionFormat || extensionFormat.family !== mimeFormat.family)) {
      return null;
    }
    return { extension: mimeFormat.extension, mimeType: mimeFormat.mimeType };
  }
  if (!GENERIC_BINARY_MIME_TYPES.has(mimeType) || !extensionFormat) return null;
  return {
    extension: extensionFormat.extension,
    mimeType: extensionFormat.mimeType,
  };
}

/** Cheap validation that must run before reading or hashing file bytes. */
export function preflightAudioFile(file: {
  name: string;
  size: number;
  type: string;
}): AudioFilePreflightResult {
  const name = displayFileName(file.name);
  if (!Number.isFinite(file.size) || file.size <= 0) {
    return {
      ok: false,
      message: `${name}: 비어 있는 오디오 파일이에요.`,
      reason: "empty",
      status: 400,
    };
  }
  if (file.size > MAX_AUDIO_FILE_BYTES) {
    return {
      ok: false,
      message: `${name}: 오디오 파일은 파일당 95MB까지 추가할 수 있어요.`,
      reason: "too-large",
      status: 413,
    };
  }
  const format = resolveSupportedAudioFileFormat(file.type, file.name);
  if (!format) {
    return {
      ok: false,
      message: `${name}: 지원하지 않는 오디오 형식이에요.`,
      reason: "unsupported",
      status: 415,
    };
  }
  return { ok: true, format };
}
