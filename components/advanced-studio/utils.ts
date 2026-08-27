import {
  cleanMarkerLabel,
  isMarkerColor,
  MAX_MARKER_LABEL_LENGTH,
  MAX_MARKER_POSITION_MS,
  sortMarkers,
} from "@/lib/markers";
import { SUPPORTED_AUDIO_FILE_EXTENSIONS } from "@/lib/audio-file-format";

import type {
  CompDraftRow,
  MarkerPatch,
  StudioMarker,
  StudioTrack,
  TrackPatch,
} from "./types";

type UnknownRecord = Record<string, unknown>;

type ClientStringStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

type BrowserStorageHost = {
  readonly localStorage: Storage;
  readonly sessionStorage: Storage;
};

export const AUDIO_TRACK_IMPORT_ACCEPT = [
  "audio/*",
  ...SUPPORTED_AUDIO_FILE_EXTENSIONS.map((extension) => `.${extension}`),
].join(",");

export const AUDIO_TRACK_IMPORT_HELP =
  "MP3 · WAV · AIFF · M4A · AAC · FLAC · OGG/Opus · WebM, 파일당 95MB";

const CLIENT_CREATE_REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type CreateRequestOperation = {
  requestId: string;
  storageKey: string;
};

export type CompDraftStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
> & Partial<Pick<Storage, "key" | "length">>;

export type StoredCompDraft = {
  baseSignature: string;
  baseRevision: number | null;
  savedAtMs: number;
  rows: CompDraftRow[];
};

/** Browser storage getters can themselves throw when storage is blocked. */
export function getBrowserStorageOrNull(
  kind: "local" | "session",
  host: BrowserStorageHost | null =
    typeof window === "undefined" ? null : window,
): Storage | null {
  if (!host) return null;
  try {
    return kind === "local" ? host.localStorage : host.sessionStorage;
  } catch {
    return null;
  }
}

export function hasUndurableStudioChanges(input: {
  trackPatchCount: number;
  trackOutboxDurable: boolean;
  markerPatchCount: number;
  markerOutboxDurable: boolean;
  compDraftDurable: boolean;
}): boolean {
  return (
    (!input.trackOutboxDurable && input.trackPatchCount > 0) ||
    (!input.markerOutboxDurable && input.markerPatchCount > 0) ||
    !input.compDraftDurable
  );
}

/**
 * A punch timer closes the small React propagation gap after punch capture
 * starts; the parent capture flag covers preparation, recording, processing,
 * and upload for both normal and cycle recording.
 */
export function isStudioTransportInteractionLocked(
  captureInProgress: boolean,
  punchPlaybackScheduled: boolean,
): boolean {
  return captureInProgress || punchPlaybackScheduled;
}

export type StudioActionLock<T extends string> = {
  readonly pending: T | null;
  tryAcquire: (action: T) => boolean;
  release: (action: T) => boolean;
};

