import type { CaptureState, RecordingTake } from "./types";

type UnknownRecord = Record<string, unknown>;

type ClientStringStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const CLIENT_OPERATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type TakeMutationLock = {
  readonly pendingTakeId: string | null;
  tryAcquire: (takeId: string) => boolean;
  release: (takeId: string) => boolean;
};

/**
 * Advanced playback shares one timeline engine with overdub and punch
 * recording. Keep every user transport control locked until capture and its
 * final upload have fully returned to idle.
 */
export function captureLocksStudioTransport(state: CaptureState): boolean {
  return state !== "idle";
}

export function createTakeMutationLock(): TakeMutationLock {
  let pendingTakeId: string | null = null;
  return {
    get pendingTakeId() {
      return pendingTakeId;
    },
    tryAcquire(takeId: string) {
      if (pendingTakeId !== null) return false;
      pendingTakeId = takeId;
      return true;
    },
    release(takeId: string) {
      if (pendingTakeId !== takeId) return false;
      pendingTakeId = null;
      return true;
    },
  };
}

export function createClientRecordingId(): string {
  const webCrypto = globalThis.crypto;
  if (typeof webCrypto?.randomUUID === "function") return webCrypto.randomUUID();

  const bytes = new Uint8Array(16);
  if (typeof webCrypto?.getRandomValues === "function") {
    webCrypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
    .slice(6, 8)
    .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

export function takeDuplicateRequestStorageKey(
  riffId: string,
  takeId: string,
): string {
  return `riff-sketchbook:take-duplicate:${riffId}:${takeId}`;
}

export function getOrCreateTakeDuplicateRequest(
  storage: ClientStringStorage | null,
  riffId: string,
  takeId: string,
  createId: () => string = createClientRecordingId,
): { requestId: string; storageKey: string } {
  const storageKey = takeDuplicateRequestStorageKey(riffId, takeId);
  if (storage) {
    try {
      const stored = storage.getItem(storageKey);
      if (stored && CLIENT_OPERATION_ID_PATTERN.test(stored)) {
        return { requestId: stored, storageKey };
      }
      if (stored) storage.removeItem(storageKey);
    } catch {
      // The immediate retry still reuses the in-memory ID created below.
    }
  }

  const requestId = createId();
  if (storage) {
    try {
      storage.setItem(storageKey, requestId);
    } catch {
      // Session storage is best-effort; the active request still has its ID.
    }
  }
  return { requestId, storageKey };
}

export function completeTakeDuplicateRequest(
  storage: ClientStringStorage | null,
  storageKey: string,
): void {
  if (!storage) return;
  try {
    storage.removeItem(storageKey);
  } catch {
    // Server completion does not depend on cleaning browser session storage.
  }
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function asBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  return value === 1 || value === "1" || value === "true";
}

export function normalizeTake(value: unknown, index = 0): RecordingTake | null {
  if (!isRecord(value)) return null;

  const id = asString(value.id ?? value.takeId ?? value.take_id);
  if (!id) return null;

  const takeNo = Math.max(
    1,
    Math.round(asNumber(value.takeNo ?? value.take_no ?? value.takeNumber, index + 1)),
  );
  const durationMs = Math.max(
    0,
    asNumber(
      value.durationMs ?? value.duration_ms,
      asNumber(value.durationSeconds ?? value.duration_seconds) * 1_000,
    ),
  );

  const rawTrimEnd = value.trimEndMs ?? value.trim_end_ms;
  const trimEndMs =
    rawTrimEnd === null || rawTrimEnd === undefined
      ? null
      : Math.max(0, asNumber(rawTrimEnd));

  return {
    id,
    riffId: asString(value.riffId ?? value.riff_id),
    takeNo,
    name:
      asString(value.name).trim() || `Take ${String(takeNo).padStart(2, "0")}`,
    durationMs,
    trimStartMs: Math.max(0, asNumber(value.trimStartMs ?? value.trim_start_ms)),
    trimEndMs,
    offsetMs: Math.max(0, asNumber(value.offsetMs ?? value.offset_ms)),
    mimeType: asString(value.mimeType ?? value.mime_type, "audio/webm"),
    byteSize: Math.max(0, asNumber(value.byteSize ?? value.byte_size)),
    isPrimary: asBoolean(value.isPrimary ?? value.is_primary ?? value.primary),
    revision: Math.max(0, Math.round(asNumber(value.revision))),
    createdAt: asString(value.createdAt ?? value.created_at),
    audioUrl:
      asString(value.audioUrl ?? value.audio_url) ||
      `/api/takes/${encodeURIComponent(id)}/audio`,
  };
}

export function extractTakes(payload: unknown): RecordingTake[] {
  let candidates: unknown = payload;

  if (isRecord(payload)) {
    candidates = payload.takes;
    if (!Array.isArray(candidates) && isRecord(payload.data)) {
      candidates = payload.data.takes;
    }
    if (!Array.isArray(candidates) && Array.isArray(payload.data)) {
      candidates = payload.data;
    }
  }

  if (!Array.isArray(candidates)) return [];

  return candidates
    .map((item, index) => normalizeTake(item, index))
    .filter((take): take is RecordingTake => take !== null)
    .sort((a, b) => a.takeNo - b.takeNo);
}

export async function responseError(
  response: Response,
  fallback: string,
): Promise<Error> {
  const contentType = response.headers.get("content-type") ?? "";

  try {
    if (contentType.includes("application/json")) {
      const body: unknown = await response.json();
      if (isRecord(body)) {
        const message = asString(body.message ?? body.error);
        if (message) return new Error(message);
      }
    } else {
      const text = (await response.text()).trim();
      if (text && text.length < 240) return new Error(text);
    }
  } catch {
    // The fallback below is intentionally more useful than a secondary parse error.
  }

  return new Error(`${fallback} (${response.status})`);
}

export function formatDuration(milliseconds: number, tenths = false): string {
  const safeMs = Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : 0;
  const totalSeconds = Math.floor(safeMs / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const fraction = Math.floor((safeMs % 1_000) / 100);

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  const base = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return tenths ? `${base}.${fraction}` : base;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1_024 * 1_024) return `${Math.max(1, Math.round(bytes / 1_024))}KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)}MB`;
}

export function formatCreatedAt(value: string): string {
  if (!value) return "방금 전";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  return new Intl.DateTimeFormat("ko-KR", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

const RECORDER_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/mp4;codecs=mp4a.40.2",
  "audio/mp4",
  "audio/ogg;codecs=opus",
  "audio/webm",
] as const;

function supportedRecorderMimeTypes(): string[] {
  if (typeof MediaRecorder === "undefined") return [];
  if (typeof MediaRecorder.isTypeSupported !== "function") {
    // Older Safari builds can construct MediaRecorder while omitting the
    // feature-detection method. Constructor attempts below remain authoritative.
    return [...RECORDER_MIME_TYPES];
  }
  return RECORDER_MIME_TYPES.filter((type) => {
    try {
      return MediaRecorder.isTypeSupported(type);
    } catch {
      return false;
    }
  });
}

export function preferredRecorderMimeType(): string {
  return supportedRecorderMimeTypes()[0] ?? "";
}

/**
 * MediaRecorder support tables are not fully reliable (especially on Safari
 * and embedded browsers). Try progressively less-specific options before
 * declaring recording unavailable.
 */
export function createCompatibleMediaRecorder(stream: MediaStream): MediaRecorder {
  if (typeof MediaRecorder === "undefined") {
    throw new Error("이 브라우저에서는 오디오 녹음을 지원하지 않아요.");
  }

  let lastError: unknown;
  for (const mimeType of supportedRecorderMimeTypes()) {
    for (const options of [
      { mimeType, audioBitsPerSecond: 192_000 },
      { mimeType },
    ]) {
      try {
        return new MediaRecorder(stream, options);
      } catch (error) {
        lastError = error;
      }
    }
  }

  try {
    return new MediaRecorder(stream);
  } catch (error) {
    lastError = error;
  }

  throw new Error("이 브라우저에서 사용할 수 있는 녹음 형식을 찾지 못했어요.", {
    cause: lastError,
  });
}

export function nextCycleDeadline(
  now: number,
  previousDeadline: number,
  durationMs: number,
): number {
  const safeNow = Number.isFinite(now) ? now : 0;
  const safeDuration = Math.max(100, Number.isFinite(durationMs) ? durationMs : 100);
  if (!Number.isFinite(previousDeadline) || previousDeadline <= 0) {
    return safeNow + safeDuration;
  }

  const alignedDeadline = previousDeadline + safeDuration;
  // If the page was suspended for almost an entire loop, avoid creating a
  // tiny unusable take and establish a fresh cycle boundary instead.
  return alignedDeadline - safeNow < 100 ? safeNow + safeDuration : alignedDeadline;
}

export type TapTempoResetReason = "idle" | "outlier" | null;

export type TapTempoState = Readonly<{
  lastTapAtMs: number | null;
  intervalsMs: readonly number[];
}>;

export type TapTempoResult = Readonly<{
  state: TapTempoState;
  bpm: number | null;
  tapCount: number;
  resetReason: TapTempoResetReason;
}>;

const TAP_TEMPO_MIN_BPM = 30;
const TAP_TEMPO_MAX_BPM = 300;
const TAP_TEMPO_MIN_INTERVAL_MS = 60_000 / TAP_TEMPO_MAX_BPM;
const TAP_TEMPO_MAX_INTERVAL_MS = 60_000 / TAP_TEMPO_MIN_BPM;
const TAP_TEMPO_IDLE_RESET_MS = 2_500;
const TAP_TEMPO_OUTLIER_RATIO = 0.35;
const TAP_TEMPO_INTERVAL_WINDOW = 7;

export function createTapTempoState(): TapTempoState {
  return { lastTapAtMs: null, intervalsMs: [] };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/**
 * Adds one monotonic tap to a short rolling tempo measurement. Long pauses and
 * taps that are far from the established pulse start a fresh measurement so a
 * stray click cannot drag the saved BPM away from the player's intent.
 */
export function registerTapTempo(
  state: TapTempoState,
  tapAtMs: number,
): TapTempoResult {
  const startFresh = (resetReason: TapTempoResetReason): TapTempoResult => ({
    state: {
      lastTapAtMs: Number.isFinite(tapAtMs) ? tapAtMs : null,
      intervalsMs: [],
    },
    bpm: null,
    tapCount: Number.isFinite(tapAtMs) ? 1 : 0,
    resetReason,
  });

  if (!Number.isFinite(tapAtMs)) return startFresh("outlier");
  if (state.lastTapAtMs === null) return startFresh(null);

  const intervalMs = tapAtMs - state.lastTapAtMs;
  if (intervalMs > TAP_TEMPO_IDLE_RESET_MS) return startFresh("idle");
  if (
    intervalMs <= 0 ||
    intervalMs < TAP_TEMPO_MIN_INTERVAL_MS ||
    intervalMs > TAP_TEMPO_MAX_INTERVAL_MS
  ) {
    return startFresh("outlier");
  }

  if (state.intervalsMs.length > 0) {
    const establishedInterval = median(state.intervalsMs);
    const deviation = Math.abs(intervalMs - establishedInterval) / establishedInterval;
    if (deviation > TAP_TEMPO_OUTLIER_RATIO) return startFresh("outlier");
  }

  const intervalsMs = [...state.intervalsMs, intervalMs].slice(
    -TAP_TEMPO_INTERVAL_WINDOW,
  );
  const averageIntervalMs =
    intervalsMs.reduce((total, interval) => total + interval, 0) /
    intervalsMs.length;
  const bpm = Math.min(
    TAP_TEMPO_MAX_BPM,
    Math.max(TAP_TEMPO_MIN_BPM, Math.round(60_000 / averageIntervalMs)),
  );

  return {
    state: { lastTapAtMs: tapAtMs, intervalsMs },
    bpm,
    tapCount: intervalsMs.length + 1,
    resetReason: null,
  };
}

export function extensionForMimeType(mimeType: string): string {
  if (mimeType.includes("mp4")) return "m4a";
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("wav")) return "wav";
  return "webm";
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return Boolean(
    target.closest(
      "input, textarea, select, button, a, audio, video, summary, [contenteditable='true'], [role='button'], [role='slider'], [role='textbox'], [role='combobox'], [role='listbox'], [role='menuitem'], [data-recording-shortcut-ignore]",
    ),
  );
}
