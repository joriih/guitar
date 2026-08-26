"use client";

import {
  AlertCircle,
  AudioLines,
  BookOpenText,
  Check,
  Copy,
  Download,
  Headphones,
  LoaderCircle,
  Mic,
  Pause,
  Play,
  Radio,
  RefreshCw,
  Repeat2,
  RotateCcw,
  Save,
  Scissors,
  Settings2,
  Square,
  Star,
  Timer,
  Trash2,
  Volume2,
  WandSparkles,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import { MetronomeScheduler } from "@/components/audio-engine";
import {
  AdvancedStudioTools,
  type AdvancedStudioRecordingTransport,
  type PunchRequest,
} from "@/components/advanced-studio";

import styles from "./RecordingStudio.module.css";
import {
  createPendingRecordingId,
  deletePendingRecording,
  listPendingRecordings,
  recoveryStorageErrorMessage,
  requestPersistentRecordingStorage,
  savePendingRecording,
  type StoredPendingRecording,
} from "./recovery-store";
import type {
  CaptureState,
  MicrophoneState,
  RecordingStudioProps,
  RecordingTake,
} from "./types";
import {
  classifyRiffPatchRecovery,
  clearAppliedRiffPatchOutboxes,
  createRiffPatchOwner,
  discardRiffPatchSources,
  persistRiffPatchOutbox,
  readRiffPatchOutboxWithSources,
  type RiffPatchOwner,
  type RiffPatchSourceSnapshot,
  type RiffPatchStorage,
} from "./riff-patch-outbox";
import {
  createCompatibleMediaRecorder,
  createClientRecordingId,
  createTakeMutationLock,
  createTapTempoState,
  captureLocksStudioTransport,
  completeTakeDuplicateRequest,
  extensionForMimeType,
  extractTakes,
  formatBytes,
  formatCreatedAt,
  formatDuration,
  isEditableTarget,
  getOrCreateTakeDuplicateRequest,
  nextCycleDeadline,
  normalizeTake,
  preferredRecorderMimeType,
  registerTapTempo,
  responseError,
  type TapTempoState,
} from "./utils";
import {
  conflictCurrent,
  deletionAlreadyApplied,
  mutationAlreadyApplied,
  nonnegativeRevision,
  reconciledTakeDuplicate,
  reconciledTakeSplit,
} from "@/lib/mutation-reconciliation";

type RecordingDraft = {
  id: string;
  blob: Blob;
  durationMs: number;
  mimeType: string;
  objectUrl: string;
  offsetMs: number;
  createdAt: number;
};

type TimingDraft = {
  trimStartMs: string;
  trimEndMs: string;
  offsetMs: string;
};

type TapTempoFeedback = {
  label: string;
  announcement: string;
};

type RiffServerSnapshot = {
  id: string;
  title: string;
  bpm: number;
  musicalKey: string;
  tuning: string;
  timeSignature: string;
  notes: string;
  tab: string;
  revision: number;
};

type RiffPatchConflict = {
  current: RiffServerSnapshot;
  localPatch: Record<string, unknown>;
};

const EMPTY_TIMING: TimingDraft = {
  trimStartMs: "0",
  trimEndMs: "",
  offsetMs: "0",
};

const RECOVERY_SNAPSHOT_INTERVAL_MS = 5_000;
const MAX_SAFE_RECORDING_BYTES = 95 * 1024 * 1024;

function browserStorage(kind: "localStorage" | "sessionStorage"): RiffPatchStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window[kind];
  } catch {
    return null;
  }
}

const documentRiffPatchOwners = new Map<string, RiffPatchOwner>();

function getDocumentRiffPatchOwner(riffId: string): RiffPatchOwner {
  const existing = documentRiffPatchOwners.get(riffId);
  if (existing) return existing;
  const owner = createRiffPatchOwner(
    browserStorage("sessionStorage"),
    riffId,
    createClientRecordingId,
  );
  documentRiffPatchOwners.set(riffId, owner);
  return owner;
}

function normalizeRiffSnapshot(value: unknown): RiffServerSnapshot | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const candidate =
    typeof record.riff === "object" && record.riff !== null && !Array.isArray(record.riff)
      ? (record.riff as Record<string, unknown>)
      : record;
  const revision = nonnegativeRevision(candidate.revision);
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.title !== "string" ||
    typeof candidate.bpm !== "number" ||
    typeof candidate.musicalKey !== "string" ||
    typeof candidate.tuning !== "string" ||
    typeof candidate.timeSignature !== "string" ||
    typeof candidate.notes !== "string" ||
    typeof candidate.tab !== "string" ||
    revision === null
  ) {
    return null;
  }
  return {
    id: candidate.id,
    title: candidate.title,
    bpm: candidate.bpm,
    musicalKey: candidate.musicalKey,
    tuning: candidate.tuning,
    timeSignature: candidate.timeSignature,
    notes: candidate.notes,
    tab: candidate.tab,
    revision,
  };
}

function sanitizeLocalRiffPatch(value: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (typeof value.title === "string" && value.title.trim() && value.title.length <= 120) {
    patch.title = value.title;
  }
  if (
    typeof value.bpm === "number" &&
    Number.isInteger(value.bpm) &&
    value.bpm >= 30 &&
    value.bpm <= 300
  ) {
    patch.bpm = value.bpm;
  }
  for (const [key, maximum] of [
    ["musicalKey", 20],
    ["tuning", 40],
    ["notes", 20_000],
    ["tab", 100_000],
  ] as const) {
    const field = value[key];
    if (typeof field === "string" && field.length <= maximum) patch[key] = field;
  }
  if (
    typeof value.timeSignature === "string" &&
    value.timeSignature.length <= 12 &&
    isValidTimeSignature(value.timeSignature)
  ) {
    patch.timeSignature = value.timeSignature.trim();
  }
  return patch;
}

function microphoneMessage(state: MicrophoneState, hasStream: boolean): string {
  if (hasStream) return "입력 준비됨";
  switch (state) {
    case "requesting":
      return "마이크 연결 중";
    case "denied":
      return "마이크 권한이 필요해요";
    case "unavailable":
      return "사용할 수 있는 오디오 입력이 없어요";
    case "error":
      return "오디오 입력을 확인해 주세요";
    default:
      return "마이크를 연결해 주세요";
  }
}

function mediaErrorMessage(error: unknown): {
  state: MicrophoneState;
  message: string;
} {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "SecurityError") {
      return {
        state: "denied",
        message:
          "마이크 접근이 차단되어 있어요. 브라우저 주소창의 마이크 권한을 허용해 주세요.",
      };
    }
    if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") {
      return {
        state: "unavailable",
        message: "연결된 마이크나 오디오 인터페이스를 찾지 못했어요.",
      };
    }
    if (error.name === "NotReadableError" || error.name === "TrackStartError") {
      return {
        state: "error",
        message: "다른 앱이 오디오 입력을 사용 중인지 확인해 주세요.",
      };
    }
  }

  return {
    state: "error",
    message: error instanceof Error ? error.message : "마이크를 시작하지 못했어요.",
  };
}

function canRetryWithDefaultInput(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === "OverconstrainedError" ||
      error.name === "ConstraintNotSatisfiedError" ||
      error.name === "NotFoundError" ||
      error.name === "DevicesNotFoundError")
  );
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function numberFromInput(value: string, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : fallback;
}

function isValidTimeSignature(value: string): boolean {
  const match = /^(\d{1,2})\/(1|2|4|8|16|32)$/.exec(value.trim());
  if (!match) return false;
  const beats = Number(match[1]);
  return beats >= 1 && beats <= 32;
}

function storedDraft(draft: RecordingDraft, riffId: string): StoredPendingRecording {
  return {
    id: draft.id,
    riffId,
    blob: draft.blob,
    durationMs: draft.durationMs,
    mimeType: draft.mimeType,
    offsetMs: draft.offsetMs,
    createdAt: draft.createdAt,
  };
}