/** Serializes long-running studio actions independently of React render timing. */
export function createStudioActionLock<T extends string>(
  initial: T | null = null,
): StudioActionLock<T> {
  let pending = initial;
  return {
    get pending() {
      return pending;
    },
    tryAcquire(action) {
      if (pending !== null) return false;
      pending = action;
      return true;
    },
    release(action) {
      if (pending !== action) return false;
      pending = null;
      return true;
    },
  };
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function numberValue(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function booleanValue(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1" || value === "true") return true;
  if (value === 0 || value === "0" || value === "false") return false;
  return fallback;
}

export function createClientCreateRequestId(): string {
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

export function createRequestStorageKey(
  kind: "track" | "marker",
  riffId: string,
  intentFingerprint: string,
): string {
  return `riff-sketchbook:${kind}-create:${riffId}:${encodeURIComponent(intentFingerprint)}`;
}

export function getOrCreateCreateRequest(
  registry: Map<string, string>,
  storage: ClientStringStorage | null,
  kind: "track" | "marker",
  riffId: string,
  intentFingerprint: string,
  createId: () => string = createClientCreateRequestId,
): CreateRequestOperation {
  const storageKey = createRequestStorageKey(kind, riffId, intentFingerprint);
  const inMemory = registry.get(storageKey);
  if (inMemory && CLIENT_CREATE_REQUEST_ID_PATTERN.test(inMemory)) {
    return { requestId: inMemory, storageKey };
  }

  if (storage) {
    try {
      const stored = storage.getItem(storageKey);
      if (stored && CLIENT_CREATE_REQUEST_ID_PATTERN.test(stored)) {
        registry.set(storageKey, stored);
        return { requestId: stored, storageKey };
      }
      if (stored) storage.removeItem(storageKey);
    } catch {
      // The in-memory registry below still keeps immediate retries stable.
    }
  }

  const requestId = createId();
  registry.set(storageKey, requestId);
  if (storage) {
    try {
      storage.setItem(storageKey, requestId);
    } catch {
      // Session storage is best-effort; the active tab still reuses the ID.
    }
  }
  return { requestId, storageKey };
}

export function completeCreateRequest(
  registry: Map<string, string>,
  storage: ClientStringStorage | null,
  operation: CreateRequestOperation,
): void {
  if (registry.get(operation.storageKey) === operation.requestId) {
    registry.delete(operation.storageKey);
  }
  if (!storage) return;
  try {
    if (storage.getItem(operation.storageKey) === operation.requestId) {
      storage.removeItem(operation.storageKey);
    }
  } catch {
    // Server completion is independent from rotating the browser-side key.
  }
}

export async function audioFileContentDigest(
  file: Pick<File, "arrayBuffer"> & Partial<Pick<File, "size" | "stream">>,
): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  // Web Crypto has no incremental digest API. Keep its exact SHA-256 result
  // for small files, but do not allocate a second 95MB buffer for a large
  // backing track merely to derive a browser-side retry key.
  if (subtle && (file.size === undefined || file.size <= 8 * 1024 * 1024)) {
    const bytes = await file.arrayBuffer();
    const digest = new Uint8Array(await subtle.digest("SHA-256", bytes));
    return Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
  }

  // A deterministic fallback is only an intent-key aid. The API always
  // verifies the source with a cryptographic SHA-256 fingerprint.
  let first = 2_166_136_261;
  let second = 2_166_136_261 ^ 0x9e3779b9;
  const consume = (bytes: Uint8Array) => {
    for (const value of bytes) {
      first = Math.imul(first ^ value, 16_777_619);
      second = Math.imul(second ^ (value + 1), 16_777_619);
    }
  };
  if (file.stream) {
    const reader = file.stream().getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        consume(value);
      }
    } finally {
      reader.releaseLock();
    }
  } else {
    consume(new Uint8Array(await file.arrayBuffer()));
  }
  return `fallback-${(first >>> 0).toString(16).padStart(8, "0")}${(
    second >>> 0
  ).toString(16).padStart(8, "0")}`;
}

export function trackCreateIntentFingerprint(input: {
  kind: "guitar" | "backing";
  name: string;
  durationMs: number | null;
  fileName: string;
  mimeType: string;
  byteSize: number;
  contentDigest: string;
}): string {
  return stableFingerprint(input);
}

export function markerCreateIntentFingerprint(input: {
  positionMs: number;
  label: string;
  color: string;
}): string {
  return stableFingerprint(input);
}

export function persistRevisionedOutbox<K extends PropertyKey, P extends object>(
  storage: Pick<Storage, "setItem" | "removeItem"> | null,
  storageKey: string,
  entries: ReadonlyMap<K, RevisionedOutboxEntry<P>>,
): boolean {
  if (!storage) return false;
  try {
    if (entries.size === 0) {
      storage.removeItem(storageKey);
    } else {
      storage.setItem(storageKey, JSON.stringify(Object.fromEntries(entries)));
    }
    return true;
  } catch {
    return false;
  }
}

