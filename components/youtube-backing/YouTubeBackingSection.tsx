"use client";

import {
  ChevronDown,
  Headphones,
  Link2,
  LoaderCircle,
  Plus,
  Save,
  SlidersHorizontal,
  Trash2,
  Video,
} from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import type { YouTubeBackingSource } from "@/types/domain";

import styles from "./YouTubeBackingSection.module.css";
import { YouTubeBackingPlayer } from "./YouTubeBackingPlayer";
import type { YouTubeBackingPlayerHandle } from "./types";
import { parseYouTubeUrl } from "./youtube-url";

type Draft = {
  url: string;
  name: string;
  sourceStartSeconds: string;
  volume: number;
  syncEnabled: boolean;
};

export type YouTubeBackingTransport = Readonly<{
  isEnabled: () => boolean;
  /** Primes browser playback permission inside the recording button gesture. */
  prime: () => Promise<void>;
  start: () => Promise<void>;
  stop: () => void;
}>;

export type YouTubeBackingSectionProps = Readonly<{
  riffId: string;
  disabled?: boolean;
  onTransportChange?: (transport: YouTubeBackingTransport | null) => void;
  onSyncEnabledChange?: (enabled: boolean) => void;
  onPlaybackInterrupted?: (message: string) => void;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeSource(value: unknown): YouTubeBackingSource | null {
  if (!isRecord(value)) return null;
  const volume = Number(value.volume);
  if (
    typeof value.id !== "string" ||
    typeof value.riffId !== "string" ||
    typeof value.videoId !== "string" ||
    typeof value.url !== "string" ||
    typeof value.name !== "string" ||
    !Number.isInteger(value.sourceStartMs) ||
    Number(value.sourceStartMs) < 0 ||
    !Number.isFinite(volume) ||
    volume < 0 ||
    volume > 1 ||
    typeof value.syncEnabled !== "boolean" ||
    !Number.isInteger(value.revision) ||
    Number(value.revision) < 0 ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return null;
  }
  return {
    id: value.id,
    riffId: value.riffId,
    videoId: value.videoId,
    url: value.url,
    name: value.name,
    sourceStartMs: Number(value.sourceStartMs),
    volume,
    syncEnabled: value.syncEnabled,
    revision: Number(value.revision),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function sourceFromPayload(payload: unknown): YouTubeBackingSource | null {
  if (!isRecord(payload)) return null;
  return normalizeSource(payload.youtubeBacking);
}

function currentFromConflict(payload: unknown): YouTubeBackingSource | null {
  return isRecord(payload) ? normalizeSource(payload.current) : null;
}

function emptyDraft(): Draft {
  return {
    url: "",
    name: "YouTube 참고 트랙",
    sourceStartSeconds: "0",
    volume: 0.8,
    syncEnabled: false,
  };
}

function draftFromSource(source: YouTubeBackingSource | null): Draft {
  if (!source) return emptyDraft();
  return {
    url: source.url,
    name: source.name,
    sourceStartSeconds: String(source.sourceStartMs / 1_000),
    volume: source.volume,
    syncEnabled: source.syncEnabled,
  };
}

function errorMessage(payload: unknown, fallback: string): string {
  return isRecord(payload) && typeof payload.error === "string"
    ? payload.error
    : fallback;
}

function desiredMatches(
  source: YouTubeBackingSource | null,
  desired: {
    videoId: string;
    name: string;
    sourceStartMs: number;
    volume: number;
    syncEnabled: boolean;
  },
) {
  return Boolean(
    source &&
      source.videoId === desired.videoId &&
      source.name === desired.name &&
      source.sourceStartMs === desired.sourceStartMs &&
      Math.abs(source.volume - desired.volume) < 0.000_001 &&
      source.syncEnabled === desired.syncEnabled,
  );
}

export function YouTubeBackingSection({
  riffId,
  disabled = false,
  onTransportChange,
  onSyncEnabledChange,
  onPlaybackInterrupted,
}: YouTubeBackingSectionProps) {
  const sectionId = useId();
  const playerRef = useRef<YouTubeBackingPlayerHandle | null>(null);
  const transportActiveRef = useRef(false);
  const playbackAnchorRef = useRef<{
    videoSeconds: number;
    observedAtMs: number;
  } | null>(null);
  const lastPlayerErrorRef = useRef<string | null>(null);
  const sourceRef = useRef<YouTubeBackingSource | null>(null);
  const settingsDetailsRef = useRef<HTMLDetailsElement>(null);
  const onTransportChangeRef = useRef(onTransportChange);
  const onSyncEnabledChangeRef = useRef(onSyncEnabledChange);
  const reportedSyncEnabledRef = useRef(false);
  const [source, setSource] = useState<YouTubeBackingSource | null>(null);
  const [draft, setDraft] = useState<Draft>(() => emptyDraft());
  const [loading, setLoading] = useState(true);
  const [playerReady, setPlayerReady] = useState(false);
  const [busy, setBusy] = useState<"save" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorField, setErrorField] = useState<"url" | "name" | "start" | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    onTransportChangeRef.current = onTransportChange;
  }, [onTransportChange]);

  useEffect(() => {
    onSyncEnabledChangeRef.current = onSyncEnabledChange;
  }, [onSyncEnabledChange]);

  useEffect(() => {
    sourceRef.current = source;
  }, [source]);

  const fetchSource = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(
      `/api/riffs/${encodeURIComponent(riffId)}/youtube-backing`,
      { credentials: "include", cache: "no-store", signal },
    );
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(errorMessage(payload, "YouTube 참고 트랙을 불러오지 못했어요."));
    return sourceFromPayload(payload);
  }, [riffId]);

  useEffect(() => {
    const controller = new AbortController();
    void fetchSource(controller.signal)
      .then((loaded) => {
        setSource(loaded);
        setDraft(draftFromSource(loaded));
      })
      .catch((loadError) => {
        if (loadError instanceof DOMException && loadError.name === "AbortError") return;
        setErrorField(null);
        setError(loadError instanceof Error ? loadError.message : "YouTube 참고 트랙을 불러오지 못했어요.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [fetchSource]);

  const transport = useMemo<YouTubeBackingTransport>(() => ({
    isEnabled: () => Boolean(sourceRef.current?.syncEnabled),
    prime: async () => {
      const current = sourceRef.current;
      if (!current?.syncEnabled) return;
      const player = playerRef.current;
      if (!player?.isReady()) {
        throw new Error("YouTube 플레이어가 아직 준비되지 않았어요.");
      }
      if (!player.isMostlyVisible()) {
        throw new Error(
          "YouTube 영상이 절반 이상 보이도록 이동한 뒤 다시 녹음해 주세요.",
        );
      }
      await player.playFrom(current.sourceStartMs / 1_000, current.volume * 100);
      player.pauseAndReset(current.sourceStartMs / 1_000);
    },
    start: async () => {
      const current = sourceRef.current;
      if (!current?.syncEnabled) return;
      const player = playerRef.current;
      if (!player?.isReady()) {
        throw new Error("YouTube 플레이어가 아직 준비되지 않았어요.");
      }
      if (!player.isMostlyVisible()) {
        throw new Error(
          "YouTube 플레이어가 화면에 보이도록 이동한 뒤 다시 녹음해 주세요.",
        );
      }
      try {
        await player.playFrom(current.sourceStartMs / 1_000, current.volume * 100);
        transportActiveRef.current = true;
        playbackAnchorRef.current = {
          videoSeconds: player.getCurrentTime(),
          observedAtMs: performance.now(),
        };
      } catch (startError) {
        transportActiveRef.current = false;
        playbackAnchorRef.current = null;
        throw startError;
      }
    },
    stop: () => {
      transportActiveRef.current = false;
      playbackAnchorRef.current = null;
      const current = sourceRef.current;
      if (!current?.syncEnabled) return;
      playerRef.current?.pauseAndReset(current.sourceStartMs / 1_000);
    },
  }), []);

  useEffect(() => {
    onTransportChangeRef.current?.(transport);
    return () => onTransportChangeRef.current?.(null);
  }, [transport]);

  useEffect(() => {
    if (errorField && settingsDetailsRef.current) {
      settingsDetailsRef.current.open = true;
    }
  }, [errorField]);

  useEffect(() => {
    if (loading) return;
    const nextEnabled = Boolean(source?.syncEnabled);
    reportedSyncEnabledRef.current = nextEnabled;
    onSyncEnabledChangeRef.current?.(nextEnabled);
  }, [loading, source?.syncEnabled]);

  useEffect(() => () => {
    if (reportedSyncEnabledRef.current) {
      onSyncEnabledChangeRef.current?.(false);
    }
  }, []);

  const interruptActiveTransport = useCallback((message: string) => {
    if (!transportActiveRef.current) return;
    transportActiveRef.current = false;
    playbackAnchorRef.current = null;
    onPlaybackInterrupted?.(message);
  }, [onPlaybackInterrupted]);

  const save = useCallback(async () => {
    if (disabled || busy) return;
    const parsed = parseYouTubeUrl(draft.url);
    const sourceStartSeconds = Number(draft.sourceStartSeconds);
    const name = draft.name.trim();
    if (!parsed) {
      setErrorField("url");
      setError("올바른 YouTube 영상 링크를 입력해 주세요.");
      return;
    }
    if (!name) {
      setErrorField("name");
      setError("참고 트랙 이름을 입력해 주세요.");
      return;
    }
    if (
      !Number.isFinite(sourceStartSeconds) ||
      sourceStartSeconds < 0 ||
      sourceStartSeconds > 86_400
    ) {
      setErrorField("start");
      setError("영상 시작 위치는 0초부터 86,400초 사이로 입력해 주세요.");
      return;
    }
    const desired = {
      videoId: parsed.videoId,
      name,
      sourceStartMs: Math.round(sourceStartSeconds * 1_000),
      volume: draft.volume,
      syncEnabled: draft.syncEnabled,
    };
    setBusy("save");
    setErrorField(null);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/riffs/${encodeURIComponent(riffId)}/youtube-backing`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            url: parsed.canonicalUrl,
            name: desired.name,
            sourceStartMs: desired.sourceStartMs,
            volume: desired.volume,
            syncEnabled: desired.syncEnabled,
            expectedRevision: sourceRef.current?.revision ?? null,
          }),
        },
      );
      const payload: unknown = await response.json().catch(() => null);
      if (response.status === 409) {
        const current = currentFromConflict(payload);
        sourceRef.current = current;
        setSource(current);
        throw new Error(
          `${errorMessage(payload, "다른 화면에서 링크가 변경됐어요.")} 입력한 내용은 그대로 두었으니 확인 후 다시 저장해 주세요.`,
        );
      }
      if (!response.ok) throw new Error(errorMessage(payload, "YouTube 링크를 저장하지 못했어요."));
      const saved = sourceFromPayload(payload);
      if (!saved) throw new Error("저장된 YouTube 참고 트랙을 읽지 못했어요.");
      sourceRef.current = saved;
      setSource(saved);
      setDraft(draftFromSource(saved));
      setMessage(saved.syncEnabled
        ? "YouTube 참고 트랙을 저장했어요. 플레이어가 보이는 상태에서 녹음을 시작할 수 있어요."
        : "YouTube 참고 트랙을 저장했어요.");
    } catch (saveError) {
      if (!(saveError instanceof Error && saveError.message.includes("입력한 내용은 그대로"))) {
        try {
          const current = await fetchSource();
          sourceRef.current = current;
          setSource(current);
          if (desiredMatches(current, desired)) {
            setDraft(draftFromSource(current));
            setMessage("YouTube 참고 트랙이 저장된 것을 확인했어요.");
            return;
          }
        } catch {
          // Preserve the current screen and the user's draft when reconciliation fails.
        }
      }
      setError(saveError instanceof Error ? saveError.message : "YouTube 링크를 저장하지 못했어요.");
    } finally {
      setBusy(null);
    }
  }, [busy, disabled, draft, fetchSource, riffId]);

  const remove = useCallback(async () => {
    const current = sourceRef.current;
    if (!current || disabled || busy) return;
    if (!window.confirm("이 리프에서 YouTube 참고 트랙을 제거할까요?")) return;
    setBusy("delete");
    setErrorField(null);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/riffs/${encodeURIComponent(riffId)}/youtube-backing`,
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ expectedRevision: current.revision }),
        },
      );
      const payload: unknown = await response.json().catch(() => null);
      if (response.status === 409) {
        const latest = currentFromConflict(payload);
        sourceRef.current = latest;
        setSource(latest);
        setDraft(draftFromSource(latest));
        throw new Error("다른 화면에서 변경된 최신 YouTube 참고 트랙을 불러왔어요.");
      }
      if (!response.ok) throw new Error(errorMessage(payload, "YouTube 참고 트랙을 제거하지 못했어요."));
      playerRef.current?.pause();
      sourceRef.current = null;
      setSource(null);
      setDraft(emptyDraft());
      setMessage("YouTube 참고 트랙을 제거했어요.");
    } catch (removeError) {
      const latest = await fetchSource().catch(() => current);
      if (!latest) {
        sourceRef.current = null;
        setSource(null);
        setDraft(emptyDraft());
        setMessage("YouTube 참고 트랙이 제거된 것을 확인했어요.");
      } else {
        sourceRef.current = latest;
        setSource(latest);
        setDraft(draftFromSource(latest));
        setError(removeError instanceof Error ? removeError.message : "YouTube 참고 트랙을 제거하지 못했어요.");
      }
    } finally {
      setBusy(null);
    }
  }, [busy, disabled, fetchSource, riffId]);

  const controlsLocked = disabled || busy !== null;
  const helpId = `${sectionId}-help`;
  const errorId = `${sectionId}-error`;
  const urlInputId = `${sectionId}-url`;
  const syncInputId = `${sectionId}-sync`;

  return (
    <section
      className={styles.section}
      aria-label="YouTube 백킹 트랙"
      aria-busy={loading || busy !== null || undefined}
      data-youtube-backing-section
    >
      {loading || !source ? (
        <header className={styles.addHeading}>
          <div>
            <Video size={17} aria-hidden="true" />
            <div>
              <h4>YouTube 백킹</h4>
              <p>공식 플레이어 링크를 반주 트랙으로 연결합니다.</p>
            </div>
          </div>
          <span>선택 사항</span>
        </header>
      ) : null}

      {loading ? (
        <p className={styles.loading} role="status">
          <LoaderCircle className={styles.spin} size={15} aria-hidden="true" />
          YouTube 백킹 확인 중
        </p>
      ) : source ? (
        <div className={styles.connectedTrack}>
          <YouTubeBackingPlayer
            key={`${source.id}:${source.revision}`}
            ref={playerRef}
            url={source.url}
            title={source.name}
            startSeconds={source.sourceStartMs / 1_000}
            initialVolume={source.volume * 100}
            syncEnabled={source.syncEnabled}
            customControlsDisabled={disabled}
            onControllerChange={(controller) => {
              playerRef.current = controller;
              setPlayerReady(Boolean(controller?.isReady()));
            }}
            onStatusChange={(status) => {
              if (status === "playing" && lastPlayerErrorRef.current) {
                const resolvedPlayerError = lastPlayerErrorRef.current;
                lastPlayerErrorRef.current = null;
                setError((currentError) =>
                  currentError === resolvedPlayerError ? null : currentError,
                );
              }
              if (
                !transportActiveRef.current ||
                !["paused", "stopped", "ended", "error"].includes(status)
              ) {
                return;
              }
              interruptActiveTransport(
                status === "ended"
                  ? "YouTube 영상이 끝나 백킹 녹음을 마쳤어요."
                  : status === "error"
                    ? "YouTube 재생 오류로 백킹 녹음을 마쳤어요."
                    : "YouTube 백킹이 중지되어 녹음을 마쳤어요.",
              );
            }}
            onPlaybackInterrupted={interruptActiveTransport}
            onTimeUpdate={(currentTime) => {
              const anchor = playbackAnchorRef.current;
              if (!transportActiveRef.current || !anchor) return;
              const expectedTime =
                anchor.videoSeconds +
                Math.max(0, performance.now() - anchor.observedAtMs) / 1_000;
              if (Math.abs(currentTime - expectedTime) <= 1.25) return;
              interruptActiveTransport(
                "YouTube 재생 위치가 바뀌어 백킹 녹음을 중단했어요.",
              );
            }}
            onError={(playerError) => {
              setErrorField(null);
              lastPlayerErrorRef.current = playerError.message;
              setError(playerError.message);
            }}
            onAutoplayBlocked={() => {
              const autoplayMessage =
                "브라우저가 자동 재생을 막았어요. 플레이어의 재생 버튼을 한 번 누른 뒤 다시 시도해 주세요.";
              setErrorField(null);
              lastPlayerErrorRef.current = autoplayMessage;
              setError(autoplayMessage);
            }}
          />

          <div className={styles.syncDock} data-enabled={source.syncEnabled || undefined}>
            <div>
              <Headphones size={16} aria-hidden="true" />
              <p>
                <strong>{source.syncEnabled ? "상단 새 테이크 버튼으로 함께 녹음" : "녹음 동기화 꺼짐"}</strong>
                <span>
                  {source.syncEnabled
                    ? playerReady
                      ? "영상이 절반 이상 보이는 상태를 유지해 주세요. 헤드폰을 권장해요."
                      : "공식 플레이어가 준비되면 상단 REC와 함께 시작할 수 있어요."
                    : "필요하면 아래 트랙 설정에서 동기화를 켜고 저장하세요."}
                </span>
              </p>
            </div>
            <span>{source.syncEnabled ? "REC 연동" : "수동 재생"}</span>
          </div>

          <details className={styles.settingsDisclosure} ref={settingsDetailsRef}>
            <summary>
              <span><SlidersHorizontal size={15} aria-hidden="true" /> 트랙 설정</span>
              <span>
                {source.syncEnabled ? "녹음 동기화 켜짐" : "녹음 동기화 꺼짐"}
                <ChevronDown size={15} aria-hidden="true" />
              </span>
            </summary>

            <form
              className={styles.settingsForm}
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <fieldset disabled={controlsLocked}>
                <label className={styles.urlField} htmlFor={urlInputId}>
                  <span>YouTube 영상 링크</span>
                  <div>
                    <Link2 size={15} aria-hidden="true" />
                    <input
                      id={urlInputId}
                      type="url"
                      inputMode="url"
                      value={draft.url}
                      maxLength={2_048}
                      aria-describedby={`${helpId}${error && errorField === "url" ? ` ${errorId}` : ""}`}
                      aria-invalid={errorField === "url" || undefined}
                      onChange={(event) => {
                        setDraft((current) => ({ ...current, url: event.target.value }));
                        if (errorField === "url") {
                          setErrorField(null);
                          setError(null);
                        }
                      }}
                    />
                  </div>
                </label>

                <div className={styles.settingsGrid}>
                  <label>
                    <span>트랙 이름</span>
                    <input
                      value={draft.name}
                      maxLength={120}
                      aria-describedby={error && errorField === "name" ? errorId : undefined}
                      aria-invalid={errorField === "name" || undefined}
                      onChange={(event) => {
                        setDraft((current) => ({ ...current, name: event.target.value }));
                        if (errorField === "name") {
                          setErrorField(null);
                          setError(null);
                        }
                      }}
                    />
                  </label>
                  <label>
                    <span>시작점</span>
                    <div className={styles.unitInput}>
                      <input
                        type="number"
                        min={0}
                        max={86_400}
                        step={0.1}
                        inputMode="decimal"
                        value={draft.sourceStartSeconds}
                        aria-describedby={error && errorField === "start" ? errorId : undefined}
                        aria-invalid={errorField === "start" || undefined}
                        onChange={(event) => {
                          setDraft((current) => ({
                            ...current,
                            sourceStartSeconds: event.target.value,
                          }));
                          if (errorField === "start") {
                            setErrorField(null);
                            setError(null);
                          }
                        }}
                      />
                      <em>초</em>
                    </div>
                  </label>
                  <label className={styles.volumeField}>
                    <span>녹음 시작 볼륨 <output>{Math.round(draft.volume * 100)}%</output></span>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={draft.volume}
                      onChange={(event) => setDraft((current) => ({
                        ...current,
                        volume: Number(event.target.value),
                      }))}
                    />
                  </label>
                </div>

                <label className={styles.syncChoice} htmlFor={syncInputId}>
                  <input
                    id={syncInputId}
                    type="checkbox"
                    checked={draft.syncEnabled}
                    onChange={(event) => setDraft((current) => ({
                      ...current,
                      syncEnabled: event.target.checked,
                    }))}
                  />
                  <span>
                    <strong>새 테이크 녹음과 함께 시작</strong>
                    <small>영상이 화면에 절반 이상 보일 때만 동기 재생을 시작합니다.</small>
                  </span>
                </label>

                <p className={styles.help} id={helpId}>
                  YouTube는 다운로드하지 않아요. 파형 편집과 WAV 믹스다운에는 MP3/WAV 파일을 사용하세요.
                </p>

                <div className={styles.formActions}>
                  <button type="submit" className={styles.saveButton}>
                    {busy === "save" ? (
                      <LoaderCircle className={styles.spin} size={15} aria-hidden="true" />
                    ) : (
                      <Save size={15} aria-hidden="true" />
                    )}
                    변경 저장
                  </button>
                  <button type="button" className={styles.deleteButton} onClick={() => void remove()}>
                    {busy === "delete" ? (
                      <LoaderCircle className={styles.spin} size={15} aria-hidden="true" />
                    ) : (
                      <Trash2 size={15} aria-hidden="true" />
                    )}
                    트랙 제거
                  </button>
                </div>
              </fieldset>
            </form>
          </details>
        </div>
      ) : (
        <form
          className={styles.addForm}
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <fieldset disabled={controlsLocked}>
            <label className={styles.visuallyHidden} htmlFor={urlInputId}>YouTube 영상 링크</label>
            <div className={styles.addRow}>
              <div>
                <Link2 size={16} aria-hidden="true" />
                <input
                  id={urlInputId}
                  type="url"
                  inputMode="url"
                  value={draft.url}
                  placeholder="YouTube 링크 붙여넣기"
                  maxLength={2_048}
                  aria-describedby={`${helpId}${error && errorField === "url" ? ` ${errorId}` : ""}`}
                  aria-invalid={errorField === "url" || undefined}
                  onChange={(event) => {
                    setDraft((current) => ({ ...current, url: event.target.value }));
                    if (errorField === "url") {
                      setErrorField(null);
                      setError(null);
                    }
                  }}
                  onBlur={() => {
                    const parsed = parseYouTubeUrl(draft.url);
                    if (parsed && parsed.startSeconds > 0 && draft.sourceStartSeconds === "0") {
                      setDraft((current) => ({
                        ...current,
                        sourceStartSeconds: String(parsed.startSeconds),
                      }));
                    }
                  }}
                />
              </div>
              <button type="submit" className={styles.addButton}>
                {busy === "save" ? (
                  <LoaderCircle className={styles.spin} size={16} aria-hidden="true" />
                ) : (
                  <Plus size={16} aria-hidden="true" />
                )}
                트랙 추가
              </button>
            </div>
          </fieldset>
          <p className={styles.help} id={helpId}>
            링크는 저장만 하며 다운로드하지 않습니다. 시간 표시가 있는 링크는 시작점에 반영해요.
          </p>
        </form>
      )}

      {error ? <p className={styles.error} id={errorId} role="alert">{error}</p> : null}
      {message ? <p className={styles.message} role="status">{message}</p> : null}
    </section>
  );
}
