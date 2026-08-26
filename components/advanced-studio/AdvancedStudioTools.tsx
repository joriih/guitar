"use client";

import {
  AudioLines,
  ChevronDown,
  ChevronUp,
  Download,
  Flag,
  Guitar,
  Layers3,
  LoaderCircle,
  Pause,
  Play,
  Plus,
  Save,
  Scissors,
  SlidersHorizontal,
  Square,
  Trash2,
  Upload,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  AudioTimelineEngine,
  AudioDecodeCache,
  GuitarTuner,
  WaveformCanvas,
  buildCompTimeline,
  encodePcmWav,
  mixdownAndDownload,
  renderSelectedTake,
  type CompAudioSegment,
  type TimelinePlaybackSnapshot,
  type TimelineTrack,
  type TimelineTrackSource,
} from "@/components/audio-engine";
import {
  cleanMarkerLabel,
  MARKER_COLORS,
  MAX_MARKER_LABEL_LENGTH,
  MAX_MARKER_POSITION_MS,
  MAX_MARKERS_PER_RIFF,
  markerPositionPercent,
  reconcileMarkerPatch,
  sortMarkers,
  type MarkerColor,
} from "@/lib/markers";
import { preflightAudioFile } from "@/lib/audio-file-format";
import {
  conflictCurrent,
  deletionAlreadyApplied,
  mutationAlreadyApplied,
  nonnegativeRevision,
} from "@/lib/mutation-reconciliation";

import styles from "./AdvancedStudioTools.module.css";
import type {
  AdvancedStudioTake,
  AdvancedStudioRecordingTransport,
  AdvancedStudioToolsProps,
  CompDraftRow,
  MarkerPatch,
  PunchRequest,
  StudioMarker,
  StudioTrack,
  TrackPatch,
} from "./types";
import {
  AUDIO_TRACK_IMPORT_ACCEPT,
  AUDIO_TRACK_IMPORT_HELP,
  audioFileContentDigest,
  canApplyRevisionedList,
  canMutateCompDraft,
  clearAppliedCompDraftOutboxes,
  completeCreateRequest,
  createStudioActionLock,
  deferredPatchFailureMessage,
  extractTracks,
  extractMarkers,
  formatTime,
  compRowsSignature,
  getBrowserStorageOrNull as browserStorage,
  hasUndurableStudioChanges,
  isCompDraftAlreadyApplied,
  isOutboxSnapshotSuppressed,
  isSameOutboxGeneration,
  isStudioTransportInteractionLocked,
  getOrCreateCreateRequest,
  markerCreateIntentFingerprint,
  mergeOwnerOutboxEntries,
  nextOutboxGeneration,
  normalizeCompRows,
  normalizeOutboxGeneration,
  normalizeTrack,
  normalizeMarker,
  ownerScopedOutboxKey,
  listOwnerScopedOutboxKeys,
  persistCompDraftOutbox,
  persistRevisionedOutbox,
  readCompDraftOutbox,
  refreshCompAfterDurableConflictDraft,
  revisionedOutboxFingerprint,
  responseError,
  sanitizeTrackPatch,
  sanitizeMarkerPatch,
  secondsToMs,
  shouldAcknowledgeCompSave,
  suppressCompDraftCopies,
  suppressOutboxSnapshots,
  trackCreateIntentFingerprint,
  trackKindLabel,
  type StoredCompDraft,
} from "./utils";

type SourceMode = "take" | "comp";
type BusyAction = "tracks" | "upload" | "promote" | "comp" | "preview" | "export" | "punch" | null;
type LockedBusyAction = Exclude<BusyAction, null>;

const MARKER_COLOR_LABELS: Record<MarkerColor, string> = {
  rose: "로즈",
  amber: "앰버",
  lime: "라임",
  sky: "스카이",
  violet: "바이올렛",
  slate: "슬레이트",
};

type MarkerOutboxEntry = {
  baseRevision: number | null;
  generation?: number;
  patch: MarkerPatch;
};

type TrackOutboxEntry = {
  baseRevision: number | null;
  generation?: number;
  patch: TrackPatch;
};

type MarkerInputDraft = {
  label?: string;
  position?: string;
};

type CompDraftStatus = "saved" | "unsaved" | "conflict";

const IDLE_PLAYBACK: TimelinePlaybackSnapshot = {
  state: "idle",
  currentTime: 0,
  duration: 0,
};

const OUTBOX_OWNER_SESSION_KEY = "riff-sketchbook:advanced-outbox-owner";
const MAX_LIST_REFRESH_ATTEMPTS = 3;