export function deferredPatchFailureMessage(
  entity: "트랙 설정" | "마커",
  error: unknown,
  persisted: boolean,
): string {
  const prefix = error instanceof Error ? error.message : `${entity}을 저장하지 못했어요.`;
  return persisted
    ? `${prefix} 변경 내용은 브라우저에 보관했으며 다시 연결되면 저장할게요.`
    : `${prefix} 변경 내용을 브라우저에 보관하지 못했어요. 이 화면을 닫지 말고 연결을 확인한 뒤 다시 시도해주세요.`;
}

export async function refreshCompAfterDurableConflictDraft<T>(
  persistDraft: () => boolean,
  refresh: () => Promise<T>,
): Promise<{ durable: false } | { durable: true; refreshed: T }> {
  if (!persistDraft()) return { durable: false };
  return { durable: true, refreshed: await refresh() };
}

export function normalizeTrack(value: unknown): StudioTrack | null {
  if (!isRecord(value)) return null;
  const id = stringValue(value.id);
  if (!id) return null;
  const rawKind = stringValue(value.kind);
  const duration = value.durationMs ?? value.duration_ms;
  return {
    id,
    riffId: stringValue(value.riffId ?? value.riff_id),
    kind: rawKind === "guitar" ? "guitar" : "backing",
    name: stringValue(value.name, rawKind === "guitar" ? "Guitar Track" : "Backing Track"),
    durationMs: duration === null || duration === undefined ? null : Math.max(0, numberValue(duration)),
    offsetMs: Math.max(0, numberValue(value.offsetMs ?? value.offset_ms)),
    volume: Math.min(2, Math.max(0, numberValue(value.volume, 1))),
    pan: Math.min(1, Math.max(-1, numberValue(value.pan))),
    muted: booleanValue(value.muted),
    solo: booleanValue(value.solo),
    fadeInMs: Math.max(0, numberValue(value.fadeInMs ?? value.fade_in_ms)),
    fadeOutMs: Math.max(0, numberValue(value.fadeOutMs ?? value.fade_out_ms)),
    revision: Math.max(0, Math.round(numberValue(value.revision))),
    clientRequestId:
      typeof (value.clientRequestId ?? value.client_request_id) === "string"
        ? stringValue(value.clientRequestId ?? value.client_request_id)
        : null,
    audioUrl:
      stringValue(value.audioUrl ?? value.audio_url) ||
      `/api/tracks/${encodeURIComponent(id)}/audio`,
  };
}