export function RecordingStudio({
  riffId,
  title,
  metadata,
  initialNotes = "",
  initialTab = "",
  className,
}: RecordingStudioProps) {
  const [riffTitle, setRiffTitle] = useState(title);
  const [riffBpm, setRiffBpm] = useState(String(metadata?.bpm ?? 120));
  const [riffKey, setRiffKey] = useState(metadata?.musicalKey ?? "");
  const [riffTuning, setRiffTuning] = useState(metadata?.tuning ?? "Standard");
  const [riffTimeSignature, setRiffTimeSignature] = useState(
    metadata?.timeSignature ?? "4/4",
  );
  const [notes, setNotes] = useState(initialNotes);
  const [tab, setTab] = useState(initialTab);
  const [writingMode, setWritingMode] = useState<"tab" | "notes">("tab");
  const tabWritingTriggerRef = useRef<HTMLButtonElement>(null);
  const notesWritingTriggerRef = useRef<HTMLButtonElement>(null);
  const [saveState, setSaveState] = useState<"saved" | "waiting" | "saving" | "error">(
    "saved",
  );
  const [saveErrorMessage, setSaveErrorMessage] = useState<string | null>(null);
  const [riffPatchConflict, setRiffPatchConflict] =
    useState<RiffPatchConflict | null>(null);
  const [tapTempoFeedback, setTapTempoFeedback] =
    useState<TapTempoFeedback | null>(null);
  const [takes, setTakes] = useState<RecordingTake[]>([]);
  const [selectedTakeId, setSelectedTakeId] = useState<string | null>(null);
  const [loadingTakes, setLoadingTakes] = useState(true);
  const [takeError, setTakeError] = useState<string | null>(null);
  const [pendingTakeId, setPendingTakeId] = useState<string | null>(null);

  const [microphoneState, setMicrophoneState] =
    useState<MicrophoneState>("idle");
  const [microphoneError, setMicrophoneError] = useState<string | null>(null);
  const [hasStream, setHasStream] = useState(false);
  const [activeStream, setActiveStream] = useState<MediaStream | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState("");
  const [inputLevel, setInputLevel] = useState(0);

  const [captureState, setCaptureState] = useState<CaptureState>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [recordingError, setRecordingError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<RecordingDraft[]>([]);
  const [metronomeEnabled, setMetronomeEnabled] = useState(true);
  const [countInBars, setCountInBars] = useState(1);
  const [cycleEnabled, setCycleEnabled] = useState(false);
  const [cycleBars, setCycleBars] = useState(4);
  const [cycleTakeCount, setCycleTakeCount] = useState(0);

  const [isPlaying, setIsPlaying] = useState(false);
  const [audioLoading, setAudioLoading] = useState(false);
  const [playbackPosition, setPlaybackPosition] = useState(0);
  const [playbackDuration, setPlaybackDuration] = useState(0);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [timingDraft, setTimingDraft] = useState<TimingDraft>(EMPTY_TIMING);
  const [nameDraft, setNameDraft] = useState("");

  const mountedRef = useRef(true);
  const streamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordingChunksRef = useRef<Blob[]>([]);
  const recordingStartedAtRef = useRef(0);
  const recordingOffsetRef = useRef(0);
  const activeRecordingRecoveryIdRef = useRef<string | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const monitorSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const monitorFrameRef = useRef<number | null>(null);
  const monitorCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const levelUpdateAtRef = useRef(0);
  const playerRef = useRef<HTMLAudioElement | null>(null);
  const activePlayerTakeIdRef = useRef<string | null>(null);
  const recordingActiveRef = useRef(false);
  const captureStartPendingRef = useRef(false);
  const riffPatchTimerRef = useRef<number | null>(null);
  const tapTempoFeedbackTimerRef = useRef<number | null>(null);
  const tapTempoStateRef = useRef<TapTempoState>(createTapTempoState());
  const pendingRiffPatchRef = useRef<Record<string, unknown>>({});
  const riffRevisionRef = useRef(metadata?.revision ?? 0);
  const riffPatchBaseRevisionRef = useRef<number | null>(metadata?.revision ?? 0);
  const riffPatchConflictRef = useRef<RiffPatchConflict | null>(null);
  const riffPatchInFlightRef = useRef(false);
  const riffPatchDurableRef = useRef(true);
  const riffPatchRetryDelayRef = useRef(800);
  const metronomeRef = useRef<MetronomeScheduler | null>(null);
  const countInTimerRef = useRef<number | null>(null);
  const countInRejectRef = useRef<(() => void) | null>(null);
  const cycleTimerRef = useRef<number | null>(null);
  const punchStopTimerRef = useRef<number | null>(null);
  const draftObjectUrlsRef = useRef(new Set<string>());
  const draftIdsRef = useRef(new Set<string>());
  const draftUrlCleanupTimerRef = useRef<number | null>(null);
  const recoveryUploadsRef = useRef(new Set<string>());
  const recordingTransportRef = useRef<AdvancedStudioRecordingTransport | null>(null);
  const microphoneRequestIdRef = useRef(0);
  const takesRefreshRequestIdRef = useRef(0);
  const takeMutationLockRef = useRef(createTakeMutationLock());
  const activeSnapshotRef = useRef<(() => void) | null>(null);
  const cycleContinueRef = useRef(false);
  const cycleEnabledRef = useRef(false);
  const cycleBarsRef = useRef(4);
  const cycleNextDeadlineRef = useRef(0);
  const bpmRef = useRef(Number(metadata?.bpm ?? 120));
  const beatsPerBarRef = useRef(4);
  const riffPatchInFlightPayloadRef = useRef<Record<string, unknown>>({});
  const riffPatchInFlightRevisionRef = useRef<number | null>(null);
  const riffPatchRecoverySourcesRef = useRef<RiffPatchSourceSnapshot[]>([]);
  const initialRiffSnapshotRef = useRef<RiffServerSnapshot>({
    id: riffId,
    title,
    bpm: metadata?.bpm ?? 120,
    musicalKey: metadata?.musicalKey ?? "",
    tuning: metadata?.tuning ?? "Standard",
    timeSignature: metadata?.timeSignature ?? "4/4",
    notes: initialNotes,
    tab: initialTab,
    revision: metadata?.revision ?? 0,
  });

  const getRiffPatchOwner = useCallback(
    (targetRiffId: string) => getDocumentRiffPatchOwner(targetRiffId),
    [],
  );

  const persistLocalRiffPatch = useCallback(
    (
      targetRiffId: string,
      baseRevision: number | null,
      patch: Record<string, unknown>,
    ) => {
      const owner = getRiffPatchOwner(targetRiffId);
      return persistRiffPatchOutbox(
        browserStorage("localStorage"),
        targetRiffId,
        owner.ownerId,
        baseRevision,
        patch,
      );
    },
    [getRiffPatchOwner],
  );

  const readLocalRiffPatch = useCallback(
    (targetRiffId: string) => {
      const owner = getRiffPatchOwner(targetRiffId);
      return readRiffPatchOutboxWithSources(
        browserStorage("localStorage"),
        targetRiffId,
        owner.ownerId,
        owner.previousOwnerId,
      );
    },
    [getRiffPatchOwner],
  );

  const clearAppliedLocalRiffPatches = useCallback(
    (targetRiffId: string, current: RiffServerSnapshot) => {
      const owner = getRiffPatchOwner(targetRiffId);
      clearAppliedRiffPatchOutboxes(
        browserStorage("localStorage"),
        targetRiffId,
        current,
        owner.ownerId,
      );
    },
    [getRiffPatchOwner],
  );

  const discardLocalRiffPatchSources = useCallback(
    (targetRiffId: string, sources: readonly RiffPatchSourceSnapshot[]) =>
      discardRiffPatchSources(
        browserStorage("localStorage"),
        targetRiffId,
        sources,
      ),
    [],
  );

  const selectedTake = useMemo(
    () => takes.find((take) => take.id === selectedTakeId) ?? null,
    [selectedTakeId, takes],
  );

  const isPreparing = captureState === "preparing";
  const isFinalizing = captureState === "processing" || captureState === "uploading";
  const isBusy = isPreparing || isFinalizing;
  const isRecording = captureState === "recording";
  const isCounting = captureState === "counting";
  const takeMutationPending = pendingTakeId !== null;
  const riffValidationError = !riffTitle.trim()
    ? "리프 제목을 한 글자 이상 입력해 주세요."
    : !Number.isInteger(Number(riffBpm)) ||
        Number(riffBpm) < 30 ||
        Number(riffBpm) > 300
      ? "BPM은 30부터 300 사이의 정수로 입력해 주세요."
      : !isValidTimeSignature(riffTimeSignature)
        ? "박자는 4/4처럼 입력해 주세요. 분모는 1, 2, 4, 8, 16, 32를 사용할 수 있어요."
        : null;
  const visibleSaveError = riffValidationError ?? saveErrorMessage;
  const visibleSaveState = riffValidationError ? "error" : saveState;

  const metadataItems = useMemo(() => {
    const items: string[] = [];
    if (riffBpm) items.push(`${riffBpm} BPM`);
    if (riffKey) items.push(riffKey);
    if (riffTimeSignature) items.push(riffTimeSignature);
    if (riffTuning) items.push(riffTuning);
    return items;
  }, [riffBpm, riffKey, riffTimeSignature, riffTuning]);

  const handleRecordingTransportReady = useCallback(
    (transport: AdvancedStudioRecordingTransport | null) => {
      recordingTransportRef.current = transport;
    },
    [],
  );

  const fetchRiffSnapshot = useCallback(async (): Promise<RiffServerSnapshot | null> => {
    try {
      const response = await fetch(`/api/riffs/${encodeURIComponent(riffId)}`, {
        credentials: "include",
        cache: "no-store",
      });
      if (!response.ok) return null;
      return normalizeRiffSnapshot(await response.json());
    } catch {
      return null;
    }
  }, [riffId]);

  const flushRiffPatch = useCallback(async function flushPendingRiffPatch() {
    if (riffPatchInFlightRef.current || riffPatchConflictRef.current) return;
    const patch = pendingRiffPatchRef.current;
    if (Object.keys(patch).length === 0) return;
    const expectedRevision = riffPatchBaseRevisionRef.current;
    if (expectedRevision === null) return;
    pendingRiffPatchRef.current = {};
    riffPatchInFlightPayloadRef.current = patch;
    riffPatchInFlightRevisionRef.current = expectedRevision;
    riffPatchInFlightRef.current = true;
    setSaveState("saving");
    setSaveErrorMessage(null);
    let confirmedSnapshot: RiffServerSnapshot | null = null;
    let requestError: unknown = null;
    try {
      const response = await fetch(`/api/riffs/${encodeURIComponent(riffId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...patch, expectedRevision }),
        credentials: "include",
      });
      const payload: unknown = await response.clone().json().catch(() => null);
      if (response.ok) {
        confirmedSnapshot = normalizeRiffSnapshot(payload);
        if (!confirmedSnapshot) {
          requestError = new Error("저장 결과의 버전을 확인하지 못했어요.");
        }
      } else if (response.status === 409) {
        const current = normalizeRiffSnapshot(conflictCurrent(payload));
        if (
          current &&
          current.revision > expectedRevision &&
          mutationAlreadyApplied(current, patch)
        ) {
          // The prior request committed but its response was lost. Treat the
          // server state as the acknowledgement instead of showing a false conflict.
          confirmedSnapshot = current;
        } else if (current) {
          const localPatch = { ...patch, ...pendingRiffPatchRef.current };
          pendingRiffPatchRef.current = localPatch;
          const conflict = { current, localPatch };
          riffPatchConflictRef.current = conflict;
          if (mountedRef.current) {
            setRiffPatchConflict(conflict);
            setSaveState("error");
            setSaveErrorMessage(
              "다른 창에서 이 리프가 변경됐어요. 내 내용은 안전하게 보관했어요.",
            );
          }
        } else {
          requestError = await responseError(response, "리프를 저장하지 못했어요");
        }
      } else {
        requestError = await responseError(response, "리프를 저장하지 못했어요");
      }
    } catch (error) {
      requestError = error;
    }

    if (!confirmedSnapshot && requestError && !riffPatchConflictRef.current) {
      const current = await fetchRiffSnapshot();
      if (
        current &&
        current.revision > expectedRevision &&
        mutationAlreadyApplied(current, patch)
      ) {
        confirmedSnapshot = current;
        requestError = null;
      }
    }

    if (confirmedSnapshot) {
      riffRevisionRef.current = confirmedSnapshot.revision;
      riffPatchBaseRevisionRef.current = confirmedSnapshot.revision;
      riffPatchRetryDelayRef.current = 800;
      clearAppliedLocalRiffPatches(riffId, confirmedSnapshot);
      riffPatchRecoverySourcesRef.current = [];
      if (mountedRef.current) {
        setSaveState(
          Object.keys(pendingRiffPatchRef.current).length > 0 ? "waiting" : "saved",
        );
      }
    } else if (requestError && !riffPatchConflictRef.current) {
      pendingRiffPatchRef.current = { ...patch, ...pendingRiffPatchRef.current };
      riffPatchBaseRevisionRef.current = expectedRevision;
      riffPatchRetryDelayRef.current = Math.min(
        30_000,
        riffPatchRetryDelayRef.current * 2,
      );
      if (mountedRef.current) {
        setSaveState("error");
        setSaveErrorMessage(
          requestError instanceof Error
            ? requestError.message
            : "변경 내용을 저장하지 못했어요.",
        );
      }
    }

    riffPatchInFlightRef.current = false;
    riffPatchInFlightPayloadRef.current = {};
    riffPatchInFlightRevisionRef.current = null;
    const persisted = persistLocalRiffPatch(
      riffId,
      riffPatchBaseRevisionRef.current,
      pendingRiffPatchRef.current,
    );
    riffPatchDurableRef.current =
      persisted || Object.keys(pendingRiffPatchRef.current).length === 0;
    if (!riffPatchDurableRef.current && mountedRef.current) {
      setSaveState("error");
      setSaveErrorMessage(
        "변경 내용을 이 브라우저에 임시 보관하지 못했어요. 이 화면을 닫지 말고 저장 공간을 확인한 뒤 다시 시도해 주세요.",
      );
    }
    if (
      Object.keys(pendingRiffPatchRef.current).length > 0 &&
      mountedRef.current &&
      !riffPatchConflictRef.current
    ) {
      riffPatchTimerRef.current = window.setTimeout(
        () => void flushPendingRiffPatch(),
        riffPatchRetryDelayRef.current,
      );
    }
  }, [
    clearAppliedLocalRiffPatches,
    fetchRiffSnapshot,
    persistLocalRiffPatch,
    riffId,
  ]);

  const queueRiffPatch = useCallback((patch: Record<string, unknown>) => {
    if (
      Object.keys(pendingRiffPatchRef.current).length === 0 &&
      !riffPatchInFlightRef.current
    ) {
      riffPatchBaseRevisionRef.current = riffRevisionRef.current;
    }
    pendingRiffPatchRef.current = { ...pendingRiffPatchRef.current, ...patch };
    const localPatch = {
      ...riffPatchInFlightPayloadRef.current,
      ...pendingRiffPatchRef.current,
    };
    const persisted = persistLocalRiffPatch(
      riffId,
      riffPatchBaseRevisionRef.current,
      localPatch,
    );
    riffPatchDurableRef.current = persisted || Object.keys(localPatch).length === 0;
    if (riffPatchConflictRef.current) {
      const conflict = { ...riffPatchConflictRef.current, localPatch };
      riffPatchConflictRef.current = conflict;
      setRiffPatchConflict(conflict);
      setSaveState("error");
      setSaveErrorMessage(
        persisted
          ? "다른 창에서 이 리프가 변경됐어요. 적용할 버전을 선택해 주세요."
          : "변경 내용을 이 브라우저에 임시 보관하지 못했어요. 이 화면을 닫지 말고 저장 공간을 확인한 뒤 다시 시도해 주세요.",
      );
      return;
    }
    if (persisted) {
      setSaveState("waiting");
      setSaveErrorMessage(null);
    } else {
      setSaveState("error");
      setSaveErrorMessage(
        "변경 내용을 이 브라우저에 임시 보관하지 못했어요. 이 화면을 닫지 말고 저장 공간을 확인한 뒤 다시 시도해 주세요.",
      );
    }
    if (riffPatchTimerRef.current !== null) window.clearTimeout(riffPatchTimerRef.current);
    riffPatchTimerRef.current = window.setTimeout(() => void flushRiffPatch(), 700);
  }, [flushRiffPatch, persistLocalRiffPatch, riffId]);

  const handleTapTempo = useCallback(() => {
    const result = registerTapTempo(tapTempoStateRef.current, performance.now());
    tapTempoStateRef.current = result.state;

    let feedback: TapTempoFeedback;
    if (result.bpm !== null) {
      const bpm = result.bpm;
      setRiffBpm(String(bpm));
      bpmRef.current = bpm;
      setSaveErrorMessage(null);
      queueRiffPatch({ bpm });
      feedback = {
        label: `${bpm} BPM`,
        announcement: `${bpm} BPM으로 측정했어요. ${result.tapCount}번 탭했어요.`,
      };
    } else if (result.resetReason === "idle") {
      feedback = {
        label: "다시 탭",
        announcement: "탭 간격이 오래 비어 새로 측정해요. 한 번 더 탭해 주세요.",
      };
    } else if (result.resetReason === "outlier") {
      feedback = {
        label: "다시 탭",
        announcement: "박자에서 벗어난 탭이 있어 새로 측정해요. 한 번 더 탭해 주세요.",
      };
    } else {
      feedback = {
        label: "한 번 더",
        announcement: "첫 박자를 받았어요. 한 번 더 탭해 주세요.",
      };
    }

    setTapTempoFeedback(feedback);
    if (tapTempoFeedbackTimerRef.current !== null) {
      window.clearTimeout(tapTempoFeedbackTimerRef.current);
    }
    tapTempoFeedbackTimerRef.current = window.setTimeout(() => {
      tapTempoFeedbackTimerRef.current = null;
      setTapTempoFeedback(null);
    }, 2_400);
  }, [queueRiffPatch]);

  function rejectRiffField(field: string, message: string) {
    const pending = { ...pendingRiffPatchRef.current };
    delete pending[field];
    pendingRiffPatchRef.current = pending;
    const localPatch = {
      ...riffPatchInFlightPayloadRef.current,
      ...pending,
    };
    persistLocalRiffPatch(
      riffId,
      riffPatchBaseRevisionRef.current,
      localPatch,
    );
    if (riffPatchConflictRef.current) {
      const conflict = { ...riffPatchConflictRef.current, localPatch };
      riffPatchConflictRef.current = conflict;
      setRiffPatchConflict(conflict);
    }
    setSaveState("error");
    setSaveErrorMessage(message);
  }

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const nextDevices = (await navigator.mediaDevices.enumerateDevices()).filter(
        (device) => device.kind === "audioinput",
      );
      if (!mountedRef.current) return;
      setDevices(nextDevices);
      setSelectedDeviceId((current) => {
        if (current && nextDevices.some((device) => device.deviceId === current)) {
          return current;
        }
        return nextDevices[0]?.deviceId ?? "";
      });
    } catch {
      // Device labels can remain unavailable until permission has been granted.
    }
  }, []);

  const stopMonitoring = useCallback(() => {
    if (monitorFrameRef.current !== null) {
      cancelAnimationFrame(monitorFrameRef.current);
      monitorFrameRef.current = null;
    }
    monitorSourceRef.current?.disconnect();
    analyserRef.current?.disconnect();
    monitorSourceRef.current = null;
    analyserRef.current = null;
    const context = audioContextRef.current;
    audioContextRef.current = null;
    if (context && context.state !== "closed") void context.close();
    if (mountedRef.current) setInputLevel(0);
  }, []);

  const startMonitoring = useCallback(
    async (stream: MediaStream) => {
      stopMonitoring();
      if (typeof AudioContext === "undefined") return;

      const context = new AudioContext();
      const analyser = context.createAnalyser();
      const source = context.createMediaStreamSource(stream);
      analyser.fftSize = 2_048;
      analyser.smoothingTimeConstant = 0.76;
      source.connect(analyser);
      audioContextRef.current = context;
      analyserRef.current = analyser;
      monitorSourceRef.current = source;
      await context.resume().catch(() => undefined);

      const waveform = new Uint8Array(analyser.fftSize);
      const draw = (timestamp: number) => {
        if (analyserRef.current !== analyser) return;
        analyser.getByteTimeDomainData(waveform);

        let sumSquares = 0;
        for (const sample of waveform) {
          const normalized = (sample - 128) / 128;
          sumSquares += normalized * normalized;
        }
        const rms = Math.sqrt(sumSquares / waveform.length);
        const level = clamp(rms * 4.6, 0, 1);
        if (timestamp - levelUpdateAtRef.current > 80) {
          levelUpdateAtRef.current = timestamp;
          if (mountedRef.current) setInputLevel(level);
        }

        const canvas = monitorCanvasRef.current;
        const drawingContext = canvas?.getContext("2d");
        if (canvas && drawingContext) {
          const rect = canvas.getBoundingClientRect();
          const scale = Math.min(window.devicePixelRatio || 1, 2);
          const width = Math.max(1, Math.round(rect.width * scale));
          const height = Math.max(1, Math.round(rect.height * scale));
          if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width;
            canvas.height = height;
          }

          drawingContext.clearRect(0, 0, width, height);
          drawingContext.fillStyle = "#1b1c1a";
          drawingContext.fillRect(0, 0, width, height);
          drawingContext.strokeStyle = recordingActiveRef.current ? "#d9344f" : "#b7b9b3";
          drawingContext.lineWidth = Math.max(1.5, scale * 1.2);
          drawingContext.beginPath();
          const sliceWidth = width / waveform.length;
          for (let index = 0; index < waveform.length; index += 1) {
            const x = index * sliceWidth;
            const y = (waveform[index] / 255) * height;
            if (index === 0) drawingContext.moveTo(x, y);
            else drawingContext.lineTo(x, y);
          }
          drawingContext.stroke();
        }

        monitorFrameRef.current = requestAnimationFrame(draw);
      };

      monitorFrameRef.current = requestAnimationFrame(draw);
    },
    [stopMonitoring],
  );

  const stopMicrophone = useCallback(() => {
    microphoneRequestIdRef.current += 1;
    stopMonitoring();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setHasStream(false);
    setActiveStream(null);
    setMicrophoneState("idle");
    setMicrophoneError(null);
  }, [stopMonitoring]);

  const prepareMicrophone = useCallback(
    async (deviceId?: string): Promise<MediaStream | null> => {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
        setMicrophoneState("unavailable");
        setMicrophoneError(
          "이 브라우저에서는 오디오 녹음을 지원하지 않아요. 최신 Chrome이나 Safari를 사용해 주세요.",
        );
        return null;
      }

      const current = streamRef.current;
      const currentTrack = current?.getAudioTracks()[0];
      if (currentTrack?.readyState === "live") {
        const currentDeviceId = currentTrack.getSettings().deviceId;
        if (!deviceId || !currentDeviceId || currentDeviceId === deviceId) return current;
      }

      const requestId = microphoneRequestIdRef.current + 1;
      microphoneRequestIdRef.current = requestId;
      setMicrophoneState("requesting");
      setMicrophoneError(null);

      try {
        const audioConstraints = (exactDeviceId?: string): MediaTrackConstraints => ({
          ...(exactDeviceId ? { deviceId: { exact: exactDeviceId } } : {}),
          autoGainControl: false,
          echoCancellation: false,
          noiseSuppression: false,
          channelCount: { ideal: 1 },
          sampleRate: { ideal: 48_000 },
        });

        let stream: MediaStream;
        let usedDefaultFallback = false;
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: audioConstraints(deviceId),
            video: false,
          });
        } catch (error) {
          if (!deviceId || !canRetryWithDefaultInput(error)) throw error;
          usedDefaultFallback = true;
          stream = await navigator.mediaDevices.getUserMedia({
            audio: audioConstraints(),
            video: false,
          });
        }

        if (!mountedRef.current || requestId !== microphoneRequestIdRef.current) {
          stream.getTracks().forEach((track) => track.stop());
          return null;
        }

        const previous = streamRef.current;
        streamRef.current = stream;
        previous?.getTracks().forEach((track) => track.stop());
        setHasStream(true);
        setActiveStream(stream);
        setMicrophoneState("ready");
        const audioTrack = stream.getAudioTracks()[0];
        const actualDeviceId = audioTrack?.getSettings().deviceId;
        if (actualDeviceId) setSelectedDeviceId(actualDeviceId);
        if (usedDefaultFallback) {
          setMicrophoneError("선택한 입력이 사라져 기본 오디오 입력으로 연결했어요.");
        }
        audioTrack?.addEventListener(
          "ended",
          () => {
            if (streamRef.current !== stream) return;
            streamRef.current = null;
            cycleContinueRef.current = false;
            cycleNextDeadlineRef.current = 0;
            metronomeRef.current?.stop();
            recordingTransportRef.current?.stop();
            const rejectPendingStart = countInRejectRef.current;
            countInRejectRef.current = null;
            if (countInTimerRef.current !== null) {
              window.clearTimeout(countInTimerRef.current);
              countInTimerRef.current = null;
            }
            rejectPendingStart?.();
            captureStartPendingRef.current = false;
            stopMonitoring();
            const recorder = mediaRecorderRef.current;
            if (recorder && recorder.state !== "inactive") {
              try {
                recorder.requestData();
              } catch {
                // stop() still asks the recorder for its final available chunk.
              }
              try {
                recorder.stop();
              } catch {
                // The recorder can already be transitioning to inactive.
              }
            }
            if (mountedRef.current) {
              setHasStream(false);
              setActiveStream(null);
              setMicrophoneState("unavailable");
              // MediaRecorder.stop() flips state to inactive before its final
              // dataavailable/onstop work is complete. Keep the shared studio
              // transport locked until finalization moves through upload and
              // explicitly returns capture to idle.
              setCaptureState(recorder ? "processing" : "idle");
              setMicrophoneError(
                "오디오 입력 연결이 끊겼어요. 케이블이나 장치를 확인한 뒤 다시 연결해 주세요.",
              );
            }
          },
          { once: true },
        );
        try {
          await startMonitoring(stream);
        } catch {
          stopMonitoring();
          setMicrophoneError(
            "오디오 입력은 연결됐지만 실시간 레벨 미터를 시작하지 못했어요. 녹음은 계속할 수 있어요.",
          );
        }
        await refreshDevices();
        return stream;
      } catch (error) {
        if (requestId !== microphoneRequestIdRef.current) return null;
        const detail = mediaErrorMessage(error);
        const preservedTrack = current?.getAudioTracks()[0];
        if (mountedRef.current) {
          if (preservedTrack?.readyState === "live") {
            const preservedDeviceId = preservedTrack.getSettings().deviceId;
            if (preservedDeviceId) setSelectedDeviceId(preservedDeviceId);
            setMicrophoneState("ready");
            setMicrophoneError(
              `새 입력으로 바꾸지 못해 기존 입력을 유지하고 있어요. ${detail.message}`,
            );
          } else {
            setMicrophoneState(detail.state);
            setMicrophoneError(detail.message);
          }
        }
        if (preservedTrack?.readyState === "live") return current ?? null;
        return null;
      }
    },
    [refreshDevices, startMonitoring, stopMonitoring],
  );

  const refreshTakes = useCallback(
    async (signal?: AbortSignal): Promise<RecordingTake[]> => {
      const requestId = takesRefreshRequestIdRef.current + 1;
      takesRefreshRequestIdRef.current = requestId;
      setTakeError(null);
      try {
        const response = await fetch(
          `/api/riffs/${encodeURIComponent(riffId)}/takes`,
          { credentials: "include", signal },
        );
        if (!response.ok) throw await responseError(response, "테이크를 불러오지 못했어요");
        const payload: unknown = await response.json();
        const nextTakes = extractTakes(payload);
        if (
          !mountedRef.current ||
          signal?.aborted ||
          requestId !== takesRefreshRequestIdRef.current
        ) {
          return nextTakes;
        }
        setTakes(nextTakes);
        setSelectedTakeId((current) => {
          if (current && nextTakes.some((take) => take.id === current)) return current;
          return (
            nextTakes.find((take) => take.isPrimary)?.id ??
            nextTakes.at(-1)?.id ??
            null
          );
        });
        return nextTakes;
      } catch (error) {
        if (signal?.aborted) return [];
        if (mountedRef.current && requestId === takesRefreshRequestIdRef.current) {
          setTakeError(
            error instanceof Error ? error.message : "테이크를 불러오지 못했어요.",
          );
        }
        return [];
      } finally {
        if (
          mountedRef.current &&
          !signal?.aborted &&
          requestId === takesRefreshRequestIdRef.current
        ) {
          setLoadingTakes(false);
        }
      }
    },
    [riffId],
  );

  const removeDraftFromView = useCallback((draft: RecordingDraft) => {
    URL.revokeObjectURL(draft.objectUrl);
    draftObjectUrlsRef.current.delete(draft.objectUrl);
    draftIdsRef.current.delete(draft.id);
    setDrafts((current) => current.filter((item) => item.id !== draft.id));
  }, []);

  const clearDraft = useCallback(
    (draft: RecordingDraft) => {
      removeDraftFromView(draft);
      void deletePendingRecording(draft.id).catch(() => {
        if (mountedRef.current) {
          setRecordingError("임시 녹음 표시를 닫았지만 브라우저 복구 저장소를 정리하지 못했어요.");
        }
      });
    },
    [removeDraftFromView],
  );

  const retainFailedRecording = useCallback(
    async (
      blob: Blob,
      durationMs: number,
      mimeType: string,
      offsetMs: number,
      existingDraft?: RecordingDraft,
      recoveryId?: string,
    ) => {
      const base: StoredPendingRecording = existingDraft
        ? storedDraft(existingDraft, riffId)
        : {
            id: recoveryId ?? createPendingRecordingId(),
            riffId,
            blob,
            durationMs,
            mimeType,
            offsetMs,
            createdAt: Date.now(),
          };

      let persistenceError: unknown = null;
      try {
        await savePendingRecording(base);
      } catch (error) {
        persistenceError = error;
      }

      if (!mountedRef.current) return;
      if (!draftIdsRef.current.has(base.id)) {
        const objectUrl = URL.createObjectURL(base.blob);
        draftObjectUrlsRef.current.add(objectUrl);
        draftIdsRef.current.add(base.id);
        setDrafts((current) => [...current, { ...base, objectUrl }]);
      }
      if (persistenceError) {
        setRecordingError(recoveryStorageErrorMessage(persistenceError));
      }
    },
    [riffId],
  );

  const uploadRecording = useCallback(
    async (
      blob: Blob,
      durationMs: number,
      existingDraft?: RecordingDraft,
      background = false,
      offsetMs = existingDraft?.offsetMs ?? 0,
      recoveryId?: string,
    ) => {
      const uploadRecoveryId =
        recoveryId ?? existingDraft?.id ?? createPendingRecordingId();
      if (existingDraft) {
        if (recoveryUploadsRef.current.has(existingDraft.id)) return;
        recoveryUploadsRef.current.add(existingDraft.id);
      }
      if (!background) setCaptureState("uploading");
      setRecordingError(null);
      const mimeType = blob.type || preferredRecorderMimeType() || "audio/webm";
      const extension = extensionForMimeType(mimeType);
      const filename = `riff-take-${Date.now()}.${extension}`;
      const form = new FormData();
      form.append("audio", new File([blob], filename, { type: mimeType }));
      form.append("durationMs", String(Math.max(1, Math.round(durationMs))));
      form.append("recoveryId", uploadRecoveryId);
      const uploadController = new AbortController();
      const uploadTimeout = window.setTimeout(() => uploadController.abort(), 120_000);

      try {
        const response = await fetch(
          `/api/riffs/${encodeURIComponent(riffId)}/takes`,
          {
            method: "POST",
            body: form,
            credentials: "include",
            signal: uploadController.signal,
          },
        );
        if (!response.ok) throw await responseError(response, "녹음을 저장하지 못했어요");
        const payload: unknown = await response.json().catch(() => null);
        const created =
          payload && typeof payload === "object" && "take" in payload
            ? normalizeTake((payload as { take: unknown }).take, takes.length)
            : normalizeTake(payload, takes.length);
        if (created && offsetMs > 0) {
          try {
            const alignmentResponse = await fetch(
              `/api/takes/${encodeURIComponent(created.id)}`,
              {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  offsetMs,
                  expectedRevision: created.revision,
                }),
                credentials: "include",
              },
            );
            if (!alignmentResponse.ok && mountedRef.current) {
              setTakeError("펀치 테이크는 저장했지만 시작 위치를 맞추지 못했어요.");
            }
          } catch {
            if (mountedRef.current) {
              setTakeError("펀치 테이크는 저장했지만 시작 위치를 맞추지 못했어요.");
            }
          }
        }
        await deletePendingRecording(uploadRecoveryId).catch(() => undefined);
        if (existingDraft && mountedRef.current) {
          removeDraftFromView(existingDraft);
        }
        const nextTakes = await refreshTakes();
        if (mountedRef.current) {
          setSelectedTakeId(
            created?.id ?? nextTakes.at(-1)?.id ?? selectedTakeId,
          );
        }
      } catch (error) {
        await retainFailedRecording(
          blob,
          durationMs,
          mimeType,
          offsetMs,
          existingDraft,
          uploadRecoveryId,
        );
        if (mountedRef.current) {
          setRecordingError(
            error instanceof DOMException && error.name === "AbortError"
              ? "녹음 저장 응답이 오래 걸려 임시 보관했어요. 네트워크를 확인한 뒤 다시 저장해 주세요."
              : error instanceof Error
              ? error.message
              : "녹음은 보관 중이지만 서버에 저장하지 못했어요.",
          );
        }
      } finally {
        window.clearTimeout(uploadTimeout);
        if (existingDraft) recoveryUploadsRef.current.delete(existingDraft.id);
        if (mountedRef.current && !background) setCaptureState("idle");
      }
    },
    [refreshTakes, removeDraftFromView, retainFailedRecording, riffId, selectedTakeId, takes.length],
  );

  const beginMediaRecorder = useCallback(function beginMediaRecorder(
    stream: MediaStream,
  ): boolean {
    try {
      const recordingRecoveryId = createPendingRecordingId();
      const recordingCreatedAt = Date.now();
      activeRecordingRecoveryIdRef.current = recordingRecoveryId;
      const recorder = createCompatibleMediaRecorder(stream);
      const fallbackMimeType = preferredRecorderMimeType() || "audio/webm";
      let recorderFailed = false;
      let finalized = false;
      let snapshotWritePending = false;
      let lastSnapshotAt = performance.now();
      let recordedBytes = 0;
      let sizeLimitReached = false;
      let recoveryWarningShown = false;
      recordingChunksRef.current = [];
      recordingStartedAtRef.current = performance.now();
      setElapsedMs(0);

      const persistSnapshot = () => {
        if (snapshotWritePending || recordingChunksRef.current.length === 0) return;
        const chunks = [...recordingChunksRef.current];
        const snapshotType = recorder.mimeType || chunks[0]?.type || fallbackMimeType;
        const snapshot = new Blob(chunks, { type: snapshotType });
        if (snapshot.size === 0) return;
        snapshotWritePending = true;
        lastSnapshotAt = performance.now();
        void savePendingRecording({
          id: recordingRecoveryId,
          riffId,
          blob: snapshot,
          durationMs: Math.max(1, performance.now() - recordingStartedAtRef.current),
          mimeType: snapshotType,
          offsetMs: recordingOffsetRef.current,
          createdAt: recordingCreatedAt,
        })
          .catch((error) => {
            if (!mountedRef.current || recoveryWarningShown) return;
            recoveryWarningShown = true;
            setRecordingError(recoveryStorageErrorMessage(error));
          })
          .finally(() => {
            snapshotWritePending = false;
          });
      };
      activeSnapshotRef.current = persistSnapshot;

      const finalizeRecording = () => {
        if (finalized) return;
        finalized = true;
        if (activeSnapshotRef.current === persistSnapshot) activeSnapshotRef.current = null;
        recordingActiveRef.current = false;
        const durationMs = Math.max(1, performance.now() - recordingStartedAtRef.current);
        const timelineOffsetMs = recordingOffsetRef.current;
        const chunks = recordingChunksRef.current;
        recordingChunksRef.current = [];
        const recordedType =
          recorder.mimeType || chunks[0]?.type || fallbackMimeType;
        const blob = new Blob(chunks, { type: recordedType });
        if (mediaRecorderRef.current === recorder) mediaRecorderRef.current = null;

        if (!mountedRef.current) {
          if (blob.size > 0) {
            void retainFailedRecording(
              blob,
              durationMs,
              recordedType,
              timelineOffsetMs,
              undefined,
              recordingRecoveryId,
            );
          }
          activeRecordingRecoveryIdRef.current = null;
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        if (recorderFailed) {
          activeRecordingRecoveryIdRef.current = null;
          cycleContinueRef.current = false;
          cycleNextDeadlineRef.current = 0;
          metronomeRef.current?.stop();
          recordingTransportRef.current?.stop();
          setCaptureState("idle");
          if (blob.size > 0) {
            void retainFailedRecording(
              blob,
              durationMs,
              recordedType,
              timelineOffsetMs,
              undefined,
              recordingRecoveryId,
            );
          }
          return;
        }

        const continueCycle =
          cycleContinueRef.current &&
          cycleEnabledRef.current &&
          stream.getAudioTracks().some((track) => track.readyState === "live");
        if (blob.size === 0) {
          activeRecordingRecoveryIdRef.current = null;
          cycleContinueRef.current = false;
          cycleNextDeadlineRef.current = 0;
          metronomeRef.current?.stop();
          recordingTransportRef.current?.stop();
          setCaptureState("idle");
          setRecordingError("녹음된 소리가 없어요. 입력 장치를 확인한 뒤 다시 시도해 주세요.");
          return;
        }
        if (continueCycle) beginMediaRecorder(stream);
        else {
          cycleNextDeadlineRef.current = 0;
          metronomeRef.current?.stop();
          recordingTransportRef.current?.stop();
        }
        if (!continueCycle) activeRecordingRecoveryIdRef.current = null;
        void savePendingRecording({
          id: recordingRecoveryId,
          riffId,
          blob,
          durationMs,
          mimeType: recordedType,
          offsetMs: timelineOffsetMs,
          createdAt: recordingCreatedAt,
        }).catch(() => undefined);
        void uploadRecording(
          blob,
          durationMs,
          undefined,
          continueCycle,
          timelineOffsetMs,
          recordingRecoveryId,
        );
        if (sizeLimitReached) {
          setRecordingError(
            "녹음이 95MB에 가까워 안전하게 정지했어요. 이어서 새 테이크를 녹음해 주세요.",
          );
        }
      };

      recorder.ondataavailable = (event) => {
        if (event.data.size <= 0) return;
        recordingChunksRef.current.push(event.data);
        recordedBytes += event.data.size;
        if (
          document.visibilityState === "hidden" ||
          performance.now() - lastSnapshotAt >= RECOVERY_SNAPSHOT_INTERVAL_MS
        ) {
          persistSnapshot();
        }
        if (
          recordedBytes >= MAX_SAFE_RECORDING_BYTES &&
          !sizeLimitReached &&
          recorder.state !== "inactive"
        ) {
          sizeLimitReached = true;
          cycleContinueRef.current = false;
          cycleNextDeadlineRef.current = 0;
          try {
            recorder.stop();
          } catch {
            // onerror/finalization handles a recorder already stopping.
          }
        }
      };
      recorder.onerror = (event) => {
        recorderFailed = true;
        cycleContinueRef.current = false;
        cycleNextDeadlineRef.current = 0;
        metronomeRef.current?.stop();
        recordingTransportRef.current?.stop();
        persistSnapshot();
        const recorderError =
          "error" in event && event.error instanceof Error
            ? event.error.message
            : "입력 장치를 다시 확인해 주세요.";
        if (mountedRef.current) {
          setCaptureState("processing");
          setRecordingError(`녹음 중 문제가 생겼어요. ${recorderError}`);
        }
        if (recorder.state !== "inactive") {
          try {
            recorder.requestData();
          } catch {
            // stop() still dispatches the final available data when possible.
          }
          try {
            recorder.stop();
          } catch {
            // A stop event may already be queued.
          }
        } else {
          window.setTimeout(finalizeRecording, 0);
        }
      };
      recorder.onstop = finalizeRecording;

      mediaRecorderRef.current = recorder;
      try {
        recorder.start(250);
      } catch {
        // A few WebKit builds support MediaRecorder but reject a timeslice.
        if (recorder.state === "inactive") recorder.start();
      }
      recordingActiveRef.current = true;
      setCaptureState("recording");
      setCycleTakeCount((current) => current + 1);

      if (cycleContinueRef.current && cycleEnabledRef.current) {
        const bpm = clamp(bpmRef.current || 120, 30, 300);
        const beatsPerBar = clamp(beatsPerBarRef.current || 4, 1, 32);
        const durationMs = cycleBarsRef.current * beatsPerBar * (60_000 / bpm);
        cycleNextDeadlineRef.current = nextCycleDeadline(
          recordingStartedAtRef.current,
          cycleNextDeadlineRef.current,
          durationMs,
        );
        if (cycleTimerRef.current !== null) window.clearTimeout(cycleTimerRef.current);
        cycleTimerRef.current = window.setTimeout(() => {
          if (!cycleContinueRef.current || recorder.state === "inactive") return;
          try {
            recorder.requestData();
          } catch {
            // The final dataavailable event still fires when stop() is called.
          }
          recorder.stop();
        }, Math.max(1, cycleNextDeadlineRef.current - performance.now()));
      }
      return true;
    } catch (error) {
      activeSnapshotRef.current = null;
      mediaRecorderRef.current = null;
      activeRecordingRecoveryIdRef.current = null;
      cycleContinueRef.current = false;
      cycleNextDeadlineRef.current = 0;
      metronomeRef.current?.stop();
      recordingTransportRef.current?.stop();
      setCaptureState("idle");
      setRecordingError(
        error instanceof Error ? error.message : "녹음을 시작하지 못했어요.",
      );
      return false;
    }
  }, [retainFailedRecording, riffId, uploadRecording]);

  const cancelCountIn = useCallback(() => {
    countInRejectRef.current?.();
    countInRejectRef.current = null;
    if (countInTimerRef.current !== null) {
      window.clearTimeout(countInTimerRef.current);
      countInTimerRef.current = null;
    }
    metronomeRef.current?.stop();
    metronomeRef.current = null;
    recordingTransportRef.current?.stop();
    cycleContinueRef.current = false;
    cycleNextDeadlineRef.current = 0;
    recordingActiveRef.current = false;
    captureStartPendingRef.current = false;
    setCaptureState("idle");
  }, []);

  const startRecording = useCallback(async () => {
    if (captureState !== "idle" || captureStartPendingRef.current) return;
    captureStartPendingRef.current = true;
    setCaptureState("preparing");
    setRecordingError(null);
    setPlaybackError(null);
    setCycleTakeCount(0);
    playerRef.current?.pause();

    try {
      // This is deliberately the first awaited operation after the user's
      // record click so strict browsers can grant YouTube playback permission.
      await recordingTransportRef.current?.prime();
    } catch (primeError) {
      captureStartPendingRef.current = false;
      setCaptureState("idle");
      setRecordingError(
        primeError instanceof Error
          ? primeError.message
          : "YouTube 백킹 재생을 준비하지 못했어요.",
      );
      return;
    }

    const stream = await prepareMicrophone(selectedDeviceId || undefined);
    if (!stream || !mountedRef.current || !captureStartPendingRef.current) {
      captureStartPendingRef.current = false;
      if (mountedRef.current) setCaptureState("idle");
      return;
    }

    void requestPersistentRecordingStorage();

    cycleEnabledRef.current = cycleEnabled;
    cycleBarsRef.current = cycleBars;
    cycleContinueRef.current = cycleEnabled;
    cycleNextDeadlineRef.current = 0;
    const parsedBeats = Number.parseInt(riffTimeSignature.split("/")[0] ?? "4", 10);
    beatsPerBarRef.current = clamp(Number.isFinite(parsedBeats) ? parsedBeats : 4, 1, 32);
    bpmRef.current = clamp(Number(riffBpm) || 120, 30, 300);
    recordingOffsetRef.current = 0;

    try {
      const context = audioContextRef.current;
      if (context && (metronomeEnabled || countInBars > 0)) {
        await context.resume();
        const scheduler = new MetronomeScheduler(context);
        metronomeRef.current?.stop();
        metronomeRef.current = scheduler;
        const { recordingStartTime } = scheduler.start({
          bpm: bpmRef.current,
          beatsPerBar: beatsPerBarRef.current,
          countInBars,
          subdivision: 1,
          volume: 0.27,
        });
        if (countInBars > 0) setCaptureState("counting");
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            resolve();
          };
          const checkAudioClock = () => {
            if (settled) return;
            const remainingMs = (recordingStartTime - context.currentTime) * 1_000;
            if (remainingMs <= 2) {
              finish();
              return;
            }
            countInTimerRef.current = window.setTimeout(
              checkAudioClock,
              Math.min(100, Math.max(4, remainingMs)),
            );
          };
          countInRejectRef.current = () => {
            if (settled) return;
            settled = true;
            reject(new DOMException("카운트인이 취소됐어요.", "AbortError"));
          };
          checkAudioClock();
        });
        countInRejectRef.current = null;
        countInTimerRef.current = null;
        if (!metronomeEnabled) {
          scheduler.stop();
          metronomeRef.current = null;
        }
      }
      if (!context && countInBars > 0) {
        const countInDurationMs =
          countInBars * beatsPerBarRef.current * (60_000 / bpmRef.current);
        const countInDeadline = performance.now() + countInDurationMs;
        setCaptureState("counting");
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const checkDeadline = () => {
            if (settled) return;
            const remainingMs = countInDeadline - performance.now();
            if (remainingMs <= 2) {
              settled = true;
              resolve();
              return;
            }
            countInTimerRef.current = window.setTimeout(
              checkDeadline,
              Math.min(100, Math.max(4, remainingMs)),
            );
          };
          countInRejectRef.current = () => {
            if (settled) return;
            settled = true;
            reject(new DOMException("카운트인이 취소됐어요.", "AbortError"));
          };
          checkDeadline();
        });
        countInRejectRef.current = null;
        countInTimerRef.current = null;
      }
      if (!mountedRef.current) return;
      await recordingTransportRef.current?.start();
      if (
        !mountedRef.current ||
        !captureStartPendingRef.current ||
        streamRef.current !== stream ||
        !stream.getAudioTracks().some((track) => track.readyState === "live")
      ) {
        recordingTransportRef.current?.stop();
        return;
      }
      captureStartPendingRef.current = false;
      beginMediaRecorder(stream);
    } catch (error) {
      captureStartPendingRef.current = false;
      if (error instanceof DOMException && error.name === "AbortError") return;
      cycleContinueRef.current = false;
      metronomeRef.current?.stop();
      recordingTransportRef.current?.stop();
      setCaptureState("idle");
      setRecordingError(
        error instanceof Error ? error.message : "녹음을 시작하지 못했어요.",
      );
    }
  }, [
    beginMediaRecorder,
    captureState,
    countInBars,
    cycleBars,
    cycleEnabled,
    metronomeEnabled,
    prepareMicrophone,
    riffBpm,
    riffTimeSignature,
    selectedDeviceId,
  ]);

  const stopRecording = useCallback(() => {
    cycleContinueRef.current = false;
    cycleNextDeadlineRef.current = 0;
    recordingTransportRef.current?.stop();
    if (cycleTimerRef.current !== null) {
      window.clearTimeout(cycleTimerRef.current);
      cycleTimerRef.current = null;
    }
    if (punchStopTimerRef.current !== null) {
      window.clearTimeout(punchStopTimerRef.current);
      punchStopTimerRef.current = null;
    }
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    setCaptureState("processing");
    try {
      recorder.requestData();
    } catch {
      // Some Safari versions do not allow requestData immediately before stop.
    }
    recorder.stop();
    setElapsedMs(Math.max(0, performance.now() - recordingStartedAtRef.current));
  }, []);

  const handleYouTubePlaybackInterrupted = useCallback(
    (message: string) => {
      setRecordingError(message);
      cycleContinueRef.current = false;
      cycleNextDeadlineRef.current = 0;
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        stopRecording();
        return;
      }
      if (captureStartPendingRef.current) {
        cancelCountIn();
        return;
      }
      recordingTransportRef.current?.stop();
    },
    [cancelCountIn, stopRecording],
  );

  const handlePunchRequest = useCallback(
    async ({ startMs, endMs, preRollMs }: PunchRequest) => {
      if (captureState !== "idle" || captureStartPendingRef.current) {
        throw new Error("진행 중인 녹음을 먼저 끝내주세요.");
      }
      if (endMs <= startMs) throw new Error("펀치 아웃은 펀치 인보다 뒤여야 해요.");
      if (endMs - startMs > 3_600_000) {
        throw new Error("한 번의 펀치 녹음은 1시간 이내로 설정해주세요.");
      }

      setRecordingError(null);
      captureStartPendingRef.current = true;
      setCaptureState("preparing");
      setPlaybackError(null);
      setCycleEnabled(false);
      cycleEnabledRef.current = false;
      cycleContinueRef.current = false;
      cycleNextDeadlineRef.current = 0;
      playerRef.current?.pause();

      const stream = await prepareMicrophone(selectedDeviceId || undefined);
      if (!stream) {
        captureStartPendingRef.current = false;
        if (mountedRef.current) setCaptureState("idle");
        throw new Error("오디오 입력을 준비하지 못했어요.");
      }
      if (!mountedRef.current || !captureStartPendingRef.current) {
        captureStartPendingRef.current = false;
        if (mountedRef.current) setCaptureState("idle");
        throw new DOMException("펀치 녹음이 취소됐어요.", "AbortError");
      }
      void requestPersistentRecordingStorage();

      const parsedBeats = Number.parseInt(riffTimeSignature.split("/")[0] ?? "4", 10);
      beatsPerBarRef.current = clamp(Number.isFinite(parsedBeats) ? parsedBeats : 4, 1, 32);
      bpmRef.current = clamp(Number(riffBpm) || 120, 30, 300);
      recordingOffsetRef.current = Math.max(0, startMs);

      try {
        const context = audioContextRef.current;
        if (context && (preRollMs > 0 || metronomeEnabled)) {
          await context.resume();
          const scheduler = new MetronomeScheduler(context);
          metronomeRef.current?.stop();
          metronomeRef.current = scheduler;
          scheduler.start({
            bpm: bpmRef.current,
            beatsPerBar: beatsPerBarRef.current,
            countInBars: 0,
            subdivision: 1,
            volume: 0.27,
          });
        }

        if (preRollMs > 0) {
          setCaptureState("counting");
          await new Promise<void>((resolve, reject) => {
            const deadline = performance.now() + preRollMs;
            let settled = false;
            const checkDeadline = () => {
              if (settled) return;
              const remainingMs = deadline - performance.now();
              if (remainingMs <= 2) {
                settled = true;
                resolve();
                return;
              }
              countInTimerRef.current = window.setTimeout(
                checkDeadline,
                Math.min(100, Math.max(4, remainingMs)),
              );
            };
            countInRejectRef.current = () => {
              if (settled) return;
              settled = true;
              reject(new DOMException("펀치 프리롤이 취소됐어요.", "AbortError"));
            };
            checkDeadline();
          });
          countInRejectRef.current = null;
          countInTimerRef.current = null;
        }
        if (!metronomeEnabled) {
          metronomeRef.current?.stop();
          metronomeRef.current = null;
        }

        if (
          !mountedRef.current ||
          !captureStartPendingRef.current ||
          streamRef.current !== stream ||
          !stream.getAudioTracks().some((track) => track.readyState === "live")
        ) {
          throw new DOMException("펀치 녹음이 취소됐어요.", "AbortError");
        }
        captureStartPendingRef.current = false;
        if (!beginMediaRecorder(stream)) {
          throw new Error("펀치 녹음을 시작하지 못했어요.");
        }
        const punchEndDeadline = performance.now() + Math.max(1, endMs - startMs);
        const checkPunchEnd = () => {
          const remainingMs = punchEndDeadline - performance.now();
          if (remainingMs <= 2) {
            stopRecording();
            return;
          }
          punchStopTimerRef.current = window.setTimeout(
            checkPunchEnd,
            Math.min(100, Math.max(4, remainingMs)),
          );
        };
        checkPunchEnd();
      } catch (error) {
        captureStartPendingRef.current = false;
        metronomeRef.current?.stop();
        metronomeRef.current = null;
        setCaptureState("idle");
        throw error;
      }
    },
    [
      beginMediaRecorder,
      captureState,
      metronomeEnabled,
      prepareMicrophone,
      riffBpm,
      riffTimeSignature,
      selectedDeviceId,
      stopRecording,
    ],
  );

  const playTake = useCallback(
    async (take: RecordingTake) => {
      if (captureState !== "idle") {
        setPlaybackError("녹음이 끝난 뒤 테이크를 재생할 수 있어요.");
        return;
      }
      const player = playerRef.current;
      if (!player) return;
      setPlaybackError(null);
      setSelectedTakeId(take.id);

      if (activePlayerTakeIdRef.current === take.id && !player.paused) {
        player.pause();
        return;
      }

      setAudioLoading(true);
      try {
        if (activePlayerTakeIdRef.current !== take.id) {
          player.pause();
          player.src = take.audioUrl;
          player.load();
          activePlayerTakeIdRef.current = take.id;
          player.currentTime = take.trimStartMs / 1_000;
          setPlaybackPosition(take.trimStartMs / 1_000);
        }
        await player.play();
      } catch (error) {
        setPlaybackError(
          error instanceof Error ? error.message : "오디오를 재생하지 못했어요.",
        );
      } finally {
        setAudioLoading(false);
      }
    },
    [captureState],
  );

  const toggleSelectedPlayback = useCallback(() => {
    if (selectedTake) void playTake(selectedTake);
  }, [playTake, selectedTake]);

  const seekPlayback = useCallback(
    (seconds: number) => {
      const player = playerRef.current;
      if (!player || !selectedTake) return;
      const minimum = selectedTake.trimStartMs / 1_000;
      const maximum =
        (selectedTake.trimEndMs ?? selectedTake.durationMs) / 1_000 ||
        playbackDuration;
      const nextTime = clamp(seconds, minimum, maximum);
      player.currentTime = nextTime;
      setPlaybackPosition(nextTime);
    },
    [playbackDuration, selectedTake],
  );

  const beginTakeMutation = useCallback((takeId: string) => {
    if (!takeMutationLockRef.current.tryAcquire(takeId)) return false;
    setPendingTakeId(takeId);
    return true;
  }, []);

  const endTakeMutation = useCallback((takeId: string) => {
    if (takeMutationLockRef.current.release(takeId)) setPendingTakeId(null);
  }, []);

  const syncTakeInspectorDraft = useCallback((take: RecordingTake | null) => {
    if (!take) {
      setNameDraft("");
      setTimingDraft(EMPTY_TIMING);
      return;
    }
    setNameDraft(take.name);
    setTimingDraft({
      trimStartMs: String(take.trimStartMs),
      trimEndMs: take.trimEndMs === null ? "" : String(take.trimEndMs),
      offsetMs: String(take.offsetMs),
    });
  }, []);

  const patchTake = useCallback(
    async (take: RecordingTake, body: Record<string, unknown>) => {
      if (!beginTakeMutation(take.id)) return;
      setTakeError(null);
      let requestError: unknown = null;
      try {
        const response = await fetch(`/api/takes/${encodeURIComponent(take.id)}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...body, expectedRevision: take.revision }),
          credentials: "include",
        });
        if (!response.ok) throw await responseError(response, "테이크를 수정하지 못했어요");
        const nextTakes = await refreshTakes();
        syncTakeInspectorDraft(
          nextTakes.find((item) => item.id === take.id) ?? null,
        );
      } catch (error) {
        requestError = error;
        const current = (await refreshTakes()).find((item) => item.id === take.id);
        syncTakeInspectorDraft(current ?? null);
        if (!mutationAlreadyApplied(current, body as Partial<RecordingTake>)) {
          setTakeError(
            requestError instanceof Error
              ? requestError.message
              : "테이크를 수정하지 못했어요.",
          );
        }
      } finally {
        endTakeMutation(take.id);
      }
    },
    [
      beginTakeMutation,
      endTakeMutation,
      refreshTakes,
      syncTakeInspectorDraft,
    ],
  );

  const deleteTake = useCallback(
    async (take: RecordingTake) => {
      if (
        !window.confirm(
          `“${take.name}” 테이크를 삭제할까요?\n\n저장된 Comp에서 사용 중인 테이크는 Comp에서 먼저 제거해야 해요.`,
        )
      ) {
        return;
      }
      if (!beginTakeMutation(take.id)) return;
      try {
        setTakeError(null);
        let requestError: unknown = null;
        try {
          const response = await fetch(`/api/takes/${encodeURIComponent(take.id)}`, {
            method: "DELETE",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ expectedRevision: take.revision }),
            credentials: "include",
          });
          if (!response.ok) throw await responseError(response, "테이크를 삭제하지 못했어요");
        } catch (error) {
          requestError = error;
        }
        const nextTakes = await refreshTakes();
        if (deletionAlreadyApplied(take.id, nextTakes)) {
          if (activePlayerTakeIdRef.current === take.id) {
            playerRef.current?.pause();
            if (playerRef.current) playerRef.current.removeAttribute("src");
            activePlayerTakeIdRef.current = null;
          }
        } else if (requestError) {
          setTakeError(
            requestError instanceof Error
              ? requestError.message
              : "테이크를 삭제하지 못했어요.",
          );
        }
      } finally {
        endTakeMutation(take.id);
      }
    },
    [beginTakeMutation, endTakeMutation, refreshTakes],
  );

  const duplicateTake = useCallback(
    async (take: RecordingTake) => {
      if (!beginTakeMutation(take.id)) return;
      try {
        setTakeError(null);
        const idsBeforeRequest = new Set(takes.map((item) => item.id));
        const duplicateStorage = browserStorage("sessionStorage");
        const duplicateRequest = getOrCreateTakeDuplicateRequest(
          duplicateStorage,
          riffId,
          take.id,
        );
        let createdTake: RecordingTake | null = null;
        let requestError: unknown = null;
        for (let attempt = 0; attempt < 2 && !createdTake; attempt += 1) {
          try {
            const response = await fetch(
              `/api/takes/${encodeURIComponent(take.id)}/duplicate`,
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ requestId: duplicateRequest.requestId }),
                credentials: "include",
              },
            );
            if (!response.ok) {
              const responseFailure = await responseError(
                response,
                "테이크를 복제하지 못했어요",
              );
              requestError = responseFailure;
              if (response.status < 500) {
                if (response.status === 400 || response.status === 409) {
                  completeTakeDuplicateRequest(
                    duplicateStorage,
                    duplicateRequest.storageKey,
                  );
                }
                break;
              }
              if (attempt === 1) break;
              continue;
            }
            const payload: unknown = await response.json().catch(() => null);
            createdTake =
              payload && typeof payload === "object" && "take" in payload
                ? normalizeTake((payload as { take: unknown }).take)
                : normalizeTake(payload);
            if (!createdTake) throw new Error("복제된 테이크 정보를 확인하지 못했어요.");
            completeTakeDuplicateRequest(
              duplicateStorage,
              duplicateRequest.storageKey,
            );
          } catch (error) {
            requestError = error;
          }
        }
        const nextTakes = await refreshTakes();
        const reconciled =
          createdTake ?? reconciledTakeDuplicate(take, idsBeforeRequest, nextTakes);
        if (reconciled) {
          completeTakeDuplicateRequest(
            duplicateStorage,
            duplicateRequest.storageKey,
          );
          setSelectedTakeId(reconciled.id);
        }
        else if (requestError) {
          setTakeError(
            requestError instanceof Error
              ? requestError.message
              : "테이크를 복제하지 못했어요.",
          );
        }
      } finally {
        endTakeMutation(take.id);
      }
    },
    [beginTakeMutation, endTakeMutation, refreshTakes, riffId, takes],
  );

  const splitSelectedTake = useCallback(async () => {
    if (!selectedTake) return;
    const splitMs = Math.round(playbackPosition * 1_000);
    const startMs = selectedTake.trimStartMs;
    const endMs = selectedTake.trimEndMs ?? selectedTake.durationMs;
    if (splitMs <= startMs + 50 || splitMs >= endMs - 50) {
      setTakeError("나눌 위치를 테이크의 시작과 끝 사이로 옮겨주세요.");
      return;
    }

    if (!beginTakeMutation(selectedTake.id)) return;
    try {
      setTakeError(null);
      const idsBeforeRequest = new Set(takes.map((take) => take.id));
      let newTake: RecordingTake | null = null;
      let requestError: unknown = null;
      try {
        const response = await fetch(
          `/api/takes/${encodeURIComponent(selectedTake.id)}/split`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              splitMs,
              expectedRevision: selectedTake.revision,
            }),
            credentials: "include",
          },
        );
        if (!response.ok) throw await responseError(response, "테이크를 나누지 못했어요");
        const splitTakes = extractTakes(await response.json());
        newTake = splitTakes.find((take) => take.id !== selectedTake.id) ?? null;
      } catch (error) {
        requestError = error;
      }
      const nextTakes = await refreshTakes();
      const reconciled =
        newTake ??
        reconciledTakeSplit(selectedTake, splitMs, idsBeforeRequest, nextTakes);
      if (reconciled) setSelectedTakeId(reconciled.id);
      else if (requestError) {
        setTakeError(
          requestError instanceof Error
            ? requestError.message
            : "테이크를 나누지 못했어요.",
        );
      }
    } finally {
      endTakeMutation(selectedTake.id);
    }
  }, [
    beginTakeMutation,
    endTakeMutation,
    playbackPosition,
    refreshTakes,
    selectedTake,
    takes,
  ]);

  const saveTiming = useCallback(() => {
    if (!selectedTake) return;
    const trimStartMs = numberFromInput(timingDraft.trimStartMs);
    const trimEndMs = timingDraft.trimEndMs.trim()
      ? numberFromInput(timingDraft.trimEndMs)
      : null;
    const maximum = Math.max(0, selectedTake.durationMs);
    const safeStart = clamp(trimStartMs, 0, maximum);
    const safeEnd =
      trimEndMs === null || safeStart >= maximum
        ? null
        : clamp(trimEndMs, safeStart + 1, maximum);
    void patchTake(selectedTake, {
      trimStartMs: safeStart,
      trimEndMs: safeEnd,
      offsetMs: numberFromInput(timingDraft.offsetMs),
    });
  }, [patchTake, selectedTake, timingDraft]);

  const saveName = useCallback(() => {
    if (!selectedTake) return;
    const name = nameDraft.trim();
    if (name && name !== selectedTake.name) void patchTake(selectedTake, { name });
  }, [nameDraft, patchTake, selectedTake]);

  const applyRiffValuesToForm = useCallback((value: Record<string, unknown>) => {
    if (typeof value.title === "string") setRiffTitle(value.title);
    if (typeof value.bpm === "number") {
      setRiffBpm(String(value.bpm));
      bpmRef.current = value.bpm;
    }
    if (typeof value.musicalKey === "string") setRiffKey(value.musicalKey);
    if (typeof value.tuning === "string") setRiffTuning(value.tuning);
    if (typeof value.timeSignature === "string") {
      setRiffTimeSignature(value.timeSignature);
      const beats = Number.parseInt(value.timeSignature.split("/")[0] ?? "4", 10);
      if (Number.isFinite(beats)) beatsPerBarRef.current = clamp(beats, 1, 32);
    }
    if (typeof value.notes === "string") setNotes(value.notes);
    if (typeof value.tab === "string") setTab(value.tab);
  }, []);

  const useCurrentRiffVersion = useCallback(() => {
    const conflict = riffPatchConflictRef.current;
    if (!conflict) return;
    const recoverySources = riffPatchRecoverySourcesRef.current;
    if (
      discardLocalRiffPatchSources(riffId, recoverySources) !==
      recoverySources.length
    ) {
      setSaveState("error");
      setSaveErrorMessage(
        "임시 내용 선택을 안전하게 기록하지 못했어요. 브라우저 저장 공간을 확인한 뒤 다시 시도해 주세요.",
      );
      return;
    }
    if (!persistLocalRiffPatch(riffId, conflict.current.revision, {})) {
      setSaveState("error");
      setSaveErrorMessage(
        "임시 내용을 정리하지 못했어요. 브라우저 저장 공간을 확인한 뒤 다시 시도해 주세요.",
      );
      return;
    }
    if (riffPatchTimerRef.current !== null) {
      window.clearTimeout(riffPatchTimerRef.current);
      riffPatchTimerRef.current = null;
    }
    applyRiffValuesToForm(conflict.current);
    pendingRiffPatchRef.current = {};
    riffRevisionRef.current = conflict.current.revision;
    riffPatchBaseRevisionRef.current = conflict.current.revision;
    riffPatchConflictRef.current = null;
    setRiffPatchConflict(null);
    riffPatchRecoverySourcesRef.current = [];
    setSaveErrorMessage(null);
    setSaveState("saved");
  }, [
    applyRiffValuesToForm,
    discardLocalRiffPatchSources,
    persistLocalRiffPatch,
    riffId,
  ]);

  const rebaseLocalRiffPatch = useCallback(() => {
    const conflict = riffPatchConflictRef.current;
    if (!conflict) return;
    const rebasedPatch = {
      ...conflict.localPatch,
      ...pendingRiffPatchRef.current,
    };
    if (
      !persistLocalRiffPatch(
        riffId,
        conflict.current.revision,
        rebasedPatch,
      )
    ) {
      setSaveState("error");
      setSaveErrorMessage(
        "내 내용을 안전하게 임시 보관하지 못했어요. 브라우저 저장 공간을 확인한 뒤 다시 시도해 주세요.",
      );
      return;
    }
    // Choosing the recovered local version consumes the exact source snapshots
    // that produced this draft. A losing divergent source stays durable, but
    // its unchanged value must not resurrect after the merged draft is saved.
    const recoverySources = riffPatchRecoverySourcesRef.current;
    if (
      discardLocalRiffPatchSources(riffId, recoverySources) !==
      recoverySources.length
    ) {
      setSaveState("error");
      setSaveErrorMessage(
        "내 내용은 보관했지만 이전 임시본 처리를 완료하지 못했어요. 저장 공간을 확인한 뒤 다시 시도해 주세요.",
      );
      return;
    }
    riffPatchRecoverySourcesRef.current = [];
    pendingRiffPatchRef.current = rebasedPatch;
    riffRevisionRef.current = conflict.current.revision;
    riffPatchBaseRevisionRef.current = conflict.current.revision;
    riffPatchConflictRef.current = null;
    setRiffPatchConflict(null);
    setSaveErrorMessage(null);
    setSaveState("waiting");
    if (riffPatchTimerRef.current !== null) {
      window.clearTimeout(riffPatchTimerRef.current);
    }
    riffPatchTimerRef.current = window.setTimeout(() => void flushRiffPatch(), 0);
  }, [
    discardLocalRiffPatchSources,
    flushRiffPatch,
    persistLocalRiffPatch,
    riffId,
  ]);

  useEffect(() => {
    const restoreTimer = window.setTimeout(() => {
      const stored = readLocalRiffPatch(riffId);
      riffPatchRecoverySourcesRef.current = stored.sources;
      const recoveredPatch = sanitizeLocalRiffPatch(stored.patch);
      persistLocalRiffPatch(riffId, stored.baseRevision, recoveredPatch);
      const recoveryState = classifyRiffPatchRecovery(
        initialRiffSnapshotRef.current,
        { ...stored, patch: recoveredPatch },
      );
      if (recoveryState === "empty") {
        riffPatchRecoverySourcesRef.current = [];
        return;
      }
      if (recoveryState === "already-applied") {
        // A pagehide keepalive (or an earlier request with a lost response)
        // may have committed while this owner-specific outbox remained. The
        // current server snapshot is the acknowledgement, so clear the stale
        // copy instead of presenting a conflict that did not occur.
        pendingRiffPatchRef.current = {};
        riffRevisionRef.current = initialRiffSnapshotRef.current.revision;
        riffPatchBaseRevisionRef.current = initialRiffSnapshotRef.current.revision;
        clearAppliedLocalRiffPatches(
          riffId,
          initialRiffSnapshotRef.current,
        );
        riffPatchRecoverySourcesRef.current = [];
        setSaveErrorMessage(null);
        setSaveState("saved");
        return;
      }
      riffPatchBaseRevisionRef.current = stored.baseRevision;
      pendingRiffPatchRef.current = {
        ...recoveredPatch,
        ...pendingRiffPatchRef.current,
      };
      applyRiffValuesToForm(recoveredPatch);
      if (recoveryState === "conflict") {
        const conflict = {
          current: initialRiffSnapshotRef.current,
          localPatch: recoveredPatch,
        };
        riffPatchConflictRef.current = conflict;
        setRiffPatchConflict(conflict);
        setSaveState("error");
        setSaveErrorMessage(
          stored.baseRevision === null
            ? "이전 버전에서 임시 보관한 내용이 있어요. 적용할 버전을 선택해 주세요."
            : "다른 창에서 이 리프가 변경됐어요. 임시 내용은 안전하게 보관했어요.",
        );
        return;
      }
      setSaveState("waiting");
      if (riffPatchTimerRef.current !== null) {
        window.clearTimeout(riffPatchTimerRef.current);
      }
      riffPatchTimerRef.current = window.setTimeout(() => void flushRiffPatch(), 100);
    }, 0);
    return () => window.clearTimeout(restoreTimer);
  }, [
    applyRiffValuesToForm,
    clearAppliedLocalRiffPatches,
    flushRiffPatch,
    persistLocalRiffPatch,
    readLocalRiffPatch,
    riffId,
  ]);

  useEffect(() => {
    mountedRef.current = true;
    if (draftUrlCleanupTimerRef.current !== null) {
      window.clearTimeout(draftUrlCleanupTimerRef.current);
      draftUrlCleanupTimerRef.current = null;
    }
    const initialDeviceRefresh = window.setTimeout(() => void refreshDevices(), 0);
    const handleDeviceChange = () => void refreshDevices();
    const player = playerRef.current;
    const draftObjectUrls = draftObjectUrlsRef.current;
    const draftIds = draftIdsRef.current;
    const recoveryUploads = recoveryUploadsRef.current;
    const flushPatchForExit = () => {
      activeSnapshotRef.current?.();
      const patch = {
        ...riffPatchInFlightPayloadRef.current,
        ...pendingRiffPatchRef.current,
      };
      const expectedRevision =
        riffPatchInFlightRevisionRef.current ?? riffPatchBaseRevisionRef.current;
      const persisted = persistLocalRiffPatch(riffId, expectedRevision, patch);
      riffPatchDurableRef.current = persisted || Object.keys(patch).length === 0;
      if (
        Object.keys(patch).length > 0 &&
        expectedRevision !== null &&
        !riffPatchConflictRef.current &&
        !riffPatchInFlightRef.current
      ) {
        void fetch(`/api/riffs/${encodeURIComponent(riffId)}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...patch, expectedRevision }),
          credentials: "include",
          keepalive: true,
        }).catch(() => undefined);
      }
    };
    const handlePageHide = () => {
      flushPatchForExit();
      cycleContinueRef.current = false;
      cycleNextDeadlineRef.current = 0;
      metronomeRef.current?.stop();
      recordingTransportRef.current?.stop();
      if (cycleTimerRef.current !== null) {
        window.clearTimeout(cycleTimerRef.current);
        cycleTimerRef.current = null;
      }
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        try {
          recorder.requestData();
        } catch {
          // stop() still dispatches the final dataavailable event when possible.
        }
        try {
          recorder.stop();
        } catch {
          // The recorder may already be stopping as the page is hidden.
        }
      }
    };
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      flushPatchForExit();
      const recorder = mediaRecorderRef.current;
      if (
        (recorder && recorder.state !== "inactive") ||
        !riffPatchDurableRef.current
      ) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "hidden") return;
      const recorder = mediaRecorderRef.current;
      if (recorder?.state === "recording") {
        try {
          recorder.requestData();
        } catch {
          // Existing chunks are still eligible for a recovery snapshot.
        }
      }
      activeSnapshotRef.current?.();
      if (!riffPatchInFlightRef.current) void flushRiffPatch();
    };
    navigator.mediaDevices?.addEventListener?.("devicechange", handleDeviceChange);
    window.addEventListener("beforeunload", handleBeforeUnload);
    window.addEventListener("pagehide", handlePageHide);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      flushPatchForExit();
      window.clearTimeout(initialDeviceRefresh);
      if (riffPatchTimerRef.current !== null) {
        window.clearTimeout(riffPatchTimerRef.current);
        riffPatchTimerRef.current = null;
      }
      if (tapTempoFeedbackTimerRef.current !== null) {
        window.clearTimeout(tapTempoFeedbackTimerRef.current);
        tapTempoFeedbackTimerRef.current = null;
      }
      if (countInTimerRef.current !== null) window.clearTimeout(countInTimerRef.current);
      if (cycleTimerRef.current !== null) window.clearTimeout(cycleTimerRef.current);
      if (punchStopTimerRef.current !== null) window.clearTimeout(punchStopTimerRef.current);
      draftUrlCleanupTimerRef.current = window.setTimeout(() => {
        for (const objectUrl of draftObjectUrls) URL.revokeObjectURL(objectUrl);
        draftObjectUrls.clear();
        draftIds.clear();
        draftUrlCleanupTimerRef.current = null;
      }, 0);
      countInRejectRef.current = null;
      cycleContinueRef.current = false;
      cycleNextDeadlineRef.current = 0;
      recordingActiveRef.current = false;
      captureStartPendingRef.current = false;
      recoveryUploads.clear();
      metronomeRef.current?.stop();
      metronomeRef.current = null;
      recordingTransportRef.current?.stop();
      recordingTransportRef.current = null;
      mountedRef.current = false;
      microphoneRequestIdRef.current += 1;
      navigator.mediaDevices?.removeEventListener?.("devicechange", handleDeviceChange);
      window.removeEventListener("beforeunload", handleBeforeUnload);
      window.removeEventListener("pagehide", handlePageHide);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        const recoveryId = activeRecordingRecoveryIdRef.current;
        const snapshotChunks = recordingChunksRef.current;
        if (recoveryId && snapshotChunks.length > 0) {
          const snapshotType =
            recorder.mimeType || snapshotChunks[0]?.type || "audio/webm";
          void retainFailedRecording(
            new Blob(snapshotChunks, { type: snapshotType }),
            Math.max(1, performance.now() - recordingStartedAtRef.current),
            snapshotType,
            recordingOffsetRef.current,
            undefined,
            recoveryId,
          );
        }
        try {
          recorder.requestData();
        } catch {
          // stop() still dispatches the final dataavailable event.
        }
        recorder.stop();
      } else {
        streamRef.current?.getTracks().forEach((track) => track.stop());
      }
      mediaRecorderRef.current = null;
      stopMonitoring();
      streamRef.current = null;
      if (player) {
        player.pause();
        player.removeAttribute("src");
      }
    };
  }, [
    flushRiffPatch,
    persistLocalRiffPatch,
    refreshDevices,
    retainFailedRecording,
    riffId,
    stopMonitoring,
  ]);

  useEffect(() => {
    const controller = new AbortController();
    const initialTakeRefresh = window.setTimeout(
      () => void refreshTakes(controller.signal),
      0,
    );
    return () => {
      window.clearTimeout(initialTakeRefresh);
      controller.abort();
    };
  }, [refreshTakes]);

  useEffect(() => {
    let cancelled = false;
    const recoveryLoad = window.setTimeout(() => {
      void listPendingRecordings(riffId)
        .then((stored) => {
          if (cancelled || !mountedRef.current) return;
          const recovered: RecordingDraft[] = [];
          for (const recording of stored) {
            if (draftIdsRef.current.has(recording.id)) continue;
            const objectUrl = URL.createObjectURL(recording.blob);
            draftObjectUrlsRef.current.add(objectUrl);
            draftIdsRef.current.add(recording.id);
            recovered.push({ ...recording, objectUrl });
          }
          if (recovered.length > 0) {
            setDrafts((current) => [...current, ...recovered]);
          }
        })
        .catch(() => undefined);
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(recoveryLoad);
    };
  }, [riffId]);

  useEffect(() => {
    if (!isRecording) return;
    const timer = window.setInterval(() => {
      setElapsedMs(performance.now() - recordingStartedAtRef.current);
    }, 100);
    return () => window.clearInterval(timer);
  }, [isRecording]);

  useEffect(() => {
    syncTakeInspectorDraft(selectedTake);
  }, [selectedTake, syncTakeInspectorDraft]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.repeat ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey
      ) {
        return;
      }
      if (isEditableTarget(event.target)) return;
      if (event.code === "Space" && selectedTake && captureState === "idle") {
        event.preventDefault();
        toggleSelectedPlayback();
      }
      if (event.code === "KeyR") {
        event.preventDefault();
        if (isPreparing || isCounting) cancelCountIn();
        else if (isRecording) stopRecording();
        else if (!isBusy) void startRecording();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    cancelCountIn,
    captureState,
    isBusy,
    isCounting,
    isPreparing,
    isRecording,
    selectedTake,
    startRecording,
    stopRecording,
    toggleSelectedPlayback,
  ]);

  const playbackMinimum = (selectedTake?.trimStartMs ?? 0) / 1_000;
  const playbackMaximum =
    (selectedTake?.trimEndMs ?? selectedTake?.durationMs ?? playbackDuration * 1_000) /
    1_000;
  const captureStatusLabel =
    captureState === "uploading"
      ? "녹음을 저장하고 있어요."
      : captureState === "processing"
        ? "녹음을 정리하고 있어요."
        : captureState === "preparing"
          ? "오디오 입력을 준비하고 있어요."
          : captureState === "counting"
            ? `${countInBars}마디 카운트인을 시작했어요.`
            : isRecording
              ? "녹음을 시작했어요."
              : "녹음할 준비가 됐어요.";

  function handleWritingTabKeyDown(
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) {
    let nextMode: "tab" | "notes" | null = null;
    if (event.key === "Home") nextMode = "tab";
    else if (event.key === "End") nextMode = "notes";
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextMode = writingMode === "tab" ? "notes" : "tab";
    } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextMode = writingMode === "tab" ? "notes" : "tab";
    }
    if (!nextMode) return;
    event.preventDefault();
    setWritingMode(nextMode);
    (nextMode === "tab"
      ? tabWritingTriggerRef.current
      : notesWritingTriggerRef.current
    )?.focus();
  }

  return (
    <section className={`${styles.studio} ${className ?? ""}`} aria-label={`${riffTitle || "새 리프"} 녹음 스튜디오`}>
      <header className={styles.header}>
        <div className={styles.titleGroup}>
          <span className={styles.eyebrow}>
            <Radio aria-hidden="true" size={14} /> 녹음 스튜디오
          </span>
          <input
            className={styles.titleInput}
            aria-label="리프 제목"
            aria-invalid={!riffTitle.trim()}
            maxLength={120}
            value={riffTitle}
            onChange={(event) => {
              const value = event.target.value;
              setRiffTitle(value);
              if (value.trim()) {
                setSaveErrorMessage(null);
                queueRiffPatch({ title: value });
              }
              else rejectRiffField("title", "리프 제목을 한 글자 이상 입력해 주세요.");
            }}
            onBlur={() => void flushRiffPatch()}
          />
        </div>
        <div className={styles.headerRight}>
          {metadataItems.length > 0 ? (
            <div className={styles.metadata} aria-label="리프 정보">
              {metadataItems.map((item) => (
                <span key={item}>{item}</span>
              ))}
            </div>
          ) : null}
          <span
            className={`${styles.saveState} ${visibleSaveState === "error" ? styles.saveError : ""}`}
            aria-live="polite"
            title={visibleSaveError ?? undefined}
          >
            {visibleSaveState === "saving"
              ? "저장 중"
              : visibleSaveState === "waiting"
                ? "변경됨"
                : visibleSaveState === "error"
                  ? "저장 실패"
                  : "저장됨"}
          </span>
        </div>
      </header>

      {visibleSaveError ? (
        <div className={styles.notice} role="alert">
          <AlertCircle aria-hidden="true" size={18} />
          <span>{visibleSaveError}</span>
          {riffPatchConflict ? (
            <>
              <button type="button" onClick={useCurrentRiffVersion}>
                다른 창의 내용 사용
              </button>
              <button type="button" onClick={rebaseLocalRiffPatch}>
                내 내용으로 저장
              </button>
            </>
          ) : null}
        </div>
      ) : null}

      <div className={styles.transport}>
        <div className={styles.inputControls}>
          <label className={styles.deviceSelect}>
            <Mic aria-hidden="true" size={17} />
            <span className={styles.srOnly}>오디오 입력</span>
            <select
              aria-label="오디오 입력 장치"
              value={selectedDeviceId}
              disabled={
                isPreparing || isRecording || isCounting || microphoneState === "requesting"
              }
              onChange={(event) => {
                const nextId = event.target.value;
                setSelectedDeviceId(nextId);
                if (hasStream) void prepareMicrophone(nextId);
              }}
            >
              {devices.length === 0 ? <option value="">기본 오디오 입력</option> : null}
              {devices.map((device, index) => (
                <option key={device.deviceId || `input-${index}`} value={device.deviceId}>
                  {device.label || `오디오 입력 ${index + 1}`}
                </option>
              ))}
            </select>
          </label>
          <button
            className={styles.secondaryButton}
            type="button"
            disabled={
              isPreparing || isRecording || isCounting || microphoneState === "requesting"
            }
            onClick={() => (hasStream ? stopMicrophone() : void prepareMicrophone(selectedDeviceId || undefined))}
          >
            {microphoneState === "requesting" ? (
              <LoaderCircle aria-hidden="true" className={styles.spin} size={16} />
            ) : hasStream ? (
              <X aria-hidden="true" size={16} />
            ) : (
              <Settings2 aria-hidden="true" size={16} />
            )}
            {hasStream ? "입력 끄기" : "입력 연결"}
          </button>
        </div>

        <div className={styles.counter}>
          <span className={isRecording ? styles.liveDot : styles.readyDot} aria-hidden="true" />
          <strong>{formatDuration(elapsedMs, true)}</strong>
          <small>
            {captureState === "uploading"
              ? "저장 중"
              : captureState === "processing"
                ? "정리 중"
                : captureState === "preparing"
                  ? "입력 준비 중"
                : captureState === "counting"
                  ? `${countInBars}마디 카운트인`
                : isRecording
                  ? "REC"
                  : "READY"}
          </small>
        </div>
        <span className={styles.srOnly} aria-live="polite" aria-atomic="true">
          {captureStatusLabel}
        </span>

        <button
          className={`${styles.recordButton} ${isPreparing || isRecording || isCounting ? styles.recording : ""}`}
          type="button"
          disabled={
            isFinalizing || (microphoneState === "requesting" && !isPreparing)
          }
          aria-label={
            isPreparing
              ? "녹음 준비 취소"
              : isCounting
                ? "카운트인 취소"
                : isRecording
                  ? "녹음 정지"
                  : "새 테이크 녹음"
          }
          onClick={() =>
            isPreparing || isCounting
              ? cancelCountIn()
              : isRecording
                ? stopRecording()
                : void startRecording()
          }
        >
          {isBusy ? (
            <LoaderCircle aria-hidden="true" className={styles.spin} size={22} />
          ) : isRecording || isCounting ? (
            <Square aria-hidden="true" fill="currentColor" size={18} />
          ) : (
            <span className={styles.recordGlyph} aria-hidden="true" />
          )}
          <span>
            {isPreparing
              ? "준비 취소"
              : isCounting
                ? "카운트인 취소"
                : isRecording
                  ? "녹음 정지"
                  : "새 테이크"}
          </span>
          <kbd>R</kbd>
        </button>
      </div>

      <div className={styles.recordSettings} aria-label="녹음 옵션">
        <button
          type="button"
          aria-pressed={metronomeEnabled}
          disabled={isPreparing || isRecording || isCounting}
          className={metronomeEnabled ? styles.optionActive : ""}
          onClick={() => setMetronomeEnabled((value) => !value)}
        >
          <AudioLines aria-hidden="true" size={15} /> 메트로놈
        </button>
        <label className={styles.selectOption}>
          <Timer aria-hidden="true" size={15} />
          <span>카운트인</span>
          <select
            aria-label="카운트인 마디 수"
            value={countInBars}
            disabled={isPreparing || isRecording || isCounting}
            onChange={(event) => setCountInBars(Number(event.target.value))}
          >
            <option value="0">없음</option>
            <option value="1">1마디</option>
            <option value="2">2마디</option>
          </select>
        </label>
        <label className={styles.checkboxOption}>
          <input
            type="checkbox"
            checked={cycleEnabled}
            disabled={isPreparing || isRecording || isCounting}
            onChange={(event) => {
              setCycleEnabled(event.target.checked);
              cycleEnabledRef.current = event.target.checked;
            }}
          />
          <Repeat2 aria-hidden="true" size={15} />
          <span>반복할 때마다 새 테이크</span>
        </label>
        <label className={styles.selectOption}>
          <span>반복 길이</span>
          <select
            aria-label="반복 녹음 길이"
            value={cycleBars}
            disabled={!cycleEnabled || isPreparing || isRecording || isCounting}
            onChange={(event) => {
              const value = Number(event.target.value);
              setCycleBars(value);
              cycleBarsRef.current = value;
            }}
          >
            {[1, 2, 4, 8, 16].map((bars) => (
              <option key={bars} value={bars}>{bars}마디</option>
            ))}
          </select>
        </label>
        {cycleEnabled && (isRecording || cycleTakeCount > 0) ? (
          <span className={styles.cycleStatus}>현재 Take {String(Math.max(1, cycleTakeCount)).padStart(2, "0")}</span>
        ) : null}
      </div>

      <div className={styles.monitorPanel}>
        <div className={styles.monitorLabel}>
          <AudioLines aria-hidden="true" size={17} />
          <span>{microphoneMessage(microphoneState, hasStream)}</span>
        </div>
        <canvas
          ref={monitorCanvasRef}
          className={styles.monitorCanvas}
          width={900}
          height={112}
          aria-label="실시간 입력 파형"
          role="img"
        />
        <div className={styles.levelGroup}>
          <span>-48</span>
          <div
            className={styles.levelMeter}
            role="meter"
            aria-label="입력 레벨"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(inputLevel * 100)}
          >
            <span style={{ width: `${inputLevel * 100}%` }} />
          </div>
          <span>0 dB</span>
        </div>
      </div>

      {microphoneError ? (
        <div className={styles.notice} role="alert">
          <AlertCircle aria-hidden="true" size={18} />
          <span>{microphoneError}</span>
          <button type="button" onClick={() => void prepareMicrophone(selectedDeviceId || undefined)}>
            다시 연결
          </button>
        </div>
      ) : null}

      {recordingError ? (
        <div className={styles.notice} role="alert">
          <AlertCircle aria-hidden="true" size={18} />
          <span>{recordingError}</span>
        </div>
      ) : null}

      {drafts.length > 0 ? (
        <div className={styles.draftStack} role="list" aria-label="복구 대기 중인 녹음">
          <div className={styles.draftStackHeader}>
            <strong>저장 대기 중인 녹음 {drafts.length}개</strong>
            <span>페이지를 이동해도 이 브라우저에서 다시 복구할 수 있어요.</span>
          </div>
          {drafts.map((draft, index) => (
            <div className={`${styles.notice} ${styles.draftNotice}`} role="listitem" key={draft.id}>
              <AlertCircle aria-hidden="true" size={18} />
              <span>
                임시 테이크 {index + 1} · {formatDuration(draft.durationMs)}
              </span>
              <audio className={styles.draftAudio} controls src={draft.objectUrl} />
              <button
                type="button"
                disabled={captureState !== "idle"}
                onClick={() =>
                  void uploadRecording(draft.blob, draft.durationMs, draft)
                }
              >
                <RotateCcw aria-hidden="true" size={15} /> 다시 저장
              </button>
              <a
                href={draft.objectUrl}
                download={`unsaved-take-${index + 1}.${extensionForMimeType(draft.mimeType)}`}
              >
                <Download aria-hidden="true" size={15} /> 파일 받기
              </a>
              <button
                aria-label={`임시 테이크 ${index + 1} 삭제`}
                type="button"
                onClick={() => {
                  if (window.confirm("아직 저장되지 않은 이 녹음을 영구 삭제할까요?")) {
                    clearDraft(draft);
                  }
                }}
              >
                <X aria-hidden="true" size={15} />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <section className={styles.documentPanel} aria-label="리프 정보와 작성 노트">
        <div className={styles.documentToolbar}>
          <div className={styles.writingTabs} role="tablist" aria-label="작성 화면">
            <button
              ref={tabWritingTriggerRef}
              id="riff-tab-trigger"
              type="button"
              role="tab"
              aria-selected={writingMode === "tab"}
              aria-controls="riff-writing-panel"
              tabIndex={writingMode === "tab" ? 0 : -1}
              className={writingMode === "tab" ? styles.activeWritingTab : ""}
              onClick={() => setWritingMode("tab")}
              onKeyDown={handleWritingTabKeyDown}
            >
              <AudioLines aria-hidden="true" size={15} /> TAB
            </button>
            <button
              ref={notesWritingTriggerRef}
              id="riff-notes-trigger"
              type="button"
              role="tab"
              aria-selected={writingMode === "notes"}
              aria-controls="riff-writing-panel"
              tabIndex={writingMode === "notes" ? 0 : -1}
              className={writingMode === "notes" ? styles.activeWritingTab : ""}
              onClick={() => setWritingMode("notes")}
              onKeyDown={handleWritingTabKeyDown}
            >
              <BookOpenText aria-hidden="true" size={15} /> 메모
            </button>
          </div>
          <div className={styles.riffFields}>
            <div className={styles.bpmField}>
              <label>
                <span>BPM</span>
                <input
                  type="number"
                  min="30"
                  max="300"
                  inputMode="numeric"
                  aria-invalid={
                    !Number.isInteger(Number(riffBpm)) ||
                    Number(riffBpm) < 30 ||
                    Number(riffBpm) > 300
                  }
                  value={riffBpm}
                  onChange={(event) => {
                    const value = event.target.value;
                    tapTempoStateRef.current = createTapTempoState();
                    if (tapTempoFeedbackTimerRef.current !== null) {
                      window.clearTimeout(tapTempoFeedbackTimerRef.current);
                      tapTempoFeedbackTimerRef.current = null;
                    }
                    setTapTempoFeedback(null);
                    setRiffBpm(value);
                    const bpm = Number(value);
                    if (Number.isInteger(bpm) && bpm >= 30 && bpm <= 300) {
                      setSaveErrorMessage(null);
                      bpmRef.current = bpm;
                      queueRiffPatch({ bpm });
                    } else {
                      rejectRiffField(
                        "bpm",
                        "BPM은 30부터 300 사이의 정수로 입력해 주세요.",
                      );
                    }
                  }}
                  onBlur={() => void flushRiffPatch()}
                />
              </label>
              <button
                type="button"
                className={styles.tapTempoButton}
                aria-label="BPM 탭 템포"
                title="연주 박자에 맞춰 두 번 이상 눌러 BPM 측정"
                onClick={handleTapTempo}
              >
                <Timer aria-hidden="true" size={13} />
                <span>{tapTempoFeedback?.label ?? "TAP"}</span>
              </button>
              <span
                className={styles.srOnly}
                role="status"
                aria-live="polite"
                aria-atomic="true"
              >
                {tapTempoFeedback?.announcement ?? ""}
              </span>
            </div>
            <label>
              <span>KEY</span>
              <input
                maxLength={20}
                placeholder="E minor"
                value={riffKey}
                onChange={(event) => {
                  setRiffKey(event.target.value);
                  queueRiffPatch({ musicalKey: event.target.value });
                }}
                onBlur={() => void flushRiffPatch()}
              />
            </label>
            <label>
              <span>박자</span>
              <input
                maxLength={12}
                placeholder="4/4"
                aria-invalid={!isValidTimeSignature(riffTimeSignature)}
                value={riffTimeSignature}
                onChange={(event) => {
                  const value = event.target.value;
                  setRiffTimeSignature(value);
                  if (isValidTimeSignature(value)) {
                    setSaveErrorMessage(null);
                    const beats = Number.parseInt(value.split("/")[0] ?? "4", 10);
                    beatsPerBarRef.current = clamp(beats, 1, 32);
                    queueRiffPatch({ timeSignature: value.trim() });
                  } else {
                    rejectRiffField(
                      "timeSignature",
                      "박자는 4/4처럼 입력해 주세요. 분모는 1, 2, 4, 8, 16, 32를 사용할 수 있어요.",
                    );
                  }
                }}
                onBlur={() => void flushRiffPatch()}
              />
            </label>
            <label className={styles.tuningField}>
              <span>튜닝</span>
              <input
                maxLength={40}
                placeholder="Standard"
                value={riffTuning}
                onChange={(event) => {
                  setRiffTuning(event.target.value);
                  queueRiffPatch({ tuning: event.target.value });
                }}
                onBlur={() => void flushRiffPatch()}
              />
            </label>
          </div>
        </div>
        <div className={styles.writingArea}>
          {writingMode === "tab" ? (
            <div
              id="riff-writing-panel"
              className={styles.tabEditor}
              role="tabpanel"
              aria-labelledby="riff-tab-trigger"
            >
              <textarea
                aria-label="기타 TAB"
                maxLength={100_000}
                value={tab}
                spellCheck={false}
                placeholder={"e|----------------|\nB|----------------|\nG|----------------|\nD|----------------|\nA|----------------|\nE|----------------|"}
                onChange={(event) => {
                  setTab(event.target.value);
                  queueRiffPatch({ tab: event.target.value });
                }}
                onBlur={() => void flushRiffPatch()}
              />
              <button
                type="button"
                className={styles.tabTemplateButton}
                disabled={tab.length > 99_880}
                onClick={() => {
                  const template = "e|----------------|\nB|----------------|\nG|----------------|\nD|----------------|\nA|----------------|\nE|----------------|";
                  const nextTab = tab.trim() ? `${tab.trimEnd()}\n\n${template}` : template;
                  setTab(nextTab);
                  queueRiffPatch({ tab: nextTab });
                }}
              >
                <WandSparkles aria-hidden="true" size={14} /> 6줄 추가
              </button>
            </div>
          ) : (
            <div
              id="riff-writing-panel"
              role="tabpanel"
              aria-labelledby="riff-notes-trigger"
            >
              <textarea
                className={styles.notesEditor}
                aria-label="리프 메모"
                maxLength={20_000}
                value={notes}
                placeholder="톤, 연주법, 다음에 이어볼 아이디어를 적어두세요."
                onChange={(event) => {
                  setNotes(event.target.value);
                  queueRiffPatch({ notes: event.target.value });
                }}
                onBlur={() => void flushRiffPatch()}
              />
            </div>
          )}
        </div>
      </section>

      <div className={styles.workspace}>
        <div className={styles.takesPanel}>
          <div className={styles.panelHeading}>
            <div>
              <h2>테이크</h2>
              <span>{takes.length}개</span>
            </div>
            <button
              type="button"
              aria-label="테이크 새로고침"
              disabled={loadingTakes || takeMutationPending}
              onClick={() => {
                setLoadingTakes(true);
                void refreshTakes();
              }}
            >
              <RefreshCw aria-hidden="true" className={loadingTakes ? styles.spin : ""} size={17} />
            </button>
          </div>

          {takeError ? (
            <div className={styles.inlineError} role="alert">
              <AlertCircle aria-hidden="true" size={16} /> {takeError}
            </div>
          ) : null}

          <div
            className={styles.takeList}
            aria-busy={loadingTakes || takeMutationPending}
          >
            {loadingTakes && takes.length === 0 ? (
              <div className={styles.emptyState}>
                <LoaderCircle aria-hidden="true" className={styles.spin} size={21} />
                테이크를 불러오는 중이에요
              </div>
            ) : null}
            {!loadingTakes && takes.length === 0 ? (
              <div className={styles.emptyState}>
                <Headphones aria-hidden="true" size={25} />
                <strong>아직 녹음된 테이크가 없어요</strong>
                <span>새 테이크를 누르거나 R 키로 첫 리프를 남겨보세요.</span>
              </div>
            ) : null}
            {takes.map((take) => {
              const selected = take.id === selectedTakeId;
              const playing = selected && isPlaying;
              const pending = pendingTakeId === take.id;
              return (
                <article
                  key={take.id}
                  className={`${styles.takeRow} ${selected ? styles.selectedTake : ""}`}
                  aria-current={selected ? "true" : undefined}
                  aria-busy={pending}
                >
                  <button
                    className={styles.takePlayButton}
                    type="button"
                    aria-label={playing ? `${take.name} 일시 정지` : `${take.name} 재생`}
                    disabled={takeMutationPending || captureState !== "idle"}
                    onClick={() => void playTake(take)}
                  >
                    {audioLoading && selected ? (
                      <LoaderCircle aria-hidden="true" className={styles.spin} size={17} />
                    ) : playing ? (
                      <Pause aria-hidden="true" fill="currentColor" size={15} />
                    ) : (
                      <Play aria-hidden="true" fill="currentColor" size={15} />
                    )}
                  </button>
                  <button
                    className={styles.takeIdentity}
                    type="button"
                    disabled={takeMutationPending}
                    onClick={() => setSelectedTakeId(take.id)}
                  >
                    <span className={styles.takeNumber}>{String(take.takeNo).padStart(2, "0")}</span>
                    <span className={styles.takeText}>
                      <strong>
                        {take.name}
                        {take.isPrimary ? <Star aria-label="대표 테이크" fill="currentColor" size={13} /> : null}
                      </strong>
                      <small>
                        {formatDuration(take.durationMs)}
                        {formatBytes(take.byteSize) ? ` · ${formatBytes(take.byteSize)}` : ""}
                        {formatCreatedAt(take.createdAt) ? ` · ${formatCreatedAt(take.createdAt)}` : ""}
                      </small>
                    </span>
                  </button>
                  <div className={styles.takeActions}>
                    <button
                      type="button"
                      aria-label={`${take.name} 대표 테이크로 지정`}
                      title="대표 테이크"
                      disabled={take.isPrimary || takeMutationPending}
                      onClick={() => void patchTake(take, { isPrimary: true })}
                    >
                      {pending ? (
                        <LoaderCircle aria-hidden="true" className={styles.spin} size={16} />
                      ) : take.isPrimary ? (
                        <Check aria-hidden="true" size={16} />
                      ) : (
                        <Star aria-hidden="true" size={16} />
                      )}
                    </button>
                    <button
                      type="button"
                      aria-label={`${take.name} 복제`}
                      title="복제"
                      disabled={takeMutationPending}
                      onClick={() => void duplicateTake(take)}
                    >
                      <Copy aria-hidden="true" size={16} />
                    </button>
                    <button
                      className={styles.deleteButton}
                      type="button"
                      aria-label={`${take.name} 삭제`}
                      title="삭제"
                      disabled={takeMutationPending}
                      onClick={() => void deleteTake(take)}
                    >
                      <Trash2 aria-hidden="true" size={16} />
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        </div>

        <aside
          className={styles.inspector}
          aria-label="선택한 테이크 설정"
          aria-busy={takeMutationPending}
        >
          <div className={styles.panelHeading}>
            <div>
              <h2>테이크 설정</h2>
              {takeMutationPending ? (
                <span role="status">
                  <LoaderCircle aria-hidden="true" className={styles.spin} size={13} />
                  변경사항 저장 중
                </span>
              ) : (
                <span>{selectedTake ? `Take ${String(selectedTake.takeNo).padStart(2, "0")}` : "선택 없음"}</span>
              )}
            </div>
          </div>
          {selectedTake ? (
            <div className={styles.inspectorBody}>
              <label className={styles.field}>
                <span>이름</span>
                <div className={styles.inlineField}>
                  <input
                    value={nameDraft}
                    maxLength={80}
                    disabled={takeMutationPending}
                    onChange={(event) => setNameDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.currentTarget.blur();
                        saveName();
                      }
                    }}
                    onBlur={saveName}
                  />
                  <button
                    type="button"
                    aria-label="테이크 이름 저장"
                    disabled={takeMutationPending}
                    onClick={saveName}
                  >
                    <Save aria-hidden="true" size={15} />
                  </button>
                </div>
              </label>
              <div className={styles.timingGrid}>
                <label className={styles.field}>
                  <span>앞 자르기</span>
                  <div className={styles.unitInput}>
                    <input
                      inputMode="numeric"
                      min="0"
                      type="number"
                      value={timingDraft.trimStartMs}
                      disabled={takeMutationPending}
                      onChange={(event) =>
                        setTimingDraft((current) => ({ ...current, trimStartMs: event.target.value }))
                      }
                    />
                    <span>ms</span>
                  </div>
                </label>
                <label className={styles.field}>
                  <span>뒤 종료</span>
                  <div className={styles.unitInput}>
                    <input
                      inputMode="numeric"
                      min="0"
                      placeholder={String(selectedTake.durationMs)}
                      type="number"
                      value={timingDraft.trimEndMs}
                      disabled={takeMutationPending}
                      onChange={(event) =>
                        setTimingDraft((current) => ({ ...current, trimEndMs: event.target.value }))
                      }
                    />
                    <span>ms</span>
                  </div>
                </label>
                <label className={styles.field}>
                  <span>시작 위치</span>
                  <div className={styles.unitInput}>
                    <input
                      inputMode="numeric"
                      min="0"
                      type="number"
                      value={timingDraft.offsetMs}
                      disabled={takeMutationPending}
                      onChange={(event) =>
                        setTimingDraft((current) => ({ ...current, offsetMs: event.target.value }))
                      }
                    />
                    <span>ms</span>
                  </div>
                </label>
              </div>
              <button
                className={styles.saveTimingButton}
                type="button"
                disabled={takeMutationPending}
                onClick={saveTiming}
              >
                {takeMutationPending ? (
                  <LoaderCircle aria-hidden="true" className={styles.spin} size={16} />
                ) : (
                  <Save aria-hidden="true" size={16} />
                )}
                구간 저장
              </button>
              <button
                className={styles.splitButton}
                type="button"
                disabled={
                  takeMutationPending ||
                  playbackPosition * 1_000 <= selectedTake.trimStartMs + 50 ||
                  playbackPosition * 1_000 >=
                    (selectedTake.trimEndMs ?? selectedTake.durationMs) - 50
                }
                onClick={() => void splitSelectedTake()}
              >
                <Scissors aria-hidden="true" size={15} /> 재생 위치에서 나누기
              </button>
              <p className={styles.inspectorHint}>
                시작 위치는 여러 트랙에서 이 테이크가 들어올 시점을 정해요. 파형을 재생해 위치를 잡은 뒤 두 구간으로 나눌 수도 있어요.
              </p>
            </div>
          ) : (
            <div className={styles.emptyInspector}>설정할 테이크를 선택해 주세요.</div>
          )}
        </aside>
      </div>

      <AdvancedStudioTools
        riffId={riffId}
        takes={takes}
        bpm={Number(riffBpm) || 120}
        timeSignature={riffTimeSignature}
        sharedStream={activeStream}
        captureInProgress={captureLocksStudioTransport(captureState)}
        onPunchRequest={handlePunchRequest}
        onYouTubeRecordingRequest={startRecording}
        onYouTubePlaybackInterrupted={handleYouTubePlaybackInterrupted}
        onRecordingTransportReady={handleRecordingTransportReady}
      />

      <div className={styles.playerBar}>
        <audio
          ref={playerRef}
          preload="metadata"
          onDurationChange={(event) => setPlaybackDuration(event.currentTarget.duration || 0)}
          onEnded={() => {
            setIsPlaying(false);
            if (selectedTake) seekPlayback(selectedTake.trimStartMs / 1_000);
          }}
          onError={() => {
            setIsPlaying(false);
            setAudioLoading(false);
            setPlaybackError("오디오 파일을 불러오지 못했어요.");
          }}
          onPause={() => setIsPlaying(false)}
          onPlay={() => setIsPlaying(true)}
          onTimeUpdate={(event) => {
            const current = event.currentTarget.currentTime;
            setPlaybackPosition(current);
            if (
              selectedTake?.trimEndMs !== null &&
              selectedTake?.trimEndMs !== undefined &&
              current >= selectedTake.trimEndMs / 1_000
            ) {
              event.currentTarget.pause();
              event.currentTarget.currentTime = selectedTake.trimStartMs / 1_000;
            }
          }}
        />
        <button
          className={styles.mainPlayButton}
          type="button"
          disabled={!selectedTake || audioLoading || captureState !== "idle"}
          aria-label={isPlaying ? "선택한 테이크 일시 정지" : "선택한 테이크 재생"}
          onClick={toggleSelectedPlayback}
        >
          {audioLoading ? (
            <LoaderCircle aria-hidden="true" className={styles.spin} size={18} />
          ) : isPlaying ? (
            <Pause aria-hidden="true" fill="currentColor" size={17} />
          ) : (
            <Play aria-hidden="true" fill="currentColor" size={17} />
          )}
        </button>
        <div className={styles.nowPlaying}>
          <strong>{selectedTake?.name ?? "테이크를 선택해 주세요"}</strong>
          <span>
            {selectedTake
              ? `${formatDuration(Math.max(0, (playbackPosition - playbackMinimum) * 1_000))} / ${formatDuration(Math.max(0, (playbackMaximum - playbackMinimum) * 1_000))}`
              : "—"}
          </span>
        </div>
        <label className={styles.scrubber}>
          <span className={styles.srOnly}>재생 위치</span>
          <input
            type="range"
            min={playbackMinimum}
            max={Math.max(playbackMinimum + 0.01, playbackMaximum)}
            step="0.01"
            value={clamp(playbackPosition, playbackMinimum, Math.max(playbackMinimum, playbackMaximum))}
            disabled={!selectedTake}
            onChange={(event) => seekPlayback(Number(event.target.value))}
            style={
              {
                "--progress": `${
                  playbackMaximum > playbackMinimum
                    ? ((clamp(playbackPosition, playbackMinimum, playbackMaximum) - playbackMinimum) /
                        (playbackMaximum - playbackMinimum)) *
                      100
                    : 0
                }%`,
              } as React.CSSProperties
            }
          />
        </label>
        <Volume2 aria-hidden="true" className={styles.volumeIcon} size={18} />
        <span className={styles.shortcutHint}><kbd>Space</kbd> 재생</span>
      </div>
      {playbackError ? <p className={styles.playbackError} role="alert">{playbackError}</p> : null}
    </section>
  );
}