function newClientId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `segment-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function claimBrowserOutboxOwner(scope: string): {
  ownerId: string;
  previousOwnerId: string | null;
} {
  // Rotate on every mounted editor so duplicated tabs cannot share an owner
  // even when the browser cloned sessionStorage. The previous token lets a
  // reload adopt its own unsent entries without touching another tab's key.
  const ownerId = newClientId();
  const sessionKey = `${OUTBOX_OWNER_SESSION_KEY}:${scope}`;
  try {
    const storage = browserStorage("session");
    if (!storage) return { ownerId, previousOwnerId: null };
    const previousOwnerId = storage.getItem(sessionKey);
    storage.setItem(sessionKey, ownerId);
    return { ownerId, previousOwnerId };
  } catch {
    return { ownerId, previousOwnerId: null };
  }
}

function takeDuration(take: AdvancedStudioTake | undefined): number {
  if (!take) return 0;
  return Math.max(0, take.trimEndMs ?? take.durationMs ?? 0);
}

function parseBeatsPerBar(timeSignature: string): number {
  const numerator = Number(timeSignature.split("/", 1)[0]);
  return Number.isInteger(numerator) && numerator > 0 ? Math.min(32, numerator) : 4;
}

function compValidationError(
  rows: readonly CompDraftRow[],
  takes: readonly AdvancedStudioTake[],
): string | null {
  for (const [index, row] of rows.entries()) {
    const take = takes.find((item) => item.id === row.takeId);
    if (!take) return `${index + 1}번 Comp 구간의 테이크를 다시 선택해주세요.`;
    if (row.startMs < 0 || row.endMs <= row.startMs) {
      return `${index + 1}번 Comp 구간의 시작·끝 시간을 확인해주세요.`;
    }
    if (take.durationMs !== null && row.endMs > take.durationMs) {
      return `${index + 1}번 Comp 구간이 ${take.name}의 녹음 길이를 벗어났어요.`;
    }
  }
  return null;
}

function readStoredTrackPatches(storageKey: string): Map<string, TrackOutboxEntry> {
  try {
    const raw = browserStorage("local")?.getItem(storageKey);
    if (!raw) return new Map();
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return new Map();
    }
    return new Map(
      Object.entries(parsed as Record<string, unknown>).flatMap(([trackId, value]) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        const record = value as Record<string, unknown>;
        const patch = sanitizeTrackPatch(record.patch) ?? sanitizeTrackPatch(value);
        const baseRevision = nonnegativeRevision(record.baseRevision);
        const generation = normalizeOutboxGeneration(record.generation);
        return trackId && patch
          ? [[trackId, { baseRevision, generation, patch }] as const]
          : [];
      }),
    );
  } catch {
    return new Map();
  }
}

function readRecoverableTrackPatches(
  storageKey: string,
  baseKey: string,
): Map<string, TrackOutboxEntry> {
  const entries = readStoredTrackPatches(storageKey);
  for (const [trackId, entry] of entries) {
    if (isOutboxSnapshotSuppressed(browserStorage("local"), baseKey, {
      sourceKey: storageKey,
      entryId: trackId,
      fingerprint: revisionedOutboxFingerprint(entry),
    })) {
      entries.delete(trackId);
    }
  }
  return entries;
}

function readStoredMarkerPatches(storageKey: string): Map<string, MarkerOutboxEntry> {
  try {
    const raw = browserStorage("local")?.getItem(storageKey);
    if (!raw) return new Map();
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return new Map();
    }
    return new Map(
      Object.entries(parsed as Record<string, unknown>).flatMap(([markerId, value]) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        const record = value as Record<string, unknown>;
        const nestedPatch = sanitizeMarkerPatch(record.patch);
        const legacyPatch = sanitizeMarkerPatch(value);
        const patch = nestedPatch ?? legacyPatch;
        const rawRevision = record.baseRevision;
        const baseRevision =
          typeof rawRevision === "number" && Number.isInteger(rawRevision) && rawRevision >= 0
            ? rawRevision
            : null;
        const generation = normalizeOutboxGeneration(record.generation);
        return markerId && patch
          ? [[markerId, { baseRevision, generation, patch }] as const]
          : [];
      }),
    );
  } catch {
    return new Map();
  }
}

function readRecoverableMarkerPatches(
  storageKey: string,
  baseKey: string,
): Map<string, MarkerOutboxEntry> {
  const entries = readStoredMarkerPatches(storageKey);
  for (const [markerId, entry] of entries) {
    if (isOutboxSnapshotSuppressed(browserStorage("local"), baseKey, {
      sourceKey: storageKey,
      entryId: markerId,
      fingerprint: revisionedOutboxFingerprint(entry),
    })) {
      entries.delete(markerId);
    }
  }
  return entries;
}

function normalizeCompPayload(payload: unknown): {
  rows: CompDraftRow[];
  revision: number | null;
} {
  const record =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null;
  const rawRevision = record?.revision;
  return {
    rows: normalizeCompRows(payload),
    revision:
      typeof rawRevision === "number" &&
      Number.isInteger(rawRevision) &&
      rawRevision >= 0
        ? rawRevision
        : null,
  };
}

export function AdvancedStudioTools({
  riffId,
  takes,
  bpm,
  timeSignature,
  sharedStream = null,
  captureInProgress = false,
  onPunchRequest,
  youtubeTransport = null,
  onRecordingTransportReady,
  className,
}: AdvancedStudioToolsProps) {
  const sectionId = useId();
  const fileInputId = useId();
  const engineRef = useRef<AudioTimelineEngine | null>(null);
  const decodeCacheRef = useRef<AudioDecodeCache | null>(null);
  const loadAbortRef = useRef<AbortController | null>(null);
  const patchTimersRef = useRef(new Map<string, number>());
  const patchQueueRef = useRef(new Map<string, TrackPatch>());
  const dirtyPatchesRef = useRef(new Map<string, TrackOutboxEntry>());
  const trackOutboxGenerationsRef = useRef(new Map<string, number>());
  const patchInFlightRef = useRef(new Set<string>());
  const trackConfirmedRevisionsRef = useRef(new Map<string, number>());
  const trackConflictIdsRef = useRef(new Set<string>());
  const trackConflictCurrentRef = useRef(new Map<string, StudioTrack>());
  const trackResolutionIdsRef = useRef(new Set<string>());
  const trackKnowledgeGenerationRef = useRef(0);
  const trackListRequestSerialRef = useRef(0);
  const trackListAcceptedSerialRef = useRef(0);
  const patchPersistenceTimerRef = useRef<number | null>(null);
  const markerPatchTimersRef = useRef(new Map<string, number>());
  const markerPatchQueueRef = useRef(new Map<string, MarkerPatch>());
  const dirtyMarkerPatchesRef = useRef(new Map<string, MarkerOutboxEntry>());
  const markerOutboxGenerationsRef = useRef(new Map<string, number>());
  const markerPatchInFlightRef = useRef(new Set<string>());
  const markerConfirmedRevisionsRef = useRef(new Map<string, number>());
  const markerConflictIdsRef = useRef(new Set<string>());
  const markersRef = useRef<StudioMarker[]>([]);
  const markerPersistenceTimerRef = useRef<number | null>(null);
  const deletedMarkerIdsRef = useRef(new Set<string>());
  const markerKnowledgeGenerationRef = useRef(0);
  const markerListRequestSerialRef = useRef(0);
  const markerListAcceptedSerialRef = useRef(0);
  const compBaselineRef = useRef("");
  const compRevisionRef = useRef<number | null>(null);
  const compRowsRef = useRef<CompDraftRow[]>([]);
  const compEditGenerationRef = useRef(0);
  const createRequestRegistryRef = useRef(new Map<string, string>());
  const trackOutboxDurableRef = useRef(true);
  const markerOutboxDurableRef = useRef(true);
  const compDraftDurableRef = useRef(true);
  const punchPlaybackTimerRef = useRef<number | null>(null);
  const studioActionLockRef = useRef(
    createStudioActionLock<LockedBusyAction>("tracks"),
  );
  const mountedRef = useRef(true);
  const outboxOwnerIdRef = useRef<string | null>(null);
  const outboxOwnerScopeRef = useRef<string | null>(null);
  const previousOutboxOwnerIdRef = useRef<string | null>(null);

  const [tracks, setTracks] = useState<StudioTrack[]>([]);
  const [trackConflictIds, setTrackConflictIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [trackResolutionIds, setTrackResolutionIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [markers, setMarkers] = useState<StudioMarker[]>([]);
  const [markerConflictIds, setMarkerConflictIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [markerInputDrafts, setMarkerInputDrafts] = useState<
    Record<string, MarkerInputDraft>
  >({});
  const [compRows, setCompRows] = useState<CompDraftRow[]>([]);
  const [hydratedCompRiffId, setHydratedCompRiffId] = useState<string | null>(null);
  const [pendingCompDraft, setPendingCompDraft] = useState<StoredCompDraft | null>(null);
  const [compDraftStatus, setCompDraftStatus] = useState<CompDraftStatus>("saved");
  const [selectedTakeId, setSelectedTakeId] = useState<string>(
    takes.find((take) => take.isPrimary)?.id ?? takes[0]?.id ?? "",
  );
  const [sourceMode, setSourceMode] = useState<SourceMode>("take");
  const [uploadKind, setUploadKind] = useState<StudioTrack["kind"]>("backing");
  const [playback, setPlayback] = useState<TimelinePlaybackSnapshot>(IDLE_PLAYBACK);
  const [playheadSeconds, setPlayheadSeconds] = useState(0);
  const [previewBuffer, setPreviewBuffer] = useState<AudioBuffer | null>(null);
  const [busy, setBusy] = useState<BusyAction>("tracks");
  const [punchPlaybackActive, setPunchPlaybackActive] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [markerBusy, setMarkerBusy] = useState<string | null>(null);
  const [punchStart, setPunchStart] = useState("0");
  const [punchEnd, setPunchEnd] = useState("4");
  const [preRoll, setPreRoll] = useState(() => {
    const safeBpm = Number.isFinite(bpm) && bpm > 0 ? bpm : 120;
    return ((parseBeatsPerBar(timeSignature) * 60) / safeBpm).toFixed(2);
  });
  const patchStorageKey = useMemo(
    () => `riff-sketchbook:track-patches:${riffId}`,
    [riffId],
  );
  const markerPatchStorageKey = useMemo(
    () => `riff-sketchbook:marker-patches:${riffId}`,
    [riffId],
  );
  const compDraftStorageKey = useMemo(
    () => `riff-sketchbook:comp-draft:${riffId}`,
    [riffId],
  );
  const compHydrated = hydratedCompRiffId === riffId;
  const ownedOutboxStorageKey = useCallback((baseKey: string) => {
    if (!outboxOwnerIdRef.current || outboxOwnerScopeRef.current !== riffId) {
      const claim = claimBrowserOutboxOwner(riffId);
      outboxOwnerIdRef.current = claim.ownerId;
      outboxOwnerScopeRef.current = riffId;
      previousOutboxOwnerIdRef.current = claim.previousOwnerId;
    }
    return ownerScopedOutboxKey(baseKey, outboxOwnerIdRef.current);
  }, [riffId]);
  const nextTrackOutboxGeneration = useCallback((
    trackId: string,
    entry?: TrackOutboxEntry,
  ) => {
    const generation = nextOutboxGeneration(
      trackOutboxGenerationsRef.current.get(trackId),
      entry?.generation,
    );
    trackOutboxGenerationsRef.current.set(trackId, generation);
    return generation;
  }, []);
  const nextMarkerOutboxGeneration = useCallback((
    markerId: string,
    entry?: MarkerOutboxEntry,
  ) => {
    const generation = nextOutboxGeneration(
      markerOutboxGenerationsRef.current.get(markerId),
      entry?.generation,
    );
    markerOutboxGenerationsRef.current.set(markerId, generation);
    return generation;
  }, []);

  const effectiveTakeId = useMemo(() => {
    if (takes.some((take) => take.id === selectedTakeId)) return selectedTakeId;
    return takes.find((take) => take.isPrimary)?.id ?? takes[0]?.id ?? "";
  }, [selectedTakeId, takes]);
  const selectedTake = takes.find((take) => take.id === effectiveTakeId);
  const beatsPerBar = parseBeatsPerBar(timeSignature);
  const hasSoloTrack = tracks.some((track) => track.solo);
  const hasReadySharedStream = Boolean(
    sharedStream?.getAudioTracks().some((track) => track.readyState === "live"),
  );
  const visiblePlayhead = playback.state === "playing"
    ? playheadSeconds
    : playback.currentTime;
  const markerTimelineDurationMs = useMemo(() => {
    const selectedDurationMs = selectedTake
      ? selectedTake.offsetMs + Math.max(
          0,
          (selectedTake.trimEndMs ?? selectedTake.durationMs ?? 0) - selectedTake.trimStartMs,
        )
      : 0;
    const compDurationMs = compRows.reduce(
      (duration, row) => duration + Math.max(0, row.endMs - row.startMs),
      0,
    );
    const trackDurationMs = tracks.reduce(
      (duration, track) => Math.max(
        duration,
        track.offsetMs + (track.durationMs ?? 0),
      ),
      0,
    );
    const lastMarkerMs = markers.reduce(
      (duration, marker) => Math.max(duration, marker.positionMs),
      0,
    );
    return Math.max(
      1_000,
      Math.round(playback.duration * 1_000),
      sourceMode === "comp" ? compDurationMs : selectedDurationMs,
      trackDurationMs,
      lastMarkerMs,
      secondsToMs(punchEnd),
    );
  }, [compRows, markers, playback.duration, punchEnd, selectedTake, sourceMode, tracks]);

  const clearPunchPlaybackTimer = useCallback(() => {
    if (punchPlaybackTimerRef.current !== null) {
      window.clearTimeout(punchPlaybackTimerRef.current);
      punchPlaybackTimerRef.current = null;
    }
    if (mountedRef.current) setPunchPlaybackActive(false);
  }, []);

  const studioTransportLocked = isStudioTransportInteractionLocked(
    captureInProgress,
    punchPlaybackActive,
  );

  const beginBusyAction = useCallback((action: LockedBusyAction) => {
    if (!studioActionLockRef.current.tryAcquire(action)) {
      setError("진행 중인 스튜디오 작업이 끝난 뒤 다시 시도해주세요.");
      return false;
    }
    setBusy(action);
    return true;
  }, []);

  const endBusyAction = useCallback((action: LockedBusyAction) => {
    if (
      studioActionLockRef.current.release(action) &&
      mountedRef.current
    ) {
      setBusy(null);
    }
  }, []);

  const rejectLockedTransportInteraction = useCallback(() => {
    const captureLocked = isStudioTransportInteractionLocked(
      captureInProgress,
      punchPlaybackTimerRef.current !== null,
    );
    if (!captureLocked && studioActionLockRef.current.pending === null) {
      return false;
    }
    setError(
      captureLocked
        ? "진행 중인 녹음이 끝난 뒤 재생 위치나 믹스 구성을 바꿀 수 있어요."
        : "진행 중인 스튜디오 작업이 끝난 뒤 재생 위치나 믹스 구성을 바꿀 수 있어요.",
    );
    return true;
  }, [captureInProgress]);

  const stopPreview = useCallback(() => {
    clearPunchPlaybackTimer();
    loadAbortRef.current?.abort();
    loadAbortRef.current = null;
    engineRef.current?.clear();
    setPlayheadSeconds(0);
    setPreviewBuffer(null);
  }, [clearPunchPlaybackTimer]);

  const stopPreviewFromUser = useCallback(() => {
    if (rejectLockedTransportInteraction()) return;
    stopPreview();
  }, [rejectLockedTransportInteraction, stopPreview]);

  const persistDirtyTrackPatches = useCallback(() => {
    try {
      const storageKey = ownedOutboxStorageKey(patchStorageKey);
      const persisted = persistRevisionedOutbox(
        browserStorage("local"),
        storageKey,
        dirtyPatchesRef.current,
      );
      trackOutboxDurableRef.current = persisted;
      return persisted;
    } catch {
      trackOutboxDurableRef.current = false;
      return false;
    }
  }, [ownedOutboxStorageKey, patchStorageKey]);

  const collectTrackPatchCopies = useCallback((trackId: string) => [
      patchStorageKey,
      ...listOwnerScopedOutboxKeys(browserStorage("local"), patchStorageKey),
    ].flatMap((sourceKey) => {
      const entry = readStoredTrackPatches(sourceKey).get(trackId);
      return entry
        ? [{
            sourceKey,
            entryId: trackId,
            fingerprint: revisionedOutboxFingerprint(entry),
          }]
        : [];
    }), [patchStorageKey]);

  const clearAppliedTrackPatchCopies = useCallback((serverTracks: readonly StudioTrack[]) => {
    const serverById = new Map(serverTracks.map((track) => [track.id, track]));
    const sourceKeys = [
      patchStorageKey,
      ...listOwnerScopedOutboxKeys(browserStorage("local"), patchStorageKey),
    ];
    const snapshots = sourceKeys.flatMap((sourceKey) => {
      const entries = readStoredTrackPatches(sourceKey);
      return [...entries].flatMap(([trackId, entry]) => {
        const serverTrack = serverById.get(trackId);
        return serverTrack && mutationAlreadyApplied(serverTrack, entry.patch)
          ? [{
              sourceKey,
              entryId: trackId,
              fingerprint: revisionedOutboxFingerprint(entry),
            }]
          : [];
      });
    });
    suppressOutboxSnapshots(browserStorage("local"), patchStorageKey, snapshots);
  }, [patchStorageKey]);

  const schedulePatchPersistence = useCallback(() => {
    if (patchPersistenceTimerRef.current !== null) return;
    patchPersistenceTimerRef.current = window.setTimeout(() => {
      patchPersistenceTimerRef.current = null;
      persistDirtyTrackPatches();
    }, 100);
  }, [persistDirtyTrackPatches]);

  const patchTrackNow = useCallback(async (trackId: string) => {
    const inFlight = patchInFlightRef.current;
    if (inFlight.has(trackId) || trackConflictIdsRef.current.has(trackId)) return;
    inFlight.add(trackId);
    try {
      // A single drain loop per track guarantees server writes arrive in the
      // same order as the user's edits. New edits are merged while we await.
      while (true) {
        const patch = patchQueueRef.current.get(trackId);
        if (!patch || Object.keys(patch).length === 0) break;
        const timer = patchTimersRef.current.get(trackId);
        if (timer !== undefined) window.clearTimeout(timer);
        patchTimersRef.current.delete(trackId);
        patchQueueRef.current.delete(trackId);
        const entry = dirtyPatchesRef.current.get(trackId);
        const expectedRevision =
          entry?.baseRevision ?? trackConfirmedRevisionsRef.current.get(trackId) ?? null;
        if (expectedRevision === null) {
          trackConflictIdsRef.current.add(trackId);
          if (mountedRef.current) {
            setTrackConflictIds(new Set(trackConflictIdsRef.current));
            setError(
              "이전에 보관한 트랙 변경이 있어요. 다른 창의 내용과 내 변경 중 하나를 선택해 주세요.",
            );
          }
          break;
        }

        let acknowledged: StudioTrack | null = null;
        let patchError: unknown = null;
        try {
          const response = await fetch(`/api/tracks/${encodeURIComponent(trackId)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            keepalive: true,
            body: JSON.stringify({ ...patch, expectedRevision }),
          });
          const payload: unknown = await response.clone().json().catch(() => null);
          if (response.ok) {
            acknowledged = normalizeTrack(
              payload && typeof payload === "object" && "track" in payload
                ? (payload as { track: unknown }).track
                : payload,
            );
            if (!acknowledged) {
              patchError = new Error("트랙 저장 결과의 버전을 확인하지 못했어요.");
            }
          } else if (response.status === 409) {
            const current = normalizeTrack(conflictCurrent(payload));
            if (
              current &&
              current.revision > expectedRevision &&
              mutationAlreadyApplied(current, patch)
            ) {
              acknowledged = current;
            } else if (current) {
              trackKnowledgeGenerationRef.current += 1;
              trackConfirmedRevisionsRef.current.set(trackId, current.revision);
              const newerPatch = patchQueueRef.current.get(trackId);
              const combinedPatch = { ...patch, ...newerPatch };
              dirtyPatchesRef.current.set(trackId, {
                baseRevision: expectedRevision,
                generation: nextTrackOutboxGeneration(
                  trackId,
                  dirtyPatchesRef.current.get(trackId),
                ),
                patch: combinedPatch,
              });
              patchQueueRef.current.delete(trackId);
              trackConflictIdsRef.current.add(trackId);
              trackConflictCurrentRef.current.set(trackId, current);
              const persisted = persistDirtyTrackPatches();
              if (mountedRef.current) {
                setTrackConflictIds(new Set(trackConflictIdsRef.current));
                setError(
                  persisted
                    ? "다른 창에서 트랙 설정이 변경됐어요. 내 변경은 브라우저에 보관했어요."
                    : "다른 창에서 트랙 설정이 변경됐고 내 변경을 브라우저에 보관하지 못했어요. 이 화면을 닫지 말고 충돌을 해결해주세요.",
                );
              }
            } else {
              patchError = await responseError(response, "트랙 설정을 저장하지 못했어요");
            }
          } else {
            patchError = await responseError(response, "트랙 설정을 저장하지 못했어요");
          }
        } catch (caught) {
          patchError = caught;
        }

        if (acknowledged) {
          trackKnowledgeGenerationRef.current += 1;
          trackConfirmedRevisionsRef.current.set(trackId, acknowledged.revision);
          const newerPatch = patchQueueRef.current.get(trackId);
          if (newerPatch && Object.keys(newerPatch).length > 0) {
            dirtyPatchesRef.current.set(trackId, {
              baseRevision: acknowledged.revision,
              generation: nextTrackOutboxGeneration(
                trackId,
                dirtyPatchesRef.current.get(trackId),
              ),
              patch: newerPatch,
            });
          } else {
            dirtyPatchesRef.current.delete(trackId);
          }
          trackConflictIdsRef.current.delete(trackId);
          trackConflictCurrentRef.current.delete(trackId);
          if (mountedRef.current) {
            setTrackConflictIds(new Set(trackConflictIdsRef.current));
            setTracks((current) =>
              current.map((track) =>
                track.id === trackId
                  ? { ...acknowledged, ...newerPatch }
                  : track,
              ),
            );
          }
          clearAppliedTrackPatchCopies([acknowledged]);
          schedulePatchPersistence();
          continue;
        }

        if (patchError && !trackConflictIdsRef.current.has(trackId)) {
          const newerPatch = patchQueueRef.current.get(trackId);
          const combinedPatch = { ...patch, ...newerPatch };
          patchQueueRef.current.delete(trackId);
          dirtyPatchesRef.current.set(trackId, {
            baseRevision: expectedRevision,
            generation: nextTrackOutboxGeneration(
              trackId,
              dirtyPatchesRef.current.get(trackId),
            ),
            patch: combinedPatch,
          });
          const persisted = persistDirtyTrackPatches();
          if (mountedRef.current) {
            setError(deferredPatchFailureMessage("트랙 설정", patchError, persisted));
          }
          // Avoid an unbounded retry loop while offline. The next edit, page
          // flush, or visit will restart this persisted queue.
        }
        persistDirtyTrackPatches();
        break;
      }
    } finally {
      inFlight.delete(trackId);
    }
  }, [
    clearAppliedTrackPatchCopies,
    nextTrackOutboxGeneration,
    persistDirtyTrackPatches,
    schedulePatchPersistence,
  ]);

  const flushPendingTrackPatches = useCallback(() => {
    if (patchPersistenceTimerRef.current !== null) {
      window.clearTimeout(patchPersistenceTimerRef.current);
      patchPersistenceTimerRef.current = null;
    }
    persistDirtyTrackPatches();
    for (const [trackId, entry] of dirtyPatchesRef.current) {
      if (trackConflictIdsRef.current.has(trackId)) continue;
      const timer = patchTimersRef.current.get(trackId);
      if (timer !== undefined) window.clearTimeout(timer);
      patchTimersRef.current.delete(trackId);
      if (!patchInFlightRef.current.has(trackId) && !patchQueueRef.current.has(trackId)) {
        patchQueueRef.current.set(trackId, entry.patch);
      }
      void patchTrackNow(trackId);
    }
  }, [patchTrackNow, persistDirtyTrackPatches]);

  const refreshTracks = useCallback(async (signal?: AbortSignal) => {
    for (let attempt = 0; attempt < MAX_LIST_REFRESH_ATTEMPTS; attempt += 1) {
      const requestGeneration = trackKnowledgeGenerationRef.current;
      const requestSerial = trackListRequestSerialRef.current + 1;
      trackListRequestSerialRef.current = requestSerial;
      const response = await fetch(`/api/riffs/${encodeURIComponent(riffId)}/tracks`, {
        credentials: "include",
        cache: "no-store",
        signal,
      });
      if (!response.ok) throw await responseError(response, "트랙을 불러오지 못했어요");
      const serverTracks = extractTracks(await response.json());
      if (signal?.aborted) throw new DOMException("트랙 불러오기가 취소됐어요.", "AbortError");
      if (!canApplyRevisionedList(
        requestGeneration,
        trackKnowledgeGenerationRef.current,
        requestSerial,
        trackListAcceptedSerialRef.current,
        serverTracks,
        trackConfirmedRevisionsRef.current,
      )) {
        continue;
      }
      trackListAcceptedSerialRef.current = requestSerial;
      for (const track of serverTracks) {
        trackConfirmedRevisionsRef.current.set(track.id, track.revision);
        if (trackConflictIdsRef.current.has(track.id)) {
          trackConflictCurrentRef.current.set(track.id, track);
        }
      }
      const visibleTracks = serverTracks.map((track) => ({
        ...track,
        ...dirtyPatchesRef.current.get(track.id)?.patch,
      }));
      if (mountedRef.current) setTracks(visibleTracks);
      return serverTracks;
    }
    throw new Error("최근 저장보다 오래된 트랙 목록이 도착해 다시 불러오지 못했어요.");
  }, [riffId]);

  const reconcileTrackOutbox = useCallback((serverTracks: readonly StudioTrack[]) => {
    const byId = new Map(serverTracks.map((track) => [track.id, track]));
    const drainIds: string[] = [];
    let foundConflict = false;

    for (const [trackId, entry] of dirtyPatchesRef.current) {
      if (patchInFlightRef.current.has(trackId)) continue;
      const serverTrack = byId.get(trackId);
      if (!serverTrack) {
        dirtyPatchesRef.current.delete(trackId);
        patchQueueRef.current.delete(trackId);
        trackConflictIdsRef.current.delete(trackId);
        trackConflictCurrentRef.current.delete(trackId);
        continue;
      }
      trackConfirmedRevisionsRef.current.set(trackId, serverTrack.revision);
      if (entry.baseRevision === serverTrack.revision) {
        patchQueueRef.current.set(trackId, entry.patch);
        trackConflictIdsRef.current.delete(trackId);
        trackConflictCurrentRef.current.delete(trackId);
        drainIds.push(trackId);
        continue;
      }
      if (mutationAlreadyApplied(serverTrack, entry.patch)) {
        dirtyPatchesRef.current.delete(trackId);
        patchQueueRef.current.delete(trackId);
        trackConflictIdsRef.current.delete(trackId);
        trackConflictCurrentRef.current.delete(trackId);
        continue;
      }
      trackConflictIdsRef.current.add(trackId);
      trackConflictCurrentRef.current.set(trackId, serverTrack);
      foundConflict = true;
    }

    const visibleTracks = serverTracks.map((track) => ({
      ...track,
      ...dirtyPatchesRef.current.get(track.id)?.patch,
    }));
    if (mountedRef.current) {
      setTracks(visibleTracks);
      setTrackConflictIds(new Set(trackConflictIdsRef.current));
      if (foundConflict) {
        setError(
          "다른 창에서 변경된 트랙이 있어요. 다른 창의 내용과 내 변경 중 하나를 선택해 주세요.",
        );
      }
    }
    persistDirtyTrackPatches();
    clearAppliedTrackPatchCopies(serverTracks);
    return drainIds;
  }, [clearAppliedTrackPatchCopies, persistDirtyTrackPatches]);

  const refreshComp = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(`/api/riffs/${encodeURIComponent(riffId)}/comp`, {
      credentials: "include",
      cache: "no-store",
      signal,
    });
    if (!response.ok) throw await responseError(response, "Comp를 불러오지 못했어요");
    const payload = normalizeCompPayload(await response.json());
    const serverRows = payload.rows;
    if (payload.revision === null) {
      throw new Error("Comp 버전 정보를 확인하지 못했어요.");
    }
    if (signal?.aborted) return serverRows;
    const serverSignature = compRowsSignature(serverRows);
    compBaselineRef.current = serverSignature;
    compRevisionRef.current = payload.revision;
    const currentCompStorageKey = ownedOutboxStorageKey(compDraftStorageKey);
    const previousOwnerId = previousOutboxOwnerIdRef.current;
    const previousCompStorageKey = previousOwnerId
      ? ownerScopedOutboxKey(compDraftStorageKey, previousOwnerId)
      : null;
    const storedDraft = readCompDraftOutbox(
      browserStorage("local"),
      compDraftStorageKey,
      currentCompStorageKey,
      previousCompStorageKey,
    );
    let rows = serverRows;
    if (storedDraft && isCompDraftAlreadyApplied(storedDraft.rows, serverRows)) {
      clearAppliedCompDraftOutboxes(
        browserStorage("local"),
        compDraftStorageKey,
        serverRows,
        [currentCompStorageKey, previousCompStorageKey],
      );
      if (mountedRef.current) {
        setPendingCompDraft(null);
        setCompDraftStatus("saved");
      }
    } else if (
      storedDraft?.baseSignature === serverSignature &&
      storedDraft.baseRevision === payload.revision
    ) {
      rows = storedDraft.rows;
      if (mountedRef.current) {
        setPendingCompDraft(null);
        setCompDraftStatus("unsaved");
      }
    } else if (storedDraft) {
      if (mountedRef.current) {
        setPendingCompDraft(storedDraft);
        setCompDraftStatus("conflict");
      }
    } else if (mountedRef.current) {
      setPendingCompDraft(null);
      setCompDraftStatus("saved");
    }
    compRowsRef.current = rows;
    if (mountedRef.current) {
      setCompRows(rows);
      setHydratedCompRiffId(riffId);
    }
    return rows;
  }, [compDraftStorageKey, ownedOutboxStorageKey, riffId]);

  const persistCompDraft = useCallback((rows: readonly CompDraftRow[]): boolean => {
    compRowsRef.current = [...rows];
    compEditGenerationRef.current += 1;
    const baseSignature = compBaselineRef.current;
    const persisted = Boolean(baseSignature) && persistCompDraftOutbox(
      browserStorage("local"),
      ownedOutboxStorageKey(compDraftStorageKey),
      {
        baseSignature,
        baseRevision: compRevisionRef.current,
        savedAtMs: Date.now(),
        rows: [...rows],
      },
    );
    compDraftDurableRef.current = persisted;
    if (!persisted) {
      setError(
        "Comp 임시본을 브라우저에 보관하지 못했어요. 이 화면을 닫지 말고 다시 저장해주세요.",
      );
    }
    setPendingCompDraft(null);
    setCompDraftStatus("unsaved");
    return persisted;
  }, [compDraftStorageKey, ownedOutboxStorageKey]);

  const restorePendingCompDraft = useCallback(() => {
    if (rejectLockedTransportInteraction()) return;
    if (!pendingCompDraft) return;
    const rows = pendingCompDraft.rows;
    setCompRows(rows);
    persistCompDraft(rows);
    stopPreview();
    setMessage("보관된 Comp 임시본을 불러왔어요. 확인 후 저장해주세요.");
  }, [pendingCompDraft, persistCompDraft, rejectLockedTransportInteraction, stopPreview]);

  const discardPendingCompDraft = useCallback(() => {
    if (
      pendingCompDraft &&
      !suppressCompDraftCopies(
        browserStorage("local"),
        compDraftStorageKey,
        pendingCompDraft,
      )
    ) {
      setError("임시본 폐기 선택을 안전하게 보관하지 못했어요. 다시 시도해주세요.");
      return;
    }
    try {
      browserStorage("local")?.removeItem(ownedOutboxStorageKey(compDraftStorageKey));
    } catch {
      // The server copy is still safe when local storage is unavailable.
    }
    setPendingCompDraft(null);
    setCompDraftStatus("saved");
    setMessage("이전 Comp 임시본을 버리고 서버에 저장된 구성을 유지했어요.");
  }, [compDraftStorageKey, ownedOutboxStorageKey, pendingCompDraft]);

  const retryCompHydration = useCallback(async () => {
    if (!beginBusyAction("comp")) return;
    setError(null);
    try {
      await refreshComp();
      setMessage("Comp 구성을 다시 불러왔어요.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Comp를 다시 불러오지 못했어요.");
    } finally {
      endBusyAction("comp");
    }
  }, [beginBusyAction, endBusyAction, refreshComp]);

  const persistDirtyMarkerPatches = useCallback(() => {
    try {
      const storageKey = ownedOutboxStorageKey(markerPatchStorageKey);
      const persisted = persistRevisionedOutbox(
        browserStorage("local"),
        storageKey,
        dirtyMarkerPatchesRef.current,
      );
      markerOutboxDurableRef.current = persisted;
      return persisted;
    } catch {
      markerOutboxDurableRef.current = false;
      return false;
    }
  }, [markerPatchStorageKey, ownedOutboxStorageKey]);

  const collectMarkerPatchCopies = useCallback((markerId: string) => [
      markerPatchStorageKey,
      ...listOwnerScopedOutboxKeys(browserStorage("local"), markerPatchStorageKey),
    ].flatMap((sourceKey) => {
      const entry = readStoredMarkerPatches(sourceKey).get(markerId);
      return entry
        ? [{
            sourceKey,
            entryId: markerId,
            fingerprint: revisionedOutboxFingerprint(entry),
          }]
        : [];
    }), [markerPatchStorageKey]);

  const clearAppliedMarkerPatchCopies = useCallback((serverMarkers: readonly StudioMarker[]) => {
    const serverById = new Map(serverMarkers.map((marker) => [marker.id, marker]));
    const sourceKeys = [
      markerPatchStorageKey,
      ...listOwnerScopedOutboxKeys(browserStorage("local"), markerPatchStorageKey),
    ];
    const snapshots = sourceKeys.flatMap((sourceKey) => {
      const entries = readStoredMarkerPatches(sourceKey);
      return [...entries].flatMap(([markerId, entry]) => {
        const serverMarker = serverById.get(markerId);
        return serverMarker && mutationAlreadyApplied(serverMarker, entry.patch)
          ? [{
              sourceKey,
              entryId: markerId,
              fingerprint: revisionedOutboxFingerprint(entry),
            }]
          : [];
      });
    });
    suppressOutboxSnapshots(browserStorage("local"), markerPatchStorageKey, snapshots);
  }, [markerPatchStorageKey]);

  const scheduleMarkerPatchPersistence = useCallback(() => {
    if (markerPersistenceTimerRef.current !== null) return;
    markerPersistenceTimerRef.current = window.setTimeout(() => {
      markerPersistenceTimerRef.current = null;
      persistDirtyMarkerPatches();
    }, 100);
  }, [persistDirtyMarkerPatches]);

  const refreshMarkers = useCallback(async (signal?: AbortSignal) => {
    for (let attempt = 0; attempt < MAX_LIST_REFRESH_ATTEMPTS; attempt += 1) {
      const requestGeneration = markerKnowledgeGenerationRef.current;
      const requestSerial = markerListRequestSerialRef.current + 1;
      markerListRequestSerialRef.current = requestSerial;
      const response = await fetch(`/api/riffs/${encodeURIComponent(riffId)}/markers`, {
        credentials: "include",
        cache: "no-store",
        signal,
      });
      if (!response.ok) throw await responseError(response, "마커를 불러오지 못했어요");
      const loaded = extractMarkers(await response.json());
      if (signal?.aborted) throw new DOMException("마커 불러오기가 취소됐어요.", "AbortError");
      if (!canApplyRevisionedList(
        requestGeneration,
        markerKnowledgeGenerationRef.current,
        requestSerial,
        markerListAcceptedSerialRef.current,
        loaded,
        markerConfirmedRevisionsRef.current,
      )) {
        continue;
      }
      markerListAcceptedSerialRef.current = requestSerial;
      markerConfirmedRevisionsRef.current.clear();
      for (const marker of loaded) {
        markerConfirmedRevisionsRef.current.set(marker.id, marker.revision);
      }
      markersRef.current = loaded;
      if (mountedRef.current) setMarkers(loaded);
      return loaded;
    }
    throw new Error("최근 저장보다 오래된 마커 목록이 도착해 다시 불러오지 못했어요.");
  }, [riffId]);

  const setMarkerConflict = useCallback((markerId: string, conflicted: boolean) => {
    if (conflicted) markerConflictIdsRef.current.add(markerId);
    else markerConflictIdsRef.current.delete(markerId);
    if (!mountedRef.current) return;
    setMarkerConflictIds(new Set(markerConflictIdsRef.current));
    if (conflicted) {
      setMarkerInputDrafts((current) => {
        if (!(markerId in current)) return current;
        const next = { ...current };
        delete next[markerId];
        return next;
      });
    }
  }, []);

  const patchMarkerNow = useCallback(async (markerId: string) => {
    if (markerPatchInFlightRef.current.has(markerId)) return;
    markerPatchInFlightRef.current.add(markerId);
    try {
      while (!deletedMarkerIdsRef.current.has(markerId)) {
        const patch = markerPatchQueueRef.current.get(markerId);
        if (!patch || Object.keys(patch).length === 0) break;
        const timer = markerPatchTimersRef.current.get(markerId);
        if (timer !== undefined) window.clearTimeout(timer);
        markerPatchTimersRef.current.delete(markerId);
        markerPatchQueueRef.current.delete(markerId);
        const revision = markerConfirmedRevisionsRef.current.get(markerId);
        if (revision === undefined) {
          markerPatchQueueRef.current.set(markerId, patch);
          persistDirtyMarkerPatches();
          break;
        }
        const dirtyEntryBeforeSend = dirtyMarkerPatchesRef.current.get(markerId);
        const currentMarkerBeforeSend = markersRef.current.find(
          (marker) => marker.id === markerId,
        );
        if (dirtyEntryBeforeSend && currentMarkerBeforeSend) {
          const reconciliation = reconcileMarkerPatch(
            revision,
            currentMarkerBeforeSend,
            dirtyEntryBeforeSend.baseRevision,
            dirtyEntryBeforeSend.patch,
          );
          if (reconciliation === "applied") {
            dirtyMarkerPatchesRef.current.delete(markerId);
            setMarkerConflict(markerId, false);
            persistDirtyMarkerPatches();
            break;
          }
          if (reconciliation === "conflict") {
            setMarkerConflict(markerId, true);
            persistDirtyMarkerPatches();
            if (mountedRef.current) {
              setError("다른 화면에서 이 마커가 변경됐어요. 최신 값을 확인한 뒤 다시 편집하면 저장할 수 있어요.");
            }
            break;
          }
        }

        try {
          const response = await fetch(`/api/markers/${encodeURIComponent(markerId)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            keepalive: true,
            body: JSON.stringify({ revision, ...patch }),
          });
          if (response.status === 409) {
            markerPatchQueueRef.current.delete(markerId);
            if (!persistDirtyMarkerPatches()) {
              markerPatchQueueRef.current.set(markerId, patch);
              setMarkerConflict(markerId, true);
              if (mountedRef.current) {
                setError(
                  "다른 화면에서 마커가 변경됐고 내 변경을 브라우저에 보관하지 못했어요. 현재 화면을 유지했으니 닫지 말고 다시 시도해주세요.",
                );
              }
              return;
            }
            const loaded = await refreshMarkers();
            const currentMarker = loaded.find((marker) => marker.id === markerId);
            const dirtyEntry = dirtyMarkerPatchesRef.current.get(markerId);
            if (
              currentMarker &&
              dirtyEntry &&
              reconcileMarkerPatch(
                currentMarker.revision,
                currentMarker,
                dirtyEntry.baseRevision,
                dirtyEntry.patch,
              ) === "applied"
            ) {
              dirtyMarkerPatchesRef.current.delete(markerId);
              setMarkerConflict(markerId, false);
            } else if (currentMarker && dirtyEntry) {
              setMarkerConflict(markerId, true);
              if (mountedRef.current) {
                setError("다른 화면에서 이 마커가 변경됐어요. 최신 값을 확인한 뒤 다시 편집하면 저장할 수 있어요.");
              }
            } else {
              dirtyMarkerPatchesRef.current.delete(markerId);
              setMarkerConflict(markerId, false);
            }
            const persisted = persistDirtyMarkerPatches();
            if (!persisted && dirtyMarkerPatchesRef.current.has(markerId)) {
              setError(
                "다른 화면에서 마커가 변경됐고 내 변경을 브라우저에 보관하지 못했어요. 이 화면을 닫지 말고 최신 값을 확인해주세요.",
              );
            }
            return;
          }
          if (!response.ok) throw await responseError(response, "마커를 저장하지 못했어요");
          const payload: unknown = await response.json();
          const normalized = normalizeMarker(
            payload && typeof payload === "object" && "marker" in payload
              ? (payload as { marker: unknown }).marker
              : payload,
          );
          if (!normalized) throw new Error("저장된 마커 정보를 읽지 못했어요.");
          markerKnowledgeGenerationRef.current += 1;
          markerConfirmedRevisionsRef.current.set(markerId, normalized.revision);
          setMarkerConflict(markerId, false);
          const newerPatch = markerPatchQueueRef.current.get(markerId);
          if (newerPatch) {
            dirtyMarkerPatchesRef.current.set(markerId, {
              baseRevision: normalized.revision,
              generation: nextMarkerOutboxGeneration(
                markerId,
                dirtyMarkerPatchesRef.current.get(markerId),
              ),
              patch: newerPatch,
            });
          } else {
            dirtyMarkerPatchesRef.current.delete(markerId);
          }
          if (mountedRef.current && !deletedMarkerIdsRef.current.has(markerId)) {
            setMarkers((current) => {
              const next = sortMarkers(current.map((marker) =>
              marker.id === markerId
                ? { ...normalized, ...newerPatch }
                : marker,
              ));
              markersRef.current = next;
              return next;
            });
          }
          clearAppliedMarkerPatchCopies([normalized]);
          scheduleMarkerPatchPersistence();
        } catch (patchError) {
          if (deletedMarkerIdsRef.current.has(markerId)) break;
          const newerPatch = markerPatchQueueRef.current.get(markerId);
          const retryPatch = { ...patch, ...newerPatch };
          markerPatchQueueRef.current.set(markerId, retryPatch);
          const dirtyEntry = dirtyMarkerPatchesRef.current.get(markerId);
          dirtyMarkerPatchesRef.current.set(markerId, {
            baseRevision: dirtyEntry?.baseRevision ?? revision,
            generation: nextMarkerOutboxGeneration(markerId, dirtyEntry),
            patch: { ...dirtyEntry?.patch, ...retryPatch },
          });
          const persisted = persistDirtyMarkerPatches();
          if (mountedRef.current) {
            setError(deferredPatchFailureMessage("마커", patchError, persisted));
          }
          break;
        }
      }
    } finally {
      markerPatchInFlightRef.current.delete(markerId);
    }
  }, [
    clearAppliedMarkerPatchCopies,
    nextMarkerOutboxGeneration,
    persistDirtyMarkerPatches,
    refreshMarkers,
    scheduleMarkerPatchPersistence,
    setMarkerConflict,
  ]);

  const flushPendingMarkerPatches = useCallback(() => {
    if (markerPersistenceTimerRef.current !== null) {
      window.clearTimeout(markerPersistenceTimerRef.current);
      markerPersistenceTimerRef.current = null;
    }
    persistDirtyMarkerPatches();
    for (const [markerId, dirtyEntry] of dirtyMarkerPatchesRef.current) {
      const timer = markerPatchTimersRef.current.get(markerId);
      if (timer !== undefined) window.clearTimeout(timer);
      markerPatchTimersRef.current.delete(markerId);
      if (
        !markerConflictIdsRef.current.has(markerId) &&
        !markerPatchInFlightRef.current.has(markerId) &&
        !markerPatchQueueRef.current.has(markerId)
      ) {
        markerPatchQueueRef.current.set(markerId, dirtyEntry.patch);
      }
      if (!markerConflictIdsRef.current.has(markerId)) void patchMarkerNow(markerId);
    }
  }, [patchMarkerNow, persistDirtyMarkerPatches]);

  const reconcileMarkerOutbox = useCallback((loadedMarkers: readonly StudioMarker[]) => {
    const loadedById = new Map(loadedMarkers.map((marker) => [marker.id, marker]));
    const optimisticPatches = new Map<string, MarkerPatch>();
    const drainIds: string[] = [];
    let foundConflict = false;

    for (const [markerId, entry] of dirtyMarkerPatchesRef.current) {
      const marker = loadedById.get(markerId);
      markerPatchQueueRef.current.delete(markerId);
      if (!marker) {
        dirtyMarkerPatchesRef.current.delete(markerId);
        markerConflictIdsRef.current.delete(markerId);
        continue;
      }
      const reconciliation = reconcileMarkerPatch(
        marker.revision,
        marker,
        entry.baseRevision,
        entry.patch,
      );
      if (reconciliation === "ready") {
        markerPatchQueueRef.current.set(markerId, entry.patch);
        markerConflictIdsRef.current.delete(markerId);
        optimisticPatches.set(markerId, entry.patch);
        drainIds.push(markerId);
        continue;
      }
      if (reconciliation === "applied") {
        dirtyMarkerPatchesRef.current.delete(markerId);
        markerConflictIdsRef.current.delete(markerId);
        continue;
      }
      markerConflictIdsRef.current.add(markerId);
      foundConflict = true;
    }

    const nextMarkers = sortMarkers(loadedMarkers.map((marker) => ({
      ...marker,
      ...optimisticPatches.get(marker.id),
    })));
    markersRef.current = nextMarkers;
    if (mountedRef.current) {
      setMarkers(nextMarkers);
      setMarkerConflictIds(new Set(markerConflictIdsRef.current));
      if (foundConflict) {
        setError("다른 화면에서 변경된 마커가 있어요. 최신 값을 확인한 뒤 다시 편집하면 저장할 수 있어요.");
      }
    }
    persistDirtyMarkerPatches();
    clearAppliedMarkerPatchCopies(loadedMarkers);
    return drainIds;
  }, [clearAppliedMarkerPatchCopies, persistDirtyMarkerPatches]);

  useEffect(() => {
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!hasUndurableStudioChanges({
        trackPatchCount: dirtyPatchesRef.current.size,
        trackOutboxDurable: trackOutboxDurableRef.current,
        markerPatchCount: dirtyMarkerPatchesRef.current.size,
        markerOutboxDurable: markerOutboxDurableRef.current,
        compDraftDurable: compDraftDurableRef.current,
      })) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const ownsTracksLoadAction =
      studioActionLockRef.current.pending === "tracks" ||
      studioActionLockRef.current.tryAcquire("tracks");
    if (ownsTracksLoadAction) setBusy("tracks");
    const patchTimers = patchTimersRef.current;
    const markerPatchTimers = markerPatchTimersRef.current;
    const handlePageHide = () => {
      flushPendingTrackPatches();
      flushPendingMarkerPatches();
    };
    const handleOnline = () => {
      void refreshTracks()
        .then((loadedTracks) => {
          for (const trackId of reconcileTrackOutbox(loadedTracks)) {
            void patchTrackNow(trackId);
          }
        })
        .catch(() => {
          // The outbox stays persisted until connectivity is actually restored.
        });
      void refreshMarkers()
        .then((loadedMarkers) => {
          for (const markerId of reconcileMarkerOutbox(loadedMarkers)) {
            void patchMarkerNow(markerId);
          }
        })
        .catch(() => {
          // The outbox stays persisted until connectivity is actually restored.
        });
    };
    const currentTrackStorageKey = ownedOutboxStorageKey(patchStorageKey);
    const restoredPatches = readRecoverableTrackPatches(
      currentTrackStorageKey,
      patchStorageKey,
    );
    const previousOwnerId = previousOutboxOwnerIdRef.current;
    const previousTrackStorageKey = previousOwnerId
      ? ownerScopedOutboxKey(patchStorageKey, previousOwnerId)
      : null;
    const previousOwnerPatches = previousOwnerId
      ? readRecoverableTrackPatches(previousTrackStorageKey!, patchStorageKey)
      : new Map<string, TrackOutboxEntry>();
    const additionalTrackOwnerPatches = listOwnerScopedOutboxKeys(
      browserStorage("local"),
      patchStorageKey,
    )
      .filter((key) => key !== currentTrackStorageKey && key !== previousTrackStorageKey)
      .map((key) => readRecoverableTrackPatches(key, patchStorageKey));
    const legacyPatches = readRecoverableTrackPatches(patchStorageKey, patchStorageKey);
    const mergedTrackOutbox = mergeOwnerOutboxEntries(
      dirtyPatchesRef.current,
      restoredPatches,
      previousOwnerPatches,
      legacyPatches,
      additionalTrackOwnerPatches,
    );
    dirtyPatchesRef.current = mergedTrackOutbox.entries;
    for (const [trackId, entry] of mergedTrackOutbox.entries) {
      trackOutboxGenerationsRef.current.set(
        trackId,
        Math.max(
          trackOutboxGenerationsRef.current.get(trackId) ?? 0,
          normalizeOutboxGeneration(entry.generation),
        ),
      );
    }
    if (mergedTrackOutbox.shouldPersistToCurrentOwner && persistDirtyTrackPatches()) {
      suppressOutboxSnapshots(
        browserStorage("local"),
        patchStorageKey,
        [...legacyPatches].map(([trackId, entry]) => ({
          sourceKey: patchStorageKey,
          entryId: trackId,
          fingerprint: revisionedOutboxFingerprint(entry),
        })),
      );
    }
    const currentMarkerStorageKey = ownedOutboxStorageKey(markerPatchStorageKey);
    const restoredMarkerPatches = readRecoverableMarkerPatches(
      currentMarkerStorageKey,
      markerPatchStorageKey,
    );
    const previousMarkerStorageKey = previousOwnerId
      ? ownerScopedOutboxKey(markerPatchStorageKey, previousOwnerId)
      : null;
    const previousOwnerMarkerPatches = previousOwnerId
      ? readRecoverableMarkerPatches(
          previousMarkerStorageKey!,
          markerPatchStorageKey,
        )
      : new Map<string, MarkerOutboxEntry>();
    const additionalMarkerOwnerPatches = listOwnerScopedOutboxKeys(
      browserStorage("local"),
      markerPatchStorageKey,
    )
      .filter((key) => key !== currentMarkerStorageKey && key !== previousMarkerStorageKey)
      .map((key) => readRecoverableMarkerPatches(key, markerPatchStorageKey));
    const legacyMarkerPatches = readRecoverableMarkerPatches(
      markerPatchStorageKey,
      markerPatchStorageKey,
    );
    const mergedMarkerOutbox = mergeOwnerOutboxEntries(
      dirtyMarkerPatchesRef.current,
      restoredMarkerPatches,
      previousOwnerMarkerPatches,
      legacyMarkerPatches,
      additionalMarkerOwnerPatches,
    );
    dirtyMarkerPatchesRef.current = mergedMarkerOutbox.entries;
    for (const [markerId, entry] of mergedMarkerOutbox.entries) {
      markerOutboxGenerationsRef.current.set(
        markerId,
        Math.max(
          markerOutboxGenerationsRef.current.get(markerId) ?? 0,
          normalizeOutboxGeneration(entry.generation),
        ),
      );
    }
    if (mergedMarkerOutbox.shouldPersistToCurrentOwner && persistDirtyMarkerPatches()) {
      suppressOutboxSnapshots(
        browserStorage("local"),
        markerPatchStorageKey,
        [...legacyMarkerPatches].map(([markerId, entry]) => ({
          sourceKey: markerPatchStorageKey,
          entryId: markerId,
          fingerprint: revisionedOutboxFingerprint(entry),
        })),
      );
    }
    const engine = new AudioTimelineEngine();
    const decodeCache = new AudioDecodeCache();
    engineRef.current = engine;
    decodeCacheRef.current = decodeCache;
    const unsubscribe = engine.subscribe(setPlayback);
    const controller = new AbortController();
    window.addEventListener("pagehide", handlePageHide);
    window.addEventListener("online", handleOnline);
    const tracksRequest = refreshTracks(controller.signal);
    const compRequest = refreshComp(controller.signal);
    const markersRequest = refreshMarkers(controller.signal);
    void tracksRequest.then((loadedTracks) => {
      if (controller.signal.aborted) return;
      for (const trackId of reconcileTrackOutbox(loadedTracks)) {
        void patchTrackNow(trackId);
      }
    }).catch(() => {
      // Keep the local outbox for a later visit when track validation fails.
    });
    void markersRequest.then((loadedMarkers) => {
      if (controller.signal.aborted) return;
      for (const markerId of reconcileMarkerOutbox(loadedMarkers)) {
        void patchMarkerNow(markerId);
      }
    }).catch(() => {
      // Keep the local outbox for a later visit when marker validation fails.
    });
    void Promise.all([tracksRequest, compRequest, markersRequest])
      .catch((loadError: unknown) => {
        if (!controller.signal.aborted && mountedRef.current) {
          setError(loadError instanceof Error ? loadError.message : "고급 도구를 불러오지 못했어요.");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted && ownsTracksLoadAction) {
          endBusyAction("tracks");
        }
      });

    return () => {
      mountedRef.current = false;
      controller.abort();
      loadAbortRef.current?.abort();
      clearPunchPlaybackTimer();
      for (const timer of patchTimers.values()) window.clearTimeout(timer);
      patchTimers.clear();
      for (const timer of markerPatchTimers.values()) window.clearTimeout(timer);
      markerPatchTimers.clear();
      flushPendingTrackPatches();
      flushPendingMarkerPatches();
      window.removeEventListener("pagehide", handlePageHide);
      window.removeEventListener("online", handleOnline);
      unsubscribe();
      engineRef.current = null;
      decodeCacheRef.current = null;
      void engine.dispose();
      void decodeCache.dispose();
    };
  }, [
    clearPunchPlaybackTimer,
    endBusyAction,
    flushPendingTrackPatches,
    flushPendingMarkerPatches,
    markerPatchStorageKey,
    ownedOutboxStorageKey,
    patchStorageKey,
    patchMarkerNow,
    patchTrackNow,
    persistDirtyTrackPatches,
    persistDirtyMarkerPatches,
    reconcileMarkerOutbox,
    reconcileTrackOutbox,
    refreshComp,
    refreshMarkers,
    refreshTracks,
  ]);

  useEffect(() => {
    if (playback.state !== "playing") return;
    let frame = 0;
    const tick = () => {
      const engine = engineRef.current;
      if (!engine || engine.state !== "playing") return;
      setPlayheadSeconds(engine.currentTime);
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [playback.state]);

  const acceptServerTrackVersion = useCallback(async (trackId: string) => {
    if (trackResolutionIdsRef.current.has(trackId)) return;
    const dirtyEntryAtStart = dirtyPatchesRef.current.get(trackId);
    const patchSnapshotsAtStart = collectTrackPatchCopies(trackId);
    trackResolutionIdsRef.current.add(trackId);
    setTrackResolutionIds(new Set(trackResolutionIdsRef.current));
    setError(null);
    try {
      const response = await fetch(`/api/tracks/${encodeURIComponent(trackId)}`, {
        credentials: "include",
        cache: "no-store",
      });
      if (!response.ok) throw await responseError(response, "트랙을 새로 불러오지 못했어요");
      const payload: unknown = await response.json();
      const serverTrack = normalizeTrack(
        payload && typeof payload === "object" && "track" in payload
          ? (payload as { track: unknown }).track
          : payload,
      );
      if (!serverTrack) {
        throw new Error("트랙의 최신 버전을 확인하지 못했어요.");
      }
      const knownRevision = trackConfirmedRevisionsRef.current.get(trackId) ?? 0;
      if (serverTrack.revision < knownRevision) {
        throw new Error("더 최신인 트랙 설정이 있어 다시 불러와 주세요.");
      }
      if (!isSameOutboxGeneration(
        dirtyEntryAtStart,
        dirtyPatchesRef.current.get(trackId),
      )) {
        trackConfirmedRevisionsRef.current.set(trackId, serverTrack.revision);
        trackConflictCurrentRef.current.set(trackId, serverTrack);
        setError(
          "최신 설정을 불러오는 동안 새 변경이 생겨 내 설정을 유지했어요. 적용할 버전을 다시 선택해 주세요.",
        );
        return;
      }
      trackKnowledgeGenerationRef.current += 1;
      if (suppressOutboxSnapshots(
        browserStorage("local"),
        patchStorageKey,
        patchSnapshotsAtStart,
      ) !== patchSnapshotsAtStart.length) {
        setError("서버 설정 사용 선택을 안전하게 보관하지 못했어요. 다시 시도해주세요.");
        return;
      }
      const timer = patchTimersRef.current.get(trackId);
      if (timer !== undefined) window.clearTimeout(timer);
      patchTimersRef.current.delete(trackId);
      patchQueueRef.current.delete(trackId);
      dirtyPatchesRef.current.delete(trackId);
      trackConfirmedRevisionsRef.current.set(trackId, serverTrack.revision);
      trackConflictIdsRef.current.delete(trackId);
      trackConflictCurrentRef.current.delete(trackId);
      setTrackConflictIds(new Set(trackConflictIdsRef.current));
      setTracks((current) =>
        current.map((track) => (track.id === trackId ? serverTrack : track)),
      );
      persistDirtyTrackPatches();
      setMessage("다른 창의 최신 트랙 설정을 불러왔어요.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "트랙을 새로 불러오지 못했어요.");
    } finally {
      trackResolutionIdsRef.current.delete(trackId);
      if (mountedRef.current) {
        setTrackResolutionIds(new Set(trackResolutionIdsRef.current));
      }
    }
  }, [collectTrackPatchCopies, patchStorageKey, persistDirtyTrackPatches]);

  const rebaseLocalTrackPatch = useCallback((trackId: string) => {
    const entry = dirtyPatchesRef.current.get(trackId);
    const current = trackConflictCurrentRef.current.get(trackId);
    if (!entry || !current) {
      setError("트랙의 최신 버전을 먼저 다시 불러와 주세요.");
      return;
    }
    const currentOwnerKey = ownedOutboxStorageKey(patchStorageKey);
    const supersededSnapshots = collectTrackPatchCopies(trackId).filter(
      (snapshot) => snapshot.sourceKey !== currentOwnerKey,
    );
    dirtyPatchesRef.current.set(trackId, {
      baseRevision: current.revision,
      generation: nextTrackOutboxGeneration(trackId, entry),
      patch: entry.patch,
    });
    if (!persistDirtyTrackPatches()) {
      setError("내 트랙 설정을 안전하게 보관하지 못해 충돌 해결을 중단했어요.");
      return;
    }
    if (suppressOutboxSnapshots(
      browserStorage("local"),
      patchStorageKey,
      supersededSnapshots,
    ) !== supersededSnapshots.length) {
      setError("이전 트랙 임시본을 안전하게 정리하지 못해 충돌 해결을 중단했어요.");
      return;
    }
    patchQueueRef.current.set(trackId, entry.patch);
    trackConfirmedRevisionsRef.current.set(trackId, current.revision);
    trackConflictIdsRef.current.delete(trackId);
    trackConflictCurrentRef.current.delete(trackId);
    setTrackConflictIds(new Set(trackConflictIdsRef.current));
    setError(null);
    setMessage("내 트랙 설정을 최신 버전에 다시 저장하고 있어요.");
    void patchTrackNow(trackId);
  }, [
    patchTrackNow,
    collectTrackPatchCopies,
    ownedOutboxStorageKey,
    patchStorageKey,
    persistDirtyTrackPatches,
    nextTrackOutboxGeneration,
  ]);

  const queueTrackPatch = useCallback((trackId: string, patch: TrackPatch) => {
    if (rejectLockedTransportInteraction()) return;
    stopPreview();
    setTracks((current) => current.map((track) => (
      track.id === trackId ? { ...track, ...patch } : track
    )));
    const currentEntry = dirtyPatchesRef.current.get(trackId);
    const dirtyPatch = {
      ...currentEntry?.patch,
      ...patch,
    };
    dirtyPatchesRef.current.set(trackId, {
      baseRevision:
        currentEntry?.baseRevision ??
        trackConfirmedRevisionsRef.current.get(trackId) ??
        null,
      generation: nextTrackOutboxGeneration(trackId, currentEntry),
      patch: dirtyPatch,
    });
    trackOutboxDurableRef.current = false;
    trackKnowledgeGenerationRef.current += 1;
    schedulePatchPersistence();
    if (trackConflictIdsRef.current.has(trackId)) return;
    patchQueueRef.current.set(trackId, dirtyPatch);
    const existing = patchTimersRef.current.get(trackId);
    if (existing !== undefined) window.clearTimeout(existing);
    patchTimersRef.current.set(
      trackId,
      window.setTimeout(() => {
        patchTimersRef.current.delete(trackId);
        void patchTrackNow(trackId);
      }, 350),
    );
  }, [nextTrackOutboxGeneration, patchTrackNow, rejectLockedTransportInteraction, schedulePatchPersistence, stopPreview]);

  const queueMarkerPatch = useCallback((markerId: string, patch: MarkerPatch) => {
    const marker = markersRef.current.find((item) => item.id === markerId);
    if (!marker) return;
    const isConflictResolution = markerConflictIdsRef.current.has(markerId);
    const currentOwnerKey = ownedOutboxStorageKey(markerPatchStorageKey);
    const supersededSnapshots = isConflictResolution
      ? collectMarkerPatchCopies(markerId).filter(
          (snapshot) => snapshot.sourceKey !== currentOwnerKey,
        )
      : [];
    const currentEntry = isConflictResolution
      ? undefined
      : dirtyMarkerPatchesRef.current.get(markerId);
    const queuedPatch = {
      ...(isConflictResolution ? undefined : markerPatchQueueRef.current.get(markerId)),
      ...patch,
    };
    const dirtyPatch = {
      ...currentEntry?.patch,
      ...patch,
    };
    dirtyMarkerPatchesRef.current.set(markerId, {
      baseRevision: currentEntry?.baseRevision ?? marker.revision,
      generation: nextMarkerOutboxGeneration(markerId, currentEntry),
      patch: dirtyPatch,
    });
    markerOutboxDurableRef.current = false;
    if (isConflictResolution) {
      if (!persistDirtyMarkerPatches()) {
        setError("새 마커 설정을 안전하게 보관하지 못해 충돌 해결을 중단했어요.");
        return;
      }
      if (suppressOutboxSnapshots(
        browserStorage("local"),
        markerPatchStorageKey,
        supersededSnapshots,
      ) !== supersededSnapshots.length) {
        setError("이전 마커 임시본을 안전하게 정리하지 못해 충돌 해결을 중단했어요.");
        return;
      }
    }
    setMarkerConflict(markerId, false);
    setMarkers((current) => {
      const next = sortMarkers(current.map((item) =>
        item.id === markerId ? { ...item, ...patch } : item,
      ));
      markersRef.current = next;
      return next;
    });
    markerPatchQueueRef.current.set(markerId, queuedPatch);
    markerKnowledgeGenerationRef.current += 1;
    if (!isConflictResolution) scheduleMarkerPatchPersistence();
    const existing = markerPatchTimersRef.current.get(markerId);
    if (existing !== undefined) window.clearTimeout(existing);
    markerPatchTimersRef.current.set(
      markerId,
      window.setTimeout(() => {
        markerPatchTimersRef.current.delete(markerId);
        void patchMarkerNow(markerId);
      }, 350),
    );
  }, [
    collectMarkerPatchCopies,
    markerPatchStorageKey,
    nextMarkerOutboxGeneration,
    ownedOutboxStorageKey,
    patchMarkerNow,
    persistDirtyMarkerPatches,
    scheduleMarkerPatchPersistence,
    setMarkerConflict,
  ]);

  const createTrack = useCallback(async (options: {
    file: File;
    kind: StudioTrack["kind"];
    name: string;
    durationMs: number | null;
  }) => {
    const { file, kind, name, durationMs } = options;
    const preflight = preflightAudioFile(file);
    if (!preflight.ok) throw new Error(preflight.message);
    const contentDigest = await audioFileContentDigest(file);
    const intentFingerprint = trackCreateIntentFingerprint({
      kind,
      name,
      durationMs,
      fileName: file.name,
      mimeType: file.type.split(";", 1)[0]?.trim().toLowerCase() ?? "",
      byteSize: file.size,
      contentDigest,
    });
    const operation = getOrCreateCreateRequest(
      createRequestRegistryRef.current,
      browserStorage("session"),
      "track",
      riffId,
      intentFingerprint,
    );
    const form = new FormData();
    form.append("audio", file);
    form.append("kind", kind);
    form.append("name", name);
    form.append("requestId", operation.requestId);
    if (durationMs !== null) form.append("durationMs", String(durationMs));

    let mayReconcile = true;
    try {
      const response = await fetch(`/api/riffs/${encodeURIComponent(riffId)}/tracks`, {
        method: "POST",
        credentials: "include",
        body: form,
      });
      if (response.status === 409) {
        mayReconcile = false;
        completeCreateRequest(
          createRequestRegistryRef.current,
          browserStorage("session"),
          operation,
        );
      }
      if (!response.ok) throw await responseError(response, `${file.name} 업로드에 실패했어요`);
      const payload: unknown = await response.json();
      const track = normalizeTrack(
        payload && typeof payload === "object" && "track" in payload
          ? (payload as { track: unknown }).track
          : payload,
      );
      if (!track || track.clientRequestId !== operation.requestId) {
        throw new Error("추가된 트랙 정보를 확인하지 못했어요.");
      }
      return { track, operation };
    } catch (createError) {
      if (!mayReconcile) throw createError;
      const reconciledTracks = await refreshTracks().catch(() => null);
      const track = reconciledTracks?.find(
        (candidate) => candidate.clientRequestId === operation.requestId,
      );
      if (!track) throw createError;
      return { track, operation };
    }
  }, [refreshTracks, riffId]);

  const uploadTrackFiles = useCallback(async (files: readonly File[], kind: StudioTrack["kind"]) => {
    if (files.length === 0) return;
    if (rejectLockedTransportInteraction()) return;
    const invalidFile = files
      .map((file) => preflightAudioFile(file))
      .find((result) => !result.ok);
    if (invalidFile && !invalidFile.ok) {
      setMessage(null);
      setError(invalidFile.message);
      return;
    }
    if (!beginBusyAction("upload")) return;
    setError(null);
    setMessage(null);
    let successCount = 0;
    try {
      for (const file of files) {
        const created = await createTrack({
          file,
          kind,
          name: file.name.replace(/\.[^.]+$/, "").slice(0, 120),
          durationMs: null,
        });
        completeCreateRequest(
          createRequestRegistryRef.current,
          browserStorage("session"),
          created.operation,
        );
        trackKnowledgeGenerationRef.current += 1;
        trackConfirmedRevisionsRef.current.set(created.track.id, created.track.revision);
        setTracks((current) => current.some((track) => track.id === created.track.id)
          ? current.map((track) => track.id === created.track.id ? created.track : track)
          : [...current, created.track]);
        successCount += 1;
      }
      setMessage(`${successCount}개 트랙을 추가했어요.`);
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "트랙을 추가하지 못했어요.");
      if (successCount > 0) {
        setMessage(
          `${successCount}개 트랙은 추가했어요. 나머지 ${files.length - successCount}개는 추가하지 못했어요.`,
        );
      }
    } finally {
      await refreshTracks().catch(() => undefined);
      endBusyAction("upload");
    }
  }, [beginBusyAction, createTrack, endBusyAction, refreshTracks, rejectLockedTransportInteraction]);

  const promoteSelectedTake = useCallback(async () => {
    if (!selectedTake) return;
    if (rejectLockedTransportInteraction()) return;
    if (!beginBusyAction("promote")) return;
    setError(null);
    setMessage(null);
    try {
      const decodeCache = decodeCacheRef.current;
      if (!decodeCache) throw new Error("오디오 디코더를 준비하지 못했어요.");
      const [decoded] = await decodeCache.loadTracks([{
        id: `promote:${selectedTake.id}`,
        source: selectedTake.audioUrl,
      }]);
      if (!decoded) throw new Error("테이크 오디오를 불러오지 못했어요.");
      const trimStartSeconds = Math.min(
        decoded.buffer.duration,
        Math.max(0, selectedTake.trimStartMs / 1_000),
      );
      const trimEndSeconds = Math.min(
        decoded.buffer.duration,
        (selectedTake.trimEndMs ?? selectedTake.durationMs ?? decoded.buffer.duration * 1_000) / 1_000,
      );
      if (trimEndSeconds <= trimStartSeconds) throw new Error("기타 트랙으로 만들 구간이 비어 있어요.");
      const cropped = await renderSelectedTake(decoded.buffer, {
        trimStartSeconds,
        trimEndSeconds,
        channels: Math.min(2, decoded.buffer.numberOfChannels),
      });
      const blob = encodePcmWav(cropped, { bitDepth: 16 });
      const created = await createTrack({
        file: new File([blob], `${selectedTake.name}.wav`, { type: "audio/wav" }),
        kind: "guitar",
        name: selectedTake.name.slice(0, 120),
        durationMs: Math.max(1, Math.round(cropped.duration * 1_000)),
      });
      trackKnowledgeGenerationRef.current += 1;
      if (selectedTake.offsetMs > 0 && created.track.offsetMs !== selectedTake.offsetMs) {
        const alignResponse = await fetch(`/api/tracks/${encodeURIComponent(created.track.id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            offsetMs: selectedTake.offsetMs,
            expectedRevision: created.track.revision,
          }),
        });
        if (!alignResponse.ok) throw await responseError(alignResponse, "트랙 위치를 맞추지 못했어요");
        trackKnowledgeGenerationRef.current += 1;
      }
      await refreshTracks();
      completeCreateRequest(
        createRequestRegistryRef.current,
        browserStorage("session"),
        created.operation,
      );
      setMessage(`${selectedTake.name}의 선택 구간을 기타 트랙으로 추가했어요.`);
    } catch (promoteError) {
      setError(promoteError instanceof Error ? promoteError.message : "테이크를 트랙으로 추가하지 못했어요.");
      await refreshTracks().catch(() => undefined);
    } finally {
      endBusyAction("promote");
    }
  }, [beginBusyAction, createTrack, endBusyAction, refreshTracks, rejectLockedTransportInteraction, selectedTake]);

  const deleteTrack = useCallback(async (track: StudioTrack) => {
    if (rejectLockedTransportInteraction()) return;
    if (!window.confirm(`‘${track.name}’ 트랙을 삭제할까요?`)) return;
    stopPreview();
    setError(null);
    if (trackConflictIdsRef.current.has(track.id)) {
      setError("충돌한 트랙 설정을 먼저 정리한 뒤 삭제해 주세요.");
      return;
    }
    if (dirtyPatchesRef.current.has(track.id)) {
      await patchTrackNow(track.id);
      for (let attempt = 0; attempt < 40 && patchInFlightRef.current.has(track.id); attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 50));
      }
      if (dirtyPatchesRef.current.has(track.id)) {
        setError("트랙 설정 저장이 끝난 뒤 다시 삭제해 주세요.");
        return;
      }
    }
    const latestTracks = await refreshTracks().catch(() => null);
    if (latestTracks === null) {
      setError("트랙의 최신 상태를 확인하지 못했어요. 연결을 확인한 뒤 다시 삭제해 주세요.");
      return;
    }
    const latestTrack = latestTracks.find((item) => item.id === track.id);
    if (!latestTrack) {
      setMessage(`${track.name}은 이미 삭제됐어요.`);
      return;
    }
    let requestError: unknown = null;
    let completed = false;
    try {
      const response = await fetch(`/api/tracks/${encodeURIComponent(track.id)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ expectedRevision: latestTrack.revision }),
      });
      if (!response.ok) throw await responseError(response, "트랙을 삭제하지 못했어요");
      trackKnowledgeGenerationRef.current += 1;
      completed = true;
    } catch (deleteError) {
      requestError = deleteError;
      const serverTracks = await refreshTracks().catch(() => null);
      completed = serverTracks !== null && deletionAlreadyApplied(track.id, serverTracks);
    }
    if (completed) {
      const patchTimer = patchTimersRef.current.get(track.id);
      if (patchTimer !== undefined) window.clearTimeout(patchTimer);
      patchTimersRef.current.delete(track.id);
      patchQueueRef.current.delete(track.id);
      dirtyPatchesRef.current.delete(track.id);
      trackConfirmedRevisionsRef.current.delete(track.id);
      trackConflictIdsRef.current.delete(track.id);
      trackConflictCurrentRef.current.delete(track.id);
      setTrackConflictIds(new Set(trackConflictIdsRef.current));
      schedulePatchPersistence();
      decodeCacheRef.current?.invalidate(track.audioUrl);
      setTracks((current) => current.filter((item) => item.id !== track.id));
      setMessage(`${track.name}을 삭제했어요.`);
    } else {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "트랙을 삭제하지 못했어요.",
      );
    }
  }, [patchTrackNow, refreshTracks, rejectLockedTransportInteraction, schedulePatchPersistence, stopPreview]);

  const buildArrangement = useCallback(async (mode: SourceMode): Promise<TimelineTrack[]> => {
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    const sourceEntries = new Map<string, TimelineTrackSource>();

    if (mode === "comp") {
      const validationError = compValidationError(compRows, takes);
      if (validationError) throw new Error(validationError);
    }

    if (mode === "take" && selectedTake) {
      sourceEntries.set(`take:${selectedTake.id}`, {
        id: `take:${selectedTake.id}`,
        source: selectedTake.audioUrl,
      });
    }
    if (mode === "comp") {
      for (const row of compRows) {
        const take = takes.find((item) => item.id === row.takeId);
        if (take) {
          sourceEntries.set(`take:${take.id}`, { id: `take:${take.id}`, source: take.audioUrl });
        }
      }
    }
    for (const track of tracks) {
      sourceEntries.set(`track:${track.id}`, { id: `track:${track.id}`, source: track.audioUrl });
    }
    if (sourceEntries.size === 0) throw new Error("재생하거나 내보낼 오디오가 없어요.");

    const decodeCache = decodeCacheRef.current;
    if (!decodeCache) throw new Error("오디오 디코더를 준비하지 못했어요.");
    const decoded = await decodeCache.loadTracks([...sourceEntries.values()], {
      signal: controller.signal,
    });
    if (controller.signal.aborted) throw new DOMException("미리보기가 취소됐어요.", "AbortError");
    const buffers = new Map(decoded.map((item) => [item.id, item.buffer]));
    const arrangement: TimelineTrack[] = [];
    let waveformBuffer: AudioBuffer | null = null;

    if (mode === "take" && selectedTake) {
      const buffer = buffers.get(`take:${selectedTake.id}`);
      if (buffer) {
        const trimStart = Math.max(0, selectedTake.trimStartMs / 1_000);
        const trimEnd = Math.min(
          buffer.duration,
          (selectedTake.trimEndMs ?? selectedTake.durationMs ?? buffer.duration * 1_000) / 1_000,
        );
        if (trimEnd <= trimStart) {
          throw new Error(`${selectedTake.name}의 선택 구간이 실제 오디오 길이를 벗어났어요.`);
        }
        arrangement.push({
          id: `take:${selectedTake.id}`,
          buffer,
          offsetSeconds: selectedTake.offsetMs / 1_000,
          sourceOffsetSeconds: trimStart,
          durationSeconds: Math.max(0, trimEnd - trimStart),
        });
        if (!hasSoloTrack) waveformBuffer = buffer;
      }
    } else if (mode === "comp") {
      const segments: CompAudioSegment[] = compRows.flatMap((row) => {
        const buffer = buffers.get(`take:${row.takeId}`);
        if (!buffer) return [];
        if (row.endMs / 1_000 > buffer.duration + 0.001) {
          const takeName = takes.find((take) => take.id === row.takeId)?.name ?? "테이크";
          throw new Error(`${takeName}의 Comp 구간이 실제 오디오 길이를 벗어났어요.`);
        }
        return [{
          id: row.clientId,
          takeId: row.takeId,
          buffer,
          sourceStartSeconds: row.startMs / 1_000,
          sourceEndSeconds: row.endMs / 1_000,
        }];
      });
      arrangement.push(...buildCompTimeline(segments, { crossfadeSeconds: 0.01 }));
      waveformBuffer = hasSoloTrack ? null : segments[0]?.buffer ?? null;
    }

    for (const track of tracks) {
      const buffer = buffers.get(`track:${track.id}`);
      if (!buffer) continue;
      if (
        !waveformBuffer &&
        !track.muted &&
        (!hasSoloTrack || track.solo)
      ) {
        // Imported tracks intentionally keep durationMs=null in PostgreSQL.
        // Once decoded, their AudioBuffer is the source of truth for both the
        // visible waveform and the timeline duration.
        waveformBuffer = buffer;
      }
      arrangement.push({
        id: `track:${track.id}`,
        buffer,
        offsetSeconds: track.offsetMs / 1_000,
        volume: track.volume,
        pan: track.pan,
        muted: track.muted,
        solo: track.solo,
        fadeInSeconds: track.fadeInMs / 1_000,
        fadeOutSeconds: track.fadeOutMs / 1_000,
      });
    }
    setPreviewBuffer(waveformBuffer ?? decoded[0]?.buffer ?? null);
    return arrangement;
  }, [compRows, hasSoloTrack, selectedTake, takes, tracks]);

  const startRecordingMix = useCallback(async () => {
    if (studioActionLockRef.current.pending !== null) {
      throw new Error("진행 중인 스튜디오 작업이 끝난 뒤 녹음을 시작해주세요.");
    }
    const hasMainSource = sourceMode === "take" ? Boolean(selectedTake) : compRows.length > 0;
    const hasLocalArrangement = hasMainSource || tracks.length > 0;
    const hasYouTubeBacking = youtubeTransport?.isEnabled() ?? false;
    if (!hasLocalArrangement && !hasYouTubeBacking) {
      stopPreview();
      return 0;
    }
    stopPreview();
    const engine = engineRef.current;
    if (hasLocalArrangement && !engine) {
      throw new Error("오디오 엔진을 준비하지 못했어요.");
    }
    const arrangement = hasLocalArrangement
      ? await buildArrangement(sourceMode)
      : [];
    try {
      const playbackStartedAt: number[] = [];
      // YouTube cannot share Web Audio's clock. Treat it as the master
      // reference so a slow iframe never leaves the local mix running alone.
      if (hasYouTubeBacking) {
        await youtubeTransport?.start();
        playbackStartedAt.push(performance.now());
      }
      if (hasLocalArrangement && engine) {
        await engine.playTracks(arrangement, { fromSeconds: 0 });
        await engine.waitForPlaybackStart();
        playbackStartedAt.push(performance.now());
      }
      return playbackStartedAt.length > 0
        ? Math.max(0, performance.now() - Math.min(...playbackStartedAt))
        : 0;
    } catch (error) {
      youtubeTransport?.stop();
      engine?.clear();
      throw error;
    }
  }, [buildArrangement, compRows.length, selectedTake, sourceMode, stopPreview, tracks.length, youtubeTransport]);

  const stopRecordingMix = useCallback(() => {
    stopPreview();
    youtubeTransport?.stop();
  }, [stopPreview, youtubeTransport]);

  const primeRecordingMix = useCallback(async () => {
    if (studioActionLockRef.current.pending !== null) {
      throw new Error("진행 중인 스튜디오 작업이 끝난 뒤 녹음을 시작해주세요.");
    }
    stopPreview();
    await youtubeTransport?.prime();
  }, [stopPreview, youtubeTransport]);

  const recordingTransport = useMemo<AdvancedStudioRecordingTransport>(() => ({
    prime: primeRecordingMix,
    start: startRecordingMix,
    stop: stopRecordingMix,
  }), [primeRecordingMix, startRecordingMix, stopRecordingMix]);

  useEffect(() => {
    if (!onRecordingTransportReady) return;
    onRecordingTransportReady(recordingTransport);
    return () => onRecordingTransportReady(null);
  }, [onRecordingTransportReady, recordingTransport]);

  const playArrangement = useCallback(async (requestedMode: SourceMode = sourceMode) => {
    if (rejectLockedTransportInteraction()) return;
    if (!beginBusyAction("preview")) return;
    const engine = engineRef.current;
    setError(null);
    try {
      if (!engine) throw new Error("오디오 엔진을 준비하지 못했어요.");
      if (engine.state === "playing" && requestedMode === sourceMode) {
        engine.pause();
        return;
      }
      if (engine.state === "playing") engine.stop();
      if (
        (engine.state === "paused" || engine.state === "idle") &&
        engine.duration > 0 &&
        requestedMode === sourceMode
      ) {
        await engine.play();
      } else {
        const arrangement = await buildArrangement(requestedMode);
        setSourceMode(requestedMode);
        await engine.playTracks(arrangement, { fromSeconds: 0 });
      }
    } catch (playError) {
      if (!(playError instanceof DOMException && playError.name === "AbortError")) {
        setError(playError instanceof Error ? playError.message : "미리보기를 재생하지 못했어요.");
      }
    } finally {
      endBusyAction("preview");
    }
  }, [beginBusyAction, buildArrangement, endBusyAction, rejectLockedTransportInteraction, sourceMode]);

  const saveComp = useCallback(async () => {
    if (rejectLockedTransportInteraction()) return;
    if (!canMutateCompDraft(compHydrated)) {
      setError("Comp 구성을 먼저 불러와 주세요.");
      return;
    }
    const requestedRows = compRowsRef.current.map((row) => ({ ...row }));
    const requestedGeneration = compEditGenerationRef.current;
    const validationError = compValidationError(requestedRows, takes);
    if (validationError) {
      setError(validationError);
      return;
    }
    if (!beginBusyAction("comp")) return;
    setError(null);
    try {
      const expectedRevision = compRevisionRef.current;
      if (expectedRevision === null) {
        throw new Error("Comp 최신 버전을 불러온 뒤 다시 저장해주세요.");
      }
      const response = await fetch(`/api/riffs/${encodeURIComponent(riffId)}/comp`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          expectedRevision,
          segments: requestedRows.map(({ takeId, startMs, endMs }) => ({ takeId, startMs, endMs })),
        }),
      });
      if (response.status === 409) {
        const conflictRecovery = await refreshCompAfterDurableConflictDraft(
          () => persistCompDraft(compRowsRef.current),
          () => refreshComp(),
        );
        if (!conflictRecovery.durable) {
          throw new Error(
            "Comp 충돌이 발생했고 내 임시본을 브라우저에 보관하지 못했어요. 이 화면을 닫지 말고 다시 저장해주세요.",
          );
        }
        throw new Error(
          "다른 화면에서 Comp가 변경됐어요. 내 임시본을 보관했으니 최신 구성과 비교해주세요.",
        );
      }
      if (!response.ok) throw await responseError(response, "Comp를 저장하지 못했어요");
      const payload = normalizeCompPayload(await response.json());
      const savedRows = payload.rows;
      if (payload.revision === null) {
        throw new Error("저장된 Comp 버전을 확인하지 못했어요.");
      }
      compRevisionRef.current = payload.revision;
      compBaselineRef.current = compRowsSignature(savedRows);
      const currentCompStorageKey = ownedOutboxStorageKey(compDraftStorageKey);
      const previousOwnerId = previousOutboxOwnerIdRef.current;
      clearAppliedCompDraftOutboxes(
        browserStorage("local"),
        compDraftStorageKey,
        savedRows,
        [
          currentCompStorageKey,
          previousOwnerId
            ? ownerScopedOutboxKey(compDraftStorageKey, previousOwnerId)
            : null,
        ],
      );
      compDraftDurableRef.current = true;
      const latestRows = compRowsRef.current;
      if (shouldAcknowledgeCompSave(
        requestedRows,
        latestRows,
        requestedGeneration,
        compEditGenerationRef.current,
      )) {
        compRowsRef.current = savedRows;
        setCompRows(savedRows);
        setPendingCompDraft(null);
        setCompDraftStatus("saved");
        setMessage("Comp 구성을 저장했어요.");
      } else {
        // The response acknowledges only the snapshot sent above. Rebase edits
        // made while it was in flight onto the newly confirmed server revision.
        if (persistCompDraft(latestRows)) {
          setMessage("앞선 Comp 구성을 저장했고, 그 뒤의 편집은 임시본으로 유지했어요.");
        }
      }
      stopPreview();
    } catch (compError) {
      setError(compError instanceof Error ? compError.message : "Comp를 저장하지 못했어요.");
    } finally {
      endBusyAction("comp");
    }
  }, [
    compDraftStorageKey,
    compHydrated,
    beginBusyAction,
    endBusyAction,
    ownedOutboxStorageKey,
    persistCompDraft,
    rejectLockedTransportInteraction,
    refreshComp,
    riffId,
    stopPreview,
    takes,
  ]);

  const exportMix = useCallback(async () => {
    if (rejectLockedTransportInteraction()) return;
    if (!beginBusyAction("export")) return;
    setError(null);
    try {
      const arrangement = await buildArrangement(sourceMode);
      await mixdownAndDownload(arrangement, `riff-${riffId.slice(0, 8)}`, {
        normalize: true,
        bitDepth: 24,
      });
      setMessage("WAV 믹스를 만들었어요.");
    } catch (exportError) {
      if (!(exportError instanceof DOMException && exportError.name === "AbortError")) {
        setError(exportError instanceof Error ? exportError.message : "WAV를 만들지 못했어요.");
      }
    } finally {
      endBusyAction("export");
    }
  }, [beginBusyAction, buildArrangement, endBusyAction, rejectLockedTransportInteraction, riffId, sourceMode]);

  const addMarkerAtPlayhead = useCallback(async () => {
    if (markers.length >= MAX_MARKERS_PER_RIFF) {
      setError(`마커는 리프마다 ${MAX_MARKERS_PER_RIFF}개까지 추가할 수 있어요.`);
      return;
    }
    setMarkerBusy("add");
    setError(null);
    setMessage(null);
    try {
      const positionMs = Math.min(
        MAX_MARKER_POSITION_MS,
        Math.max(0, Math.round(visiblePlayhead * 1_000)),
      );
      const createInput = {
        positionMs,
        label: `구간 ${markers.length + 1}`,
        color: MARKER_COLORS[markers.length % MARKER_COLORS.length],
      };
      const operation = getOrCreateCreateRequest(
        createRequestRegistryRef.current,
        browserStorage("session"),
        "marker",
        riffId,
        markerCreateIntentFingerprint(createInput),
      );
      let marker: StudioMarker;
      let mayReconcile = true;
      try {
        const response = await fetch(`/api/riffs/${encodeURIComponent(riffId)}/markers`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ ...createInput, requestId: operation.requestId }),
        });
        if (response.status === 409) {
          mayReconcile = false;
          completeCreateRequest(
            createRequestRegistryRef.current,
            browserStorage("session"),
            operation,
          );
        }
        if (!response.ok) throw await responseError(response, "마커를 추가하지 못했어요");
        const payload: unknown = await response.json();
        const normalized = normalizeMarker(
          payload && typeof payload === "object" && "marker" in payload
            ? (payload as { marker: unknown }).marker
            : payload,
        );
        if (!normalized || normalized.clientRequestId !== operation.requestId) {
          throw new Error("추가된 마커 정보를 읽지 못했어요.");
        }
        marker = normalized;
      } catch (createError) {
        if (!mayReconcile) throw createError;
        const loaded = await refreshMarkers().catch(() => null);
        const reconciled = loaded?.find(
          (candidate) => candidate.clientRequestId === operation.requestId,
        );
        if (!reconciled) throw createError;
        marker = reconciled;
      }
      completeCreateRequest(
        createRequestRegistryRef.current,
        browserStorage("session"),
        operation,
      );
      markerKnowledgeGenerationRef.current += 1;
      markerConfirmedRevisionsRef.current.set(marker.id, marker.revision);
      setMarkers((current) => {
        const next = sortMarkers(current.some((item) => item.id === marker.id)
          ? current.map((item) => item.id === marker.id ? marker : item)
          : [...current, marker]);
        markersRef.current = next;
        return next;
      });
      setMessage(`${formatTime(marker.positionMs)}에 마커를 추가했어요.`);
    } catch (markerError) {
      setError(markerError instanceof Error ? markerError.message : "마커를 추가하지 못했어요.");
    } finally {
      if (mountedRef.current) setMarkerBusy(null);
    }
  }, [markers.length, refreshMarkers, riffId, visiblePlayhead]);

  const seekToMarker = useCallback(async (marker: StudioMarker) => {
    if (rejectLockedTransportInteraction()) return;
    const engine = engineRef.current;
    if (!engine) return;
    setError(null);
    try {
      if (engine.duration <= 0) {
        const hasMainSource = sourceMode === "take"
          ? Boolean(selectedTake)
          : compRows.length > 0;
        if (hasMainSource || tracks.length > 0) {
          const arrangement = await buildArrangement(sourceMode);
          engine.setTracks(arrangement);
        }
      }
      if (engine.duration > 0) {
        await engine.seek(marker.positionMs / 1_000);
        setPlayheadSeconds(engine.currentTime);
      } else {
        const positionSeconds = marker.positionMs / 1_000;
        setPlayheadSeconds(positionSeconds);
        setPlayback((current) => ({ ...current, currentTime: positionSeconds }));
      }
    } catch (seekError) {
      if (!(seekError instanceof DOMException && seekError.name === "AbortError")) {
        setError(seekError instanceof Error ? seekError.message : "마커 위치로 이동하지 못했어요.");
      }
    }
  }, [buildArrangement, compRows.length, rejectLockedTransportInteraction, selectedTake, sourceMode, tracks.length]);

  const updateMarkerInputDraft = useCallback((
    markerId: string,
    patch: MarkerInputDraft,
  ) => {
    setMarkerInputDrafts((current) => ({
      ...current,
      [markerId]: { ...current[markerId], ...patch },
    }));
  }, []);

  const clearMarkerInputDraft = useCallback((
    markerId: string,
    field: keyof MarkerInputDraft,
  ) => {
    setMarkerInputDrafts((current) => {
      const existing = current[markerId];
      if (!existing || existing[field] === undefined) return current;
      const nextDraft = { ...existing };
      delete nextDraft[field];
      const next = { ...current };
      if (Object.keys(nextDraft).length === 0) delete next[markerId];
      else next[markerId] = nextDraft;
      return next;
    });
  }, []);

  const saveMarkerLabel = useCallback((marker: StudioMarker, rawLabel: string) => {
    const label = cleanMarkerLabel(rawLabel);
    if (
      !label ||
      label.length > MAX_MARKER_LABEL_LENGTH ||
      /[\u0000-\u001f\u007f]/.test(label)
    ) {
      setError(`마커 이름은 1–${MAX_MARKER_LABEL_LENGTH}자의 짧은 문구로 입력해주세요.`);
      return false;
    }
    if (label !== marker.label) queueMarkerPatch(marker.id, { label });
    return true;
  }, [queueMarkerPatch]);

  const saveMarkerPosition = useCallback((marker: StudioMarker, rawSeconds: string) => {
    const seconds = Number(rawSeconds);
    if (
      !Number.isFinite(seconds) ||
      seconds < 0 ||
      seconds * 1_000 > MAX_MARKER_POSITION_MS
    ) {
      setError("마커 위치는 0초부터 24시간 사이로 입력해주세요.");
      return false;
    }
    const positionMs = Math.round(seconds * 1_000);
    if (positionMs !== marker.positionMs) {
      queueMarkerPatch(marker.id, { positionMs });
    }
    return true;
  }, [queueMarkerPatch]);

  const deleteMarker = useCallback(async (marker: StudioMarker) => {
    if (!window.confirm(`‘${marker.label}’ 마커를 삭제할까요?`)) return;
    const patchSnapshotsAtStart = collectMarkerPatchCopies(marker.id);
    setMarkerBusy(marker.id);
    setError(null);
    deletedMarkerIdsRef.current.add(marker.id);
    try {
      const pendingTimer = markerPatchTimersRef.current.get(marker.id);
      if (pendingTimer !== undefined) window.clearTimeout(pendingTimer);
      markerPatchTimersRef.current.delete(marker.id);
      markerPatchQueueRef.current.delete(marker.id);

      // A PATCH may already have reached the server. Wait briefly for its
      // confirmed revision so DELETE never silently removes a newer marker.
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (!markerPatchInFlightRef.current.has(marker.id)) break;
        await new Promise((resolve) => window.setTimeout(resolve, 20));
      }
      const revision =
        markerConfirmedRevisionsRef.current.get(marker.id) ?? marker.revision;
      const response = await fetch(`/api/markers/${encodeURIComponent(marker.id)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ revision }),
      });
      if (response.status === 409) {
        await refreshMarkers();
        setMarkerConflict(marker.id, true);
        throw new Error(
          "다른 화면에서 이 마커가 변경됐어요. 최신 값을 확인한 뒤 다시 삭제해주세요.",
        );
      }
      if (!response.ok) throw await responseError(response, "마커를 삭제하지 못했어요");
      markerKnowledgeGenerationRef.current += 1;
      suppressOutboxSnapshots(
        browserStorage("local"),
        markerPatchStorageKey,
        patchSnapshotsAtStart,
      );
      const timer = markerPatchTimersRef.current.get(marker.id);
      if (timer !== undefined) window.clearTimeout(timer);
      markerPatchTimersRef.current.delete(marker.id);
      markerPatchQueueRef.current.delete(marker.id);
      dirtyMarkerPatchesRef.current.delete(marker.id);
      markerConfirmedRevisionsRef.current.delete(marker.id);
      setMarkerConflict(marker.id, false);
      scheduleMarkerPatchPersistence();
      setMarkerInputDrafts((current) => {
        const next = { ...current };
        delete next[marker.id];
        return next;
      });
      setMarkers((current) => {
        const next = current.filter((item) => item.id !== marker.id);
        markersRef.current = next;
        return next;
      });
      setMessage(`${marker.label} 마커를 삭제했어요.`);
    } catch (deleteError) {
      const refreshed = await refreshMarkers().catch(() => null);
      if (refreshed && !refreshed.some((item) => item.id === marker.id)) {
        const timer = markerPatchTimersRef.current.get(marker.id);
        if (timer !== undefined) window.clearTimeout(timer);
        markerPatchTimersRef.current.delete(marker.id);
        markerPatchQueueRef.current.delete(marker.id);
        dirtyMarkerPatchesRef.current.delete(marker.id);
        markerConfirmedRevisionsRef.current.delete(marker.id);
        deletedMarkerIdsRef.current.delete(marker.id);
        setMarkerConflict(marker.id, false);
        scheduleMarkerPatchPersistence();
        setMarkerInputDrafts((current) => {
          const next = { ...current };
          delete next[marker.id];
          return next;
        });
        setMessage(`${marker.label} 마커를 삭제했어요.`);
        return;
      }
      deletedMarkerIdsRef.current.delete(marker.id);
      const dirtyEntry = dirtyMarkerPatchesRef.current.get(marker.id);
      if (dirtyEntry && !markerConflictIdsRef.current.has(marker.id)) {
        markerPatchQueueRef.current.set(marker.id, dirtyEntry.patch);
        void patchMarkerNow(marker.id);
      }
      setError(deleteError instanceof Error ? deleteError.message : "마커를 삭제하지 못했어요.");
    } finally {
      if (mountedRef.current) setMarkerBusy(null);
    }
  }, [
    collectMarkerPatchCopies,
    markerPatchStorageKey,
    patchMarkerNow,
    refreshMarkers,
    scheduleMarkerPatchPersistence,
    setMarkerConflict,
  ]);

  const requestPunch = useCallback(async () => {
    if (rejectLockedTransportInteraction()) return;
    const startMs = secondsToMs(punchStart);
    const endMs = secondsToMs(punchEnd);
    const effectivePreRollMs = Math.min(secondsToMs(preRoll), startMs);
    const request: PunchRequest = { startMs, endMs, preRollMs: effectivePreRollMs };
    if (request.endMs <= request.startMs) {
      setError("펀치 아웃은 펀치 인보다 뒤여야 해요.");
      return;
    }
    if (!onPunchRequest) {
      setError("펀치 녹음을 시작할 기본 녹음 화면이 연결되지 않았어요.");
      return;
    }
    const hasLiveInput = Boolean(
      sharedStream?.getAudioTracks().some((track) => track.readyState === "live"),
    );
    if (!hasLiveInput) {
      setError("상단에서 오디오 입력을 먼저 연결해주세요.");
      return;
    }
    if (!beginBusyAction("punch")) return;
    setError(null);
    try {
      stopPreview();
      const engine = engineRef.current;
      if (!engine) throw new Error("오디오 엔진을 준비하지 못했어요.");
      const arrangement = await buildArrangement(sourceMode);
      await engine.playTracks(arrangement, {
        fromSeconds: Math.max(0, request.startMs - request.preRollMs) / 1_000,
      });
      await engine.waitForPlaybackStart();
      clearPunchPlaybackTimer();
      punchPlaybackTimerRef.current = window.setTimeout(() => {
        punchPlaybackTimerRef.current = null;
        if (mountedRef.current) setPunchPlaybackActive(false);
        engine.stop();
      }, request.preRollMs + (request.endMs - request.startMs));
      setPunchPlaybackActive(true);
      await onPunchRequest(request);
      setMessage(`${formatTime(request.startMs)}–${formatTime(request.endMs)} 펀치 구간을 준비했어요.`);
    } catch (punchError) {
      stopPreview();
      setError(punchError instanceof Error ? punchError.message : "펀치 녹음을 준비하지 못했어요.");
    } finally {
      endBusyAction("punch");
    }
  }, [
    beginBusyAction,
    buildArrangement,
    clearPunchPlaybackTimer,
    endBusyAction,
    onPunchRequest,
    preRoll,
    punchEnd,
    punchStart,
    rejectLockedTransportInteraction,
    sharedStream,
    sourceMode,
    stopPreview,
  ]);

  const addCompRow = useCallback(() => {
    if (rejectLockedTransportInteraction()) return;
    if (!canMutateCompDraft(compHydrated)) {
      setError("Comp 구성을 먼저 불러와 주세요.");
      return;
    }
    const take = selectedTake ?? takes[0];
    if (!take) {
      setError("먼저 테이크를 녹음해주세요.");
      return;
    }
    const next = [...compRows, {
      clientId: newClientId(),
      takeId: take.id,
      startMs: take.trimStartMs,
      endMs: Math.max(take.trimStartMs + 1, takeDuration(take)),
    }];
    setCompRows(next);
    persistCompDraft(next);
    stopPreview();
  }, [compHydrated, compRows, persistCompDraft, rejectLockedTransportInteraction, selectedTake, stopPreview, takes]);

  const updateCompRow = useCallback((clientId: string, patch: Partial<CompDraftRow>) => {
    if (rejectLockedTransportInteraction()) return;
    if (!canMutateCompDraft(compHydrated)) {
      setError("Comp 구성을 먼저 불러와 주세요.");
      return;
    }
    const next = compRows.map((row) => row.clientId === clientId ? { ...row, ...patch } : row);
    setCompRows(next);
    persistCompDraft(next);
    stopPreview();
  }, [compHydrated, compRows, persistCompDraft, rejectLockedTransportInteraction, stopPreview]);

  const moveCompRow = useCallback((index: number, direction: -1 | 1) => {
    if (rejectLockedTransportInteraction()) return;
    if (!canMutateCompDraft(compHydrated)) {
      setError("Comp 구성을 먼저 불러와 주세요.");
      return;
    }
    const target = index + direction;
    if (target < 0 || target >= compRows.length) return;
    const next = [...compRows];
    const [row] = next.splice(index, 1);
    if (row) next.splice(target, 0, row);
    setCompRows(next);
    persistCompDraft(next);
    stopPreview();
  }, [compHydrated, compRows, persistCompDraft, rejectLockedTransportInteraction, stopPreview]);

  const deleteCompRow = useCallback((clientId: string) => {
    if (rejectLockedTransportInteraction()) return;
    if (!canMutateCompDraft(compHydrated)) {
      setError("Comp 구성을 먼저 불러와 주세요.");
      return;
    }
    const next = compRows.filter((row) => row.clientId !== clientId);
    setCompRows(next);
    persistCompDraft(next);
    stopPreview();
  }, [compHydrated, compRows, persistCompDraft, rejectLockedTransportInteraction, stopPreview]);

  const selectSourceMode = useCallback((mode: SourceMode) => {
    if (rejectLockedTransportInteraction()) return;
    stopPreview();
    setSourceMode(mode);
  }, [rejectLockedTransportInteraction, stopPreview]);

  const selectTake = useCallback((takeId: string) => {
    if (rejectLockedTransportInteraction()) return;
    stopPreview();
    setSelectedTakeId(takeId);
  }, [rejectLockedTransportInteraction, stopPreview]);

  const seekFromWaveform = useCallback((seconds: number) => {
    if (rejectLockedTransportInteraction()) return;
    void engineRef.current?.seek(seconds);
  }, [rejectLockedTransportInteraction]);

  const transportLabel = playback.state === "playing" ? "일시정지" : playback.state === "paused" ? "계속 재생" : "믹스 재생";
  const isLoadingPreview = busy === "preview";
  const studioActionBusy = busy !== null || markerBusy !== null;
  const studioControlsLocked = studioTransportLocked || studioActionBusy;

  return (
    <section
      className={`${styles.tools} ${className ?? ""}`}
      aria-labelledby={sectionId}
      aria-busy={studioControlsLocked || undefined}
    >
      <header className={styles.header}>
        <div>
          <span className={styles.eyebrow}><SlidersHorizontal size={13} aria-hidden="true" /> Advanced studio</span>
          <h2 id={sectionId}>트랙 · Comp · 마커 · 펀치</h2>
        </div>
        <div className={styles.badges} aria-label="프로젝트 박자 정보">
          <span>{Math.round(bpm || 120)} BPM</span>
          <span>{timeSignature || "4/4"}</span>
        </div>
      </header>

      <div className={styles.transport}>
        <div className={styles.sourceChoice} role="radiogroup" aria-label="메인 기타 소스">
          <label>
            <input
              type="radio"
              name={`${sectionId}-source`}
              checked={sourceMode === "take"}
              disabled={studioControlsLocked}
              onChange={() => selectSourceMode("take")}
            />
            선택 테이크
          </label>
          <label>
            <input
              type="radio"
              name={`${sectionId}-source`}
              checked={sourceMode === "comp"}
              disabled={studioControlsLocked}
              onChange={() => selectSourceMode("comp")}
            />
            Comp
          </label>
        </div>

        <select
          className={styles.takeSelect}
          value={effectiveTakeId}
          onChange={(event) => selectTake(event.target.value)}
          aria-label="재생할 테이크"
          disabled={takes.length === 0 || studioControlsLocked}
        >
          {takes.length === 0 ? <option value="">테이크 없음</option> : null}
          {takes.map((take) => <option key={take.id} value={take.id}>{take.name}</option>)}
        </select>

        <div className={styles.transportButtons}>
          <button
            type="button"
            className={styles.playButton}
            onClick={() => void playArrangement()}
            disabled={studioControlsLocked}
          >
            {isLoadingPreview ? <LoaderCircle className={styles.spin} size={16} aria-hidden="true" /> : playback.state === "playing" ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
            {transportLabel}
          </button>
          <button
            type="button"
            className={styles.iconButton}
            onClick={stopPreviewFromUser}
            aria-label="재생 정지"
            disabled={studioControlsLocked}
          >
            <Square size={14} aria-hidden="true" />
          </button>
          <button type="button" className={styles.exportButton} onClick={() => void exportMix()} disabled={studioControlsLocked}>
            {busy === "export" ? <LoaderCircle className={styles.spin} size={15} aria-hidden="true" /> : <Download size={15} aria-hidden="true" />}
            WAV
          </button>
        </div>
      </div>

      <div className={styles.waveformWrap}>
        <WaveformCanvas
          source={previewBuffer}
          durationSeconds={playback.duration || (selectedTake?.durationMs ?? 0) / 1_000}
          playheadSeconds={visiblePlayhead}
          selection={{
            startSeconds: secondsToMs(punchStart) / 1_000,
            endSeconds: secondsToMs(punchEnd) / 1_000,
          }}
          height={88}
          label="현재 믹스의 파형과 펀치 구간"
          onSeek={studioControlsLocked ? undefined : seekFromWaveform}
        />
        <span>{formatTime(visiblePlayhead * 1_000)} / {formatTime(playback.duration * 1_000)}</span>
      </div>

      <section className={styles.markerPanel} aria-labelledby={`${sectionId}-markers`}>
        <div className={styles.markerHeader}>
          <div>
            <Flag size={14} aria-hidden="true" />
            <h3 id={`${sectionId}-markers`}>구간 마커</h3>
            <span>{markers.length}/{MAX_MARKERS_PER_RIFF}</span>
          </div>
          <button
            type="button"
            onClick={() => void addMarkerAtPlayhead()}
            disabled={studioControlsLocked || markers.length >= MAX_MARKERS_PER_RIFF}
          >
            {markerBusy === "add"
              ? <LoaderCircle className={styles.spin} size={13} aria-hidden="true" />
              : <Plus size={13} aria-hidden="true" />}
            현재 위치에 추가
          </button>
        </div>

        <div
          className={styles.markerLane}
          aria-label="타임라인 구간 마커"
          role={markers.length > 0 ? "list" : undefined}
        >
          <span
            className={styles.markerPlayhead}
            style={{ left: `${markerPositionPercent(visiblePlayhead * 1_000, markerTimelineDurationMs)}%` }}
            aria-hidden="true"
          />
          {markers.length === 0 ? (
            <p>재생 위치를 정한 뒤 마커를 추가해보세요.</p>
          ) : markers.map((marker) => {
            const position = markerPositionPercent(
              marker.positionMs,
              markerTimelineDurationMs,
            );
            return (
              <span
                className={styles.markerPoint}
                data-edge={position <= 8 ? "start" : position >= 92 ? "end" : undefined}
                style={{ left: `${position}%` }}
                role="listitem"
                key={marker.id}
              >
                <button
                  type="button"
                  data-color={marker.color}
                  title={`${marker.label} · ${formatTime(marker.positionMs)}`}
                  aria-label={`${marker.label}, ${formatTime(marker.positionMs)}로 이동`}
                  disabled={studioControlsLocked}
                  onClick={() => void seekToMarker(marker)}
                >
                  <Flag size={11} aria-hidden="true" />
                  <span>{marker.label}</span>
                </button>
              </span>
            );
          })}
        </div>

        {markers.length > 0 ? (
          <div className={styles.markerList} aria-label="마커 편집 목록" role="list">
            {markers.map((marker) => (
              <article
                className={styles.markerRow}
                data-color={marker.color}
                data-conflict={markerConflictIds.has(marker.id) || undefined}
                role="listitem"
                key={marker.id}
              >
                <button
                  type="button"
                  className={styles.markerSeek}
                  onClick={() => void seekToMarker(marker)}
                  aria-label={`${marker.label} 위치로 이동`}
                  disabled={studioControlsLocked}
                >
                  <Flag size={13} aria-hidden="true" />
                  <time>{formatTime(marker.positionMs)}</time>
                  {markerConflictIds.has(marker.id)
                    ? <span className={styles.markerConflictBadge}>확인</span>
                    : null}
                </button>
                <label>
                  <span className="sr-only">마커 이름</span>
                  <input
                    type="text"
                    value={markerInputDrafts[marker.id]?.label ?? marker.label}
                    maxLength={MAX_MARKER_LABEL_LENGTH}
                    aria-label={`${formatTime(marker.positionMs)} 마커 이름`}
                    disabled={studioControlsLocked}
                    onChange={(event) => updateMarkerInputDraft(marker.id, {
                      label: event.target.value,
                    })}
                    onBlur={(event) => {
                      saveMarkerLabel(marker, event.currentTarget.value);
                      clearMarkerInputDraft(marker.id, "label");
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.currentTarget.blur();
                      if (event.key === "Escape") {
                        event.currentTarget.value = marker.label;
                        clearMarkerInputDraft(marker.id, "label");
                        event.currentTarget.blur();
                      }
                    }}
                  />
                </label>
                <label className={styles.markerPosition}>
                  <span className="sr-only">{marker.label} 위치</span>
                  <input
                    type="number"
                    min="0"
                    max="86400"
                    step="0.01"
                    value={markerInputDrafts[marker.id]?.position ?? marker.positionMs / 1_000}
                    aria-label={`${marker.label} 위치(초)`}
                    disabled={studioControlsLocked}
                    onChange={(event) => updateMarkerInputDraft(marker.id, {
                      position: event.target.value,
                    })}
                    onBlur={(event) => {
                      saveMarkerPosition(marker, event.currentTarget.value);
                      clearMarkerInputDraft(marker.id, "position");
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.currentTarget.blur();
                      if (event.key === "Escape") {
                        event.currentTarget.value = String(marker.positionMs / 1_000);
                        clearMarkerInputDraft(marker.id, "position");
                        event.currentTarget.blur();
                      }
                    }}
                  />
                  <em>초</em>
                </label>
                <select
                  value={marker.color}
                  aria-label={`${marker.label} 색상`}
                  disabled={studioControlsLocked}
                  onChange={(event) => queueMarkerPatch(marker.id, {
                    color: event.target.value as MarkerColor,
                  })}
                >
                  {MARKER_COLORS.map((color) => (
                    <option value={color} key={color}>{MARKER_COLOR_LABELS[color]}</option>
                  ))}
                </select>
                <button
                  type="button"
                  className={styles.markerDelete}
                  onClick={() => void deleteMarker(marker)}
                  disabled={studioControlsLocked}
                  aria-label={`${marker.label} 마커 삭제`}
                >
                  {markerBusy === marker.id
                    ? <LoaderCircle className={styles.spin} size={13} aria-hidden="true" />
                    : <Trash2 size={13} aria-hidden="true" />}
                </button>
              </article>
            ))}
          </div>
        ) : null}
      </section>

      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      {message ? <p className={styles.message} role="status">{message}</p> : null}

      <div className={styles.columns}>
        <section className={styles.panel} aria-labelledby={`${sectionId}-tracks`}>
          <div className={styles.panelHeader}>
            <div>
              <AudioLines size={15} aria-hidden="true" />
              <h3 id={`${sectionId}-tracks`}>여러 트랙</h3>
              <span>{tracks.length}</span>
            </div>
            <div className={styles.uploadActions}>
              <select value={uploadKind} disabled={studioControlsLocked} onChange={(event) => setUploadKind(event.target.value as StudioTrack["kind"])} aria-label="추가할 트랙 종류">
                <option value="backing">반주</option>
                <option value="guitar">기타</option>
              </select>
              <label htmlFor={fileInputId} className={styles.uploadButton} aria-disabled={studioControlsLocked}>
                {busy === "upload" ? <LoaderCircle className={styles.spin} size={14} /> : <Upload size={14} />}
                파일 추가
              </label>
              <input
                id={fileInputId}
                className={styles.hiddenInput}
                type="file"
                accept={AUDIO_TRACK_IMPORT_ACCEPT}
                aria-describedby={`${fileInputId}-help`}
                multiple
                disabled={studioControlsLocked}
                onChange={(event) => {
                  const files = Array.from(event.target.files ?? []);
                  event.target.value = "";
                  void uploadTrackFiles(files, uploadKind);
                }}
              />
            </div>
          </div>

          <p className={styles.importHelp} id={`${fileInputId}-help`}>
            {AUDIO_TRACK_IMPORT_HELP}
          </p>

          <div className={styles.promoteRow}>
            <span><Guitar size={14} aria-hidden="true" /> 녹음한 테이크를 겹쳐 쓸 수 있어요.</span>
            <button type="button" onClick={() => void promoteSelectedTake()} disabled={!selectedTake || studioControlsLocked}>
              {busy === "promote" ? <LoaderCircle className={styles.spin} size={13} /> : <Plus size={13} />}
              선택 테이크를 기타 트랙으로
            </button>
          </div>

          <div className={styles.trackList}>
            {tracks.length === 0 ? (
              <p className={styles.empty}>반주 파일을 추가하거나, 녹음한 테이크를 기타 트랙으로 바꿔보세요.</p>
            ) : tracks.map((track) => (
              <article
                className={styles.track}
                data-inactive={track.muted || (hasSoloTrack && !track.solo) || undefined}
                data-conflict={trackConflictIds.has(track.id) || undefined}
                aria-busy={trackResolutionIds.has(track.id) || undefined}
                key={track.id}
              >
                <div className={styles.trackTitle}>
                  <span data-kind={track.kind}>{track.kind === "guitar" ? <Guitar size={14} /> : <AudioLines size={14} />}</span>
                  <div>
                    <strong>{track.name}</strong>
                    <small>
                      {trackKindLabel(track.kind)} · {track.durationMs === null ? "길이 자동" : formatTime(track.durationMs)}
                      {track.solo ? " · 솔로" : track.muted ? " · 음소거" : ""}
                    </small>
                  </div>
                  <div className={styles.trackToggles} role="group" aria-label={`${track.name} 재생 상태`}>
                    <button
                      type="button"
                      className={styles.trackToggle}
                      data-mode="mute"
                      aria-label={`${track.name} 음소거 ${track.muted ? "해제" : "켜기"}`}
                      aria-pressed={track.muted}
                      title="음소거"
                      disabled={studioControlsLocked || trackResolutionIds.has(track.id)}
                      onClick={() => {
                        const muted = !track.muted;
                        queueTrackPatch(track.id, muted ? { muted, solo: false } : { muted });
                      }}
                    >
                      M
                    </button>
                    <button
                      type="button"
                      className={styles.trackToggle}
                      data-mode="solo"
                      aria-label={`${track.name} 솔로 ${track.solo ? "해제" : "켜기"}`}
                      aria-pressed={track.solo}
                      title="솔로"
                      disabled={studioControlsLocked || trackResolutionIds.has(track.id)}
                      onClick={() => {
                        const solo = !track.solo;
                        queueTrackPatch(track.id, solo ? { solo, muted: false } : { solo });
                      }}
                    >
                      S
                    </button>
                  </div>
                  <button type="button" onClick={() => void deleteTrack(track)} disabled={studioControlsLocked || trackResolutionIds.has(track.id)} aria-label={`${track.name} 삭제`}><Trash2 size={14} /></button>
                </div>
                <div className={styles.mixerGrid}>
                  <label>
                    <span>볼륨 <output>{Math.round(track.volume * 100)}%</output></span>
                    <input type="range" min="0" max="2" step="0.01" value={track.volume} disabled={studioControlsLocked || trackResolutionIds.has(track.id)} onChange={(event) => queueTrackPatch(track.id, { volume: Number(event.target.value) })} />
                  </label>
                  <label>
                    <span>팬 <output>{track.pan === 0 ? "C" : `${track.pan < 0 ? "L" : "R"}${Math.round(Math.abs(track.pan) * 100)}`}</output></span>
                    <input type="range" min="-1" max="1" step="0.01" value={track.pan} disabled={studioControlsLocked || trackResolutionIds.has(track.id)} onChange={(event) => queueTrackPatch(track.id, { pan: Number(event.target.value) })} />
                  </label>
                  <label className={styles.numberControl}>
                    <span>시작 위치</span>
                    <input type="number" min="0" max="86400" step="0.01" value={track.offsetMs / 1_000} disabled={studioControlsLocked || trackResolutionIds.has(track.id)} onChange={(event) => queueTrackPatch(track.id, { offsetMs: secondsToMs(event.target.value) })} />
                    <em>초</em>
                  </label>
                  <label className={styles.numberControl}>
                    <span>페이드 인</span>
                    <input type="number" min="0" max="3600" step="0.01" value={track.fadeInMs / 1_000} disabled={studioControlsLocked || trackResolutionIds.has(track.id)} onChange={(event) => queueTrackPatch(track.id, { fadeInMs: secondsToMs(event.target.value) })} />
                    <em>초</em>
                  </label>
                  <label className={styles.numberControl}>
                    <span>페이드 아웃</span>
                    <input type="number" min="0" max="3600" step="0.01" value={track.fadeOutMs / 1_000} disabled={studioControlsLocked || trackResolutionIds.has(track.id)} onChange={(event) => queueTrackPatch(track.id, { fadeOutMs: secondsToMs(event.target.value) })} />
                    <em>초</em>
                  </label>
                </div>
                {trackConflictIds.has(track.id) ? (
                  <div className={styles.trackConflict} role="alert">
                    <span>다른 창의 변경과 겹쳤어요. 내 설정은 보관 중이에요.</span>
                    <button
                      type="button"
                      onClick={() => void acceptServerTrackVersion(track.id)}
                      disabled={studioControlsLocked || trackResolutionIds.has(track.id)}
                    >
                      {trackResolutionIds.has(track.id) ? "최신 설정 불러오는 중…" : "다른 창의 설정 사용"}
                    </button>
                    <button
                      type="button"
                      onClick={() => rebaseLocalTrackPatch(track.id)}
                      disabled={studioControlsLocked || trackResolutionIds.has(track.id)}
                    >
                      내 설정으로 저장
                    </button>
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        </section>

        <div className={styles.sidePanels}>
          <section className={styles.panel} aria-labelledby={`${sectionId}-punch`}>
            <div className={styles.panelHeader}>
              <div><Scissors size={15} /><h3 id={`${sectionId}-punch`}>펀치 인·아웃</h3></div>
            </div>
            <div className={styles.punchGrid}>
              <label><span>IN</span><input type="number" min="0" step="0.01" value={punchStart} disabled={studioControlsLocked} onChange={(event) => setPunchStart(event.target.value)} /><em>초</em></label>
              <label><span>OUT</span><input type="number" min="0" step="0.01" value={punchEnd} disabled={studioControlsLocked} onChange={(event) => setPunchEnd(event.target.value)} /><em>초</em></label>
              <label><span>프리롤</span><input type="number" min="0" step="0.01" value={preRoll} disabled={studioControlsLocked} onChange={(event) => setPreRoll(event.target.value)} /><em>초</em></label>
              <button type="button" onClick={() => void requestPunch()} disabled={studioControlsLocked || !onPunchRequest || !hasReadySharedStream}>
                {busy === "punch" ? <LoaderCircle className={styles.spin} size={14} /> : <Scissors size={14} />}
                이 구간 녹음
              </button>
            </div>
            <p className={styles.help}>
              {hasReadySharedStream
                ? `${beatsPerBar}박자 프리롤 뒤 지정 구간만 새 테이크로 녹음합니다.`
                : "먼저 상단에서 오디오 입력을 연결해주세요."}
            </p>
          </section>

          <details className={styles.tunerDetails}>
            <summary>기타 튜너</summary>
            <GuitarTuner stream={sharedStream} />
          </details>
        </div>
      </div>

      <section
        className={`${styles.panel} ${styles.compPanel}`}
        aria-labelledby={`${sectionId}-comp`}
        aria-busy={!compHydrated || undefined}
      >
        <div className={styles.panelHeader}>
          <div>
            <Layers3 size={15} />
            <h3 id={`${sectionId}-comp`}>Comp 편집</h3>
            <span>{compRows.length}</span>
            <small
              className={styles.compDraftStatus}
              data-status={compDraftStatus}
              role="status"
            >
              {!compHydrated
                ? busy === "tracks" || busy === "comp"
                  ? "불러오는 중"
                  : "불러오기 필요"
                : compDraftStatus === "saved"
                ? "저장됨"
                : compDraftStatus === "unsaved"
                  ? "저장 안 됨"
                  : "임시본 확인 필요"}
            </small>
          </div>
          <div className={styles.compActions}>
            {!compHydrated && busy !== "tracks" ? (
              <button
                type="button"
                onClick={() => void retryCompHydration()}
                disabled={studioActionBusy}
              >
                {busy === "comp" ? "다시 불러오는 중…" : "Comp 다시 불러오기"}
              </button>
            ) : null}
            {compDraftStatus === "conflict" ? (
              <>
                <button type="button" onClick={restorePendingCompDraft} disabled={studioControlsLocked || !compHydrated}>임시본 불러오기</button>
                <button type="button" onClick={discardPendingCompDraft} disabled={studioControlsLocked || !compHydrated}>임시본 버리기</button>
              </>
            ) : null}
            <button type="button" onClick={addCompRow} disabled={studioControlsLocked || !compHydrated}><Plus size={14} /> 구간</button>
            <button type="button" onClick={() => void playArrangement("comp")} disabled={studioControlsLocked || !compHydrated || compRows.length === 0}><Play size={14} /> 미리듣기</button>
            <button type="button" className={styles.primaryAction} onClick={() => void saveComp()} disabled={studioControlsLocked || !compHydrated || compDraftStatus === "conflict"}><Save size={14} /> 저장</button>
          </div>
        </div>
        <div className={styles.compTable} aria-label="Comp 구간 목록">
          <div className={styles.compHeading}><span>순서</span><span>테이크</span><span>시작</span><span>끝</span><span>작업</span></div>
          {compRows.length === 0 ? <p className={styles.empty}>좋은 구간만 골라 순서대로 이어 붙일 수 있어요.</p> : compRows.map((row, index) => (
            <div className={styles.compRow} key={row.clientId}>
              <div className={styles.orderButtons}>
                <b>{index + 1}</b>
                <button type="button" onClick={() => moveCompRow(index, -1)} disabled={studioControlsLocked || !compHydrated || index === 0} aria-label={`${index + 1}번 구간 위로`}><ChevronUp size={13} /></button>
                <button type="button" onClick={() => moveCompRow(index, 1)} disabled={studioControlsLocked || !compHydrated || index === compRows.length - 1} aria-label={`${index + 1}번 구간 아래로`}><ChevronDown size={13} /></button>
              </div>
              <select value={row.takeId} disabled={studioControlsLocked || !compHydrated} onChange={(event) => updateCompRow(row.clientId, { takeId: event.target.value })} aria-label={`${index + 1}번 구간 테이크`}>
                {takes.map((take) => <option value={take.id} key={take.id}>{take.name}</option>)}
              </select>
              <label><span className="sr-only">{index + 1}번 시작 초</span><input type="number" min="0" step="0.01" value={row.startMs / 1_000} disabled={studioControlsLocked || !compHydrated} onChange={(event) => updateCompRow(row.clientId, { startMs: secondsToMs(event.target.value) })} /><em>초</em></label>
              <label><span className="sr-only">{index + 1}번 끝 초</span><input type="number" min="0" step="0.01" value={row.endMs / 1_000} disabled={studioControlsLocked || !compHydrated} onChange={(event) => updateCompRow(row.clientId, { endMs: secondsToMs(event.target.value) })} /><em>초</em></label>
              <button type="button" className={styles.deleteComp} onClick={() => deleteCompRow(row.clientId)} disabled={studioControlsLocked || !compHydrated} aria-label={`${index + 1}번 Comp 구간 삭제`}><Trash2 size={14} /></button>
            </div>
          ))}
        </div>
      </section>
    </section>
  );
}