export function sanitizeTrackPatch(value: unknown): TrackPatch | null {
  if (!isRecord(value)) return null;
  const patch: TrackPatch = {};
  const name = stringValue(value.name).trim();
  if (name) patch.name = name.slice(0, 120);
  if (typeof value.offsetMs === "number" && Number.isFinite(value.offsetMs)) {
    patch.offsetMs = Math.max(0, Math.round(value.offsetMs));
  }
  if (typeof value.volume === "number" && Number.isFinite(value.volume)) {
    patch.volume = Math.min(2, Math.max(0, value.volume));
  }
  if (typeof value.pan === "number" && Number.isFinite(value.pan)) {
    patch.pan = Math.min(1, Math.max(-1, value.pan));
  }
  if (typeof value.muted === "boolean") patch.muted = value.muted;
  if (typeof value.solo === "boolean") patch.solo = value.solo;
  if (typeof value.fadeInMs === "number" && Number.isFinite(value.fadeInMs)) {
    patch.fadeInMs = Math.max(0, Math.round(value.fadeInMs));
  }
  if (typeof value.fadeOutMs === "number" && Number.isFinite(value.fadeOutMs)) {
    patch.fadeOutMs = Math.max(0, Math.round(value.fadeOutMs));
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

export function extractTracks(payload: unknown): StudioTrack[] {
  const candidates = isRecord(payload) ? payload.tracks : payload;
  if (!Array.isArray(candidates)) return [];
  return candidates
    .map(normalizeTrack)
    .filter((track): track is StudioTrack => track !== null);
}

export function normalizeMarker(value: unknown): StudioMarker | null {
  if (!isRecord(value)) return null;
  const id = stringValue(value.id);
  const riffId = stringValue(value.riffId ?? value.riff_id);
  const label = cleanMarkerLabel(stringValue(value.label));
  const color = value.color;
  if (
    !id ||
    !riffId ||
    !label ||
    label.length > MAX_MARKER_LABEL_LENGTH ||
    !isMarkerColor(color)
  ) {
    return null;
  }
  return {
    id,
    riffId,
    positionMs: Math.min(
      MAX_MARKER_POSITION_MS,
      Math.max(0, Math.round(numberValue(value.positionMs ?? value.position_ms))),
    ),
    label,
    color,
    sortOrder: Math.max(0, Math.round(numberValue(value.sortOrder ?? value.sort_order))),
    revision: Math.max(0, Math.round(numberValue(value.revision))),
    clientRequestId:
      typeof (value.clientRequestId ?? value.client_request_id) === "string"
        ? stringValue(value.clientRequestId ?? value.client_request_id)
        : null,
    createdAt: stringValue(value.createdAt ?? value.created_at),
    updatedAt: stringValue(value.updatedAt ?? value.updated_at),
  };
}

export function extractMarkers(payload: unknown): StudioMarker[] {
  const candidates = isRecord(payload) ? payload.markers : payload;
  if (!Array.isArray(candidates)) return [];
  return sortMarkers(
    candidates
      .map(normalizeMarker)
      .filter((marker): marker is StudioMarker => marker !== null),
  );
}

export function sanitizeMarkerPatch(value: unknown): MarkerPatch | null {
  if (!isRecord(value)) return null;
  const patch: MarkerPatch = {};
  if (typeof value.positionMs === "number" && Number.isFinite(value.positionMs)) {
    patch.positionMs = Math.min(
      MAX_MARKER_POSITION_MS,
      Math.max(0, Math.round(value.positionMs)),
    );
  }
  if (typeof value.label === "string") {
    const label = cleanMarkerLabel(value.label);
    if (
      label &&
      label.length <= MAX_MARKER_LABEL_LENGTH &&
      !/[\u0000-\u001f\u007f]/.test(label)
    ) {
      patch.label = label;
    }
  }
  if (isMarkerColor(value.color)) patch.color = value.color;
  return Object.keys(patch).length > 0 ? patch : null;
}

export function normalizeCompRows(payload: unknown): CompDraftRow[] {
  const candidates = isRecord(payload) ? payload.segments : payload;
  if (!Array.isArray(candidates)) return [];
  return candidates.flatMap((value, index) => {
    if (!isRecord(value)) return [];
    const takeId = stringValue(value.takeId ?? value.take_id);
    const id = stringValue(value.id);
    const startMs = Math.max(0, Math.round(numberValue(value.startMs ?? value.start_ms)));
    const endMs = Math.max(0, Math.round(numberValue(value.endMs ?? value.end_ms)));
    if (!takeId || endMs <= startMs) return [];
    return [{ clientId: id || `loaded-${index}-${takeId}`, id: id || undefined, takeId, startMs, endMs }];
  });
}

export function ownerScopedOutboxKey(baseKey: string, ownerId: string): string {
  return `${baseKey}:owner:${ownerId}`;
}

export function listOwnerScopedOutboxKeys(
  storage: CompDraftStorage | null,
  baseKey: string,
): string[] {
  if (!storage || typeof storage.length !== "number" || typeof storage.key !== "function") {
    return [];
  }
  const prefix = `${baseKey}:owner:`;
  const keys: string[] = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(prefix)) keys.push(key);
    }
  } catch {
    return [];
  }
  return [...new Set(keys)].sort((left, right) => left.localeCompare(right));
}

export type OutboxSnapshotDescriptor = {
  sourceKey: string;
  entryId: string | null;
  fingerprint: string;
};

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort((left, right) => left.localeCompare(right))
        .map((key) => [key, stableJsonValue(value[key])]),
    );
  }
  return value;
}

function stableFingerprint(value: unknown): string {
  return JSON.stringify(stableJsonValue(value));
}

function fingerprintHash(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}

function discardedSnapshotPrefix(baseKey: string): string {
  return `${baseKey}:discarded-snapshot:`;
}

function listDiscardedSnapshotKeys(
  storage: CompDraftStorage,
  baseKey: string,
): string[] {
  if (typeof storage.length !== "number" || typeof storage.key !== "function") return [];
  const prefix = discardedSnapshotPrefix(baseKey);
  const keys: string[] = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(prefix)) keys.push(key);
    }
  } catch {
    return [];
  }
  return keys;
}

function parseSnapshotDescriptor(raw: string | null): OutboxSnapshotDescriptor | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      !isRecord(value) ||
      typeof value.sourceKey !== "string" ||
      (value.entryId !== null && typeof value.entryId !== "string") ||
      typeof value.fingerprint !== "string"
    ) {
      return null;
    }
    return {
      sourceKey: value.sourceKey,
      entryId: value.entryId,
      fingerprint: value.fingerprint,
    };
  } catch {
    return null;
  }
}

export function suppressOutboxSnapshots(
  storage: CompDraftStorage | null,
  baseKey: string,
  snapshots: readonly OutboxSnapshotDescriptor[],
): number {
  if (!storage) return 0;
  let ensured = 0;
  for (const snapshot of snapshots) {
    const serialized = JSON.stringify(snapshot);
    const token = stableFingerprint(snapshot);
    const stem = `${discardedSnapshotPrefix(baseKey)}${fingerprintHash(token)}`;
    for (let collision = 0; collision < 32; collision += 1) {
      const key = collision === 0 ? stem : `${stem}:${collision}`;
      try {
        const existing = storage.getItem(key);
        if (existing === serialized) {
          ensured += 1;
          break;
        }
        if (existing !== null) continue;
        storage.setItem(key, serialized);
        ensured += 1;
        break;
      } catch {
        break;
      }
    }
  }
  return ensured;
}

export function isOutboxSnapshotSuppressed(
  storage: CompDraftStorage | null,
  baseKey: string,
  snapshot: OutboxSnapshotDescriptor,
): boolean {
  if (!storage) return false;
  for (const key of listDiscardedSnapshotKeys(storage, baseKey)) {
    try {
      const discarded = parseSnapshotDescriptor(storage.getItem(key));
      if (
        discarded?.sourceKey === snapshot.sourceKey &&
        discarded.entryId === snapshot.entryId &&
        discarded.fingerprint === snapshot.fingerprint
      ) {
        return true;
      }
    } catch {
      // An unreadable tombstone cannot justify suppressing recoverable data.
    }
  }
  return false;
}

export function revisionedOutboxFingerprint<P extends object>(
  entry: RevisionedOutboxEntry<P>,
): string {
  const generation = normalizeOutboxGeneration(entry.generation);
  return stableFingerprint(
    generation === 0
      ? {
          // Preserve the pre-generation fingerprint exactly so an explicit
          // discard recorded by an older build continues to suppress its
          // generationless source entry after upgrading.
          baseRevision: entry.baseRevision,
          patch: entry.patch,
        }
      : {
          baseRevision: entry.baseRevision,
          generation,
          patch: entry.patch,
        },
  );
}

export type RevisionedOutboxEntry<P extends object> = {
  baseRevision: number | null;
  /**
   * Monotonic per owner/entity write generation. Older stored entries omit it
   * and are treated as generation zero.
   */
  generation?: number;
  patch: P;
};

export function normalizeOutboxGeneration(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

export function nextOutboxGeneration(
  lastKnownGeneration: unknown,
  entryGeneration?: unknown,
): number {
  return Math.max(
    normalizeOutboxGeneration(lastKnownGeneration),
    normalizeOutboxGeneration(entryGeneration),
  ) + 1;
}

export function mergeOwnerOutboxEntries<K, P extends object>(
  currentMemory: ReadonlyMap<K, RevisionedOutboxEntry<P>>,
  currentOwner: ReadonlyMap<K, RevisionedOutboxEntry<P>>,
  previousOwner: ReadonlyMap<K, RevisionedOutboxEntry<P>>,
  legacy: ReadonlyMap<K, RevisionedOutboxEntry<P>>,
  additionalOwners: readonly ReadonlyMap<K, RevisionedOutboxEntry<P>>[] = [],
): {
  entries: Map<K, RevisionedOutboxEntry<P>>;
  shouldPersistToCurrentOwner: boolean;
} {
  const shouldPersistToCurrentOwner =
    previousOwner.size > 0 ||
    legacy.size > 0 ||
    additionalOwners.some((owner) => owner.size > 0);
  const entries = new Map<K, RevisionedOutboxEntry<P>>();
  for (const source of [
    currentMemory,
    currentOwner,
    previousOwner,
    ...additionalOwners,
    legacy,
  ]) {
    for (const [key, value] of source) {
      const preferred = entries.get(key);
      if (!preferred) {
        entries.set(key, {
          baseRevision: value.baseRevision,
          generation: normalizeOutboxGeneration(value.generation),
          patch: { ...value.patch },
        });
        continue;
      }
      const hasOverlappingConflict = Object.entries(preferred.patch).some(
        ([field, preferredValue]) =>
          Object.prototype.hasOwnProperty.call(value.patch, field) &&
          (value.patch as Record<string, unknown>)[field] !== preferredValue,
      );
      entries.set(key, {
        baseRevision:
          !hasOverlappingConflict && preferred.baseRevision === value.baseRevision
            ? preferred.baseRevision
            : null,
        generation: Math.max(
          normalizeOutboxGeneration(preferred.generation),
          normalizeOutboxGeneration(value.generation),
        ),
        // Earlier sources have higher precedence, while lower-priority tabs
        // still contribute non-overlapping mixer or marker fields.
        patch: { ...value.patch, ...preferred.patch },
      });
    }
  }
  if (shouldPersistToCurrentOwner) {
    // Copying/migrating is itself a write to the current owner. Give that
    // source a fresh identity even when its merged values equal a previously
    // discarded snapshot at the same key.
    for (const [key, entry] of entries) {
      entries.set(key, {
        ...entry,
        generation: nextOutboxGeneration(entry.generation),
      });
    }
  }
  return {
    entries,
    shouldPersistToCurrentOwner,
  };
}

/** Treats the captured object identity as a generation token for an outbox entry. */
export function isSameOutboxGeneration<T>(
  capturedEntry: T | undefined,
  currentEntry: T | undefined,
): boolean {
  return capturedEntry === currentEntry;
}

export function compRowsSignature(rows: readonly CompDraftRow[]): string {
  return JSON.stringify(rows.map(({ takeId, startMs, endMs }) => ({
    takeId,
    startMs,
    endMs,
  })));
}

function parseStoredCompDraft(raw: string | null): StoredCompDraft | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || typeof parsed.baseSignature !== "string" || !Array.isArray(parsed.rows)) {
      return null;
    }
    return {
      baseSignature: parsed.baseSignature,
      baseRevision:
        typeof parsed.baseRevision === "number" &&
        Number.isInteger(parsed.baseRevision) &&
        parsed.baseRevision >= 0
          ? parsed.baseRevision
          : null,
      savedAtMs:
        typeof parsed.savedAtMs === "number" && Number.isFinite(parsed.savedAtMs)
          ? Math.max(0, parsed.savedAtMs)
          : 0,
      rows: normalizeCompRows({ segments: parsed.rows }),
    };
  } catch {
    return null;
  }
}

export function compDraftSnapshotFingerprint(draft: StoredCompDraft): string {
  return stableFingerprint({
    baseSignature: draft.baseSignature,
    baseRevision: draft.baseRevision,
    savedAtMs: draft.savedAtMs,
    rows: draft.rows.map(({ takeId, startMs, endMs }) => ({ takeId, startMs, endMs })),
  });
}

export function persistCompDraftOutbox(
  storage: CompDraftStorage | null,
  storageKey: string,
  draft: StoredCompDraft,
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(storageKey, JSON.stringify({
      baseSignature: draft.baseSignature,
      baseRevision: draft.baseRevision,
      savedAtMs: draft.savedAtMs,
      rows: draft.rows.map(({ takeId, startMs, endMs }) => ({ takeId, startMs, endMs })),
    }));
    return true;
  } catch {
    return false;
  }
}

export function readCompDraftOutbox(
  storage: CompDraftStorage | null,
  legacyStorageKey: string,
  currentOwnerStorageKey: string,
  previousOwnerStorageKey: string | null,
): StoredCompDraft | null {
  if (!storage) return null;
  let owned: StoredCompDraft | null;
  let previous: StoredCompDraft | null;
  let legacy: StoredCompDraft | null;
  let orphaned: Array<{ key: string; draft: StoredCompDraft }>;
  try {
    const readVisibleDraft = (key: string): StoredCompDraft | null => {
      const draft = parseStoredCompDraft(storage.getItem(key));
      if (!draft) return null;
      return isOutboxSnapshotSuppressed(storage, legacyStorageKey, {
        sourceKey: key,
        entryId: null,
        fingerprint: compDraftSnapshotFingerprint(draft),
      })
        ? null
        : draft;
    };
    owned = readVisibleDraft(currentOwnerStorageKey);
    previous = previousOwnerStorageKey
      ? readVisibleDraft(previousOwnerStorageKey)
      : null;
    legacy = readVisibleDraft(legacyStorageKey);
    const excludedKeys = new Set([
      currentOwnerStorageKey,
      ...(previousOwnerStorageKey ? [previousOwnerStorageKey] : []),
    ]);
    orphaned = listOwnerScopedOutboxKeys(storage, legacyStorageKey)
      .filter((key) => !excludedKeys.has(key))
      .flatMap((key) => {
        const draft = readVisibleDraft(key);
        return draft ? [{ key, draft }] : [];
      })
      .sort((left, right) =>
        right.draft.savedAtMs - left.draft.savedAtMs ||
        left.key.localeCompare(right.key),
      );
  } catch {
    return null;
  }

  const fallbackDrafts = [
    ...orphaned,
    ...(legacy ? [{ key: legacyStorageKey, draft: legacy }] : []),
  ].sort((left, right) =>
    right.draft.savedAtMs - left.draft.savedAtMs ||
    left.key.localeCompare(right.key),
  );
  const selected = owned ?? previous ?? fallbackDrafts[0]?.draft ?? null;
  if (!selected) return null;

  // A duplicated tab may still share `previous` with its live source tab.
  // Copy that draft to the new owner, but never steal/delete the source key.
  if (!owned && persistCompDraftOutbox(storage, currentOwnerStorageKey, selected)) {
    if (legacy === selected) {
      suppressOutboxSnapshots(storage, legacyStorageKey, [{
        sourceKey: legacyStorageKey,
        entryId: null,
        fingerprint: compDraftSnapshotFingerprint(legacy),
      }]);
    }
  }
  return selected;
}

export function suppressCompDraftCopies(
  storage: CompDraftStorage | null,
  legacyStorageKey: string,
  targetDraft: StoredCompDraft,
): boolean {
  if (!storage) return false;
  const targetFingerprint = compDraftSnapshotFingerprint(targetDraft);
  const sourceKeys = [
    legacyStorageKey,
    ...listOwnerScopedOutboxKeys(storage, legacyStorageKey),
  ];
  const snapshots: OutboxSnapshotDescriptor[] = [];
  for (const sourceKey of sourceKeys) {
    try {
      const stored = parseStoredCompDraft(storage.getItem(sourceKey));
      if (!stored || compDraftSnapshotFingerprint(stored) !== targetFingerprint) continue;
      snapshots.push({ sourceKey, entryId: null, fingerprint: targetFingerprint });
    } catch {
      // A source that cannot be proven identical must remain recoverable.
    }
  }
  return suppressOutboxSnapshots(storage, legacyStorageKey, snapshots) === snapshots.length;
}

export function clearAppliedCompDraftOutboxes(
  storage: CompDraftStorage | null,
  legacyStorageKey: string,
  serverRows: readonly CompDraftRow[],
  knownOwnerStorageKeys: readonly (string | null)[] = [],
): number {
  if (!storage) return 0;
  const ownerPrefix = `${legacyStorageKey}:owner:`;
  const candidates = new Set<string>([legacyStorageKey]);
  for (const key of knownOwnerStorageKeys) {
    if (key) candidates.add(key);
  }
  try {
    if (typeof storage.length === "number" && typeof storage.key === "function") {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key?.startsWith(ownerPrefix)) candidates.add(key);
      }
    }
  } catch {
    // Known current and previous keys can still be checked below.
  }

  const snapshots: OutboxSnapshotDescriptor[] = [];
  for (const key of candidates) {
    try {
      const draft = parseStoredCompDraft(storage.getItem(key));
      if (!draft || !isCompDraftAlreadyApplied(draft.rows, serverRows)) continue;
      snapshots.push({
        sourceKey: key,
        entryId: null,
        fingerprint: compDraftSnapshotFingerprint(draft),
      });
    } catch {
      // Cleanup is best-effort; an unmatched or unreadable draft stays intact.
    }
  }
  return suppressOutboxSnapshots(storage, legacyStorageKey, snapshots);
}

export function isCompDraftAlreadyApplied(
  draftRows: readonly CompDraftRow[],
  serverRows: readonly CompDraftRow[],
): boolean {
  return compRowsSignature(draftRows) === compRowsSignature(serverRows);
}

export function shouldAcknowledgeCompSave(
  requestedRows: readonly CompDraftRow[],
  currentRows: readonly CompDraftRow[],
  requestedGeneration: number,
  currentGeneration: number,
): boolean {
  return requestedGeneration === currentGeneration &&
    compRowsSignature(requestedRows) === compRowsSignature(currentRows);
}

export function canMutateCompDraft(hydrated: boolean): boolean {
  return hydrated;
}

export function canApplyRevisionedList<T extends { id: string; revision: number }>(
  requestGeneration: number,
  currentGeneration: number,
  requestSerial: number,
  latestAcceptedSerial: number,
  incoming: readonly T[],
  minimumRevisions: ReadonlyMap<string, number>,
): boolean {
  return requestGeneration === currentGeneration &&
    requestSerial > latestAcceptedSerial &&
    incoming.every((entity) => (
      entity.revision >= (minimumRevisions.get(entity.id) ?? 0)
    ));
}

export async function responseError(response: Response, fallback: string): Promise<Error> {
  try {
    const body: unknown = await response.json();
    if (isRecord(body)) {
      const message = stringValue(body.message ?? body.error);
      if (message) return new Error(message);
    }
  } catch {
    // Use the contextual fallback below.
  }
  return new Error(`${fallback} (${response.status})`);
}

export function formatTime(milliseconds: number): string {
  const seconds = Math.max(0, milliseconds) / 1_000;
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${(seconds % 60).toFixed(1).padStart(4, "0")}`;
}

export function secondsToMs(value: string, fallback = 0): number {
  const seconds = Number(value);
  return Number.isFinite(seconds) ? Math.max(0, Math.round(seconds * 1_000)) : fallback;
}

export function trackKindLabel(kind: StudioTrack["kind"]): string {
  return kind === "guitar" ? "기타" : "반주";
}
