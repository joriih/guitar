"use client";

import {
  ExternalLink,
  Pause,
  Play,
  Square,
  Volume2,
} from "lucide-react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";

import styles from "./YouTubeBackingPlayer.module.css";
import type {
  YouTubeBackingPlayerError,
  YouTubeBackingPlayerHandle,
  YouTubeBackingPlayerProps,
  YouTubeBackingPlayerStatus,
} from "./types";
import {
  loadYouTubeIframeApi,
  type YouTubeIframeApi,
  type YouTubeIframePlayer,
} from "./youtube-iframe-api";
import { parseYouTubeUrl } from "./youtube-url";
import { isRectMostlyVisible } from "./visibility";

const PLAY_CONFIRM_TIMEOUT_MS = 5_000;
const AUTOPLAY_BLOCK_CHECK_MS = 1_200;
const PLAYING_POLL_MS = 50;

type PendingPlayAttempt = {
  player: YouTubeIframePlayer;
  resolve: () => void;
  reject: (error: Error) => void;
  pollTimer?: number;
  blockTimer?: number;
  timeoutTimer?: number;
};

const STATUS_LABELS: Record<YouTubeBackingPlayerStatus, string> = {
  idle: "링크 대기",
  loading: "플레이어 불러오는 중",
  ready: "재생 준비됨",
  playing: "재생 중",
  paused: "일시 정지",
  buffering: "버퍼링 중",
  cued: "재생 준비됨",
  ended: "재생 완료",
  stopped: "정지됨",
  error: "재생할 수 없음",
};

function clampVolume(value: number): number {
  return Math.round(Math.min(100, Math.max(0, Number.isFinite(value) ? value : 80)));
}

function clampTime(value: number): number {
  return Math.max(0, Number.isFinite(value) ? value : 0);
}

function formatTime(seconds: number): string {
  const wholeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(wholeSeconds / 60);
  const remainingSeconds = wholeSeconds % 60;
  return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

function configureIframe(
  iframe: HTMLIFrameElement,
  title: string,
  disabled: boolean,
) {
  iframe.title = title;
  iframe.allow =
    "accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture";
  iframe.allowFullscreen = true;
  iframe.tabIndex = disabled ? -1 : 0;
  iframe.style.pointerEvents = disabled ? "none" : "";
  if (disabled) {
    iframe.setAttribute("aria-disabled", "true");
    iframe.blur();
  } else {
    iframe.removeAttribute("aria-disabled");
  }
}

function stateFromPlayer(
  api: YouTubeIframeApi,
  state: number,
): YouTubeBackingPlayerStatus {
  if (state === api.PlayerState.PLAYING) return "playing";
  if (state === api.PlayerState.PAUSED) return "paused";
  if (state === api.PlayerState.BUFFERING) return "buffering";
  if (state === api.PlayerState.CUED) return "cued";
  if (state === api.PlayerState.ENDED) return "ended";
  return "ready";
}

function playerError(code: number): YouTubeBackingPlayerError {
  if (code === 2) {
    return {
      kind: "player",
      code,
      message: "영상 주소나 재생 위치가 올바르지 않아요. 링크를 다시 확인해 주세요.",
    };
  }
  if (code === 153) {
    return {
      kind: "player",
      code,
      message: "YouTube가 이 앱의 출처를 확인하지 못했어요. 앱을 다시 연 뒤 시도해 주세요.",
    };
  }
  if (code === 100) {
    return {
      kind: "player",
      code,
      message: "삭제되었거나 비공개인 영상이에요. 다른 링크를 사용해 주세요.",
    };
  }
  if (code === 101 || code === 150) {
    return {
      kind: "player",
      code,
      message: "이 영상은 외부 플레이어 재생이 제한되어 있어요.",
    };
  }
  if (code === 5) {
    return {
      kind: "player",
      code,
      message: "브라우저에서 이 영상을 재생하지 못했어요.",
    };
  }
  return {
    kind: "player",
    code,
    message: "YouTube 영상을 재생할 수 없어요. 링크를 확인해 주세요.",
  };
}

export const YouTubeBackingPlayer = forwardRef<
  YouTubeBackingPlayerHandle,
  YouTubeBackingPlayerProps
>(function YouTubeBackingPlayer(
  {
    url,
    title = "YouTube 참고 트랙",
    className,
    disabled = false,
    customControlsDisabled = false,
    autoPlay = false,
    initialVolume = 80,
    startSeconds,
    syncEnabled = false,
    onControllerChange,
    onStatusChange,
    onError,
    onTimeUpdate,
    onAutoplayBlocked,
    onPlaybackInterrupted,
  },
  forwardedRef,
) {
  const parsedUrl = useMemo(() => parseYouTubeUrl(url), [url]);
  const rootRef = useRef<HTMLElement>(null);
  const playerMountRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YouTubeIframePlayer | null>(null);
  const apiRef = useRef<YouTubeIframeApi | null>(null);
  const readyRef = useRef(false);
  const generationRef = useRef(0);
  const autoplayTimerRef = useRef<number | null>(null);
  const pendingPlayRef = useRef<PendingPlayAttempt | null>(null);
  const volumeRef = useRef(clampVolume(initialVolume));
  const callbacksRef = useRef({
    onControllerChange,
    onStatusChange,
    onError,
    onTimeUpdate,
    onAutoplayBlocked,
    onPlaybackInterrupted,
  });
  const autoPlayRef = useRef(autoPlay);
  const disabledRef = useRef(disabled);

  callbacksRef.current = {
    onControllerChange,
    onStatusChange,
    onError,
    onTimeUpdate,
    onAutoplayBlocked,
    onPlaybackInterrupted,
  };
  autoPlayRef.current = autoPlay;
  disabledRef.current = disabled;

  const [status, setStatus] = useState<YouTubeBackingPlayerStatus>(
    parsedUrl ? "loading" : "idle",
  );
  const [error, setError] = useState<YouTubeBackingPlayerError | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolumeState] = useState(volumeRef.current);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);

  const emitStatus = useCallback((nextStatus: YouTubeBackingPlayerStatus) => {
    setStatus(nextStatus);
    callbacksRef.current.onStatusChange?.(nextStatus);
  }, []);

  const reportError = useCallback(
    (nextError: YouTubeBackingPlayerError) => {
      setError(nextError);
      emitStatus("error");
      callbacksRef.current.onError?.(nextError);
    },
    [emitStatus],
  );

  const settlePendingPlay = useCallback((nextError?: Error) => {
    const pending = pendingPlayRef.current;
    if (!pending) return;
    pendingPlayRef.current = null;
    if (pending.pollTimer !== undefined) window.clearInterval(pending.pollTimer);
    if (pending.blockTimer !== undefined) window.clearTimeout(pending.blockTimer);
    if (pending.timeoutTimer !== undefined) window.clearTimeout(pending.timeoutTimer);
    if (nextError) pending.reject(nextError);
    else pending.resolve();
  }, []);

  const notifyAutoplayBlocked = useCallback(() => {
    setAutoplayBlocked(true);
    callbacksRef.current.onAutoplayBlocked?.();
  }, []);

  const readPlayerNumber = useCallback(
    (read: (player: YouTubeIframePlayer) => number): number => {
      const player = playerRef.current;
      if (!player || !readyRef.current) return 0;
      try {
        const value = read(player);
        return Number.isFinite(value) ? value : 0;
      } catch {
        return 0;
      }
    },
    [],
  );

  const runCommand = useCallback(
    (command: (player: YouTubeIframePlayer) => void): boolean => {
      const player = playerRef.current;
      if (!player || !readyRef.current) return false;
      try {
        command(player);
        return true;
      } catch {
        return false;
      }
    },
    [],
  );

  const isPlayerMostlyVisible = useCallback(() => {
    const player = playerRef.current;
    if (
      !player ||
      !readyRef.current ||
      typeof window === "undefined" ||
      document.visibilityState !== "visible"
    ) {
      return false;
    }
    try {
      return isRectMostlyVisible(player.getIframe().getBoundingClientRect(), {
        width: window.innerWidth,
        height: window.innerHeight,
      });
    } catch {
      return false;
    }
  }, []);

  const controller = useMemo<YouTubeBackingPlayerHandle>(
    () => ({
      play: () => {
        if (!isPlayerMostlyVisible()) {
          callbacksRef.current.onError?.({
            kind: "player",
            message: "YouTube 영상이 절반 이상 보이는 위치에서 재생해 주세요.",
          });
          return false;
        }
        setAutoplayBlocked(false);
        return runCommand((player) => player.playVideo());
      },
      pause: () => {
        settlePendingPlay(new Error("재생 시작 전에 일시 정지되었어요."));
        return runCommand((player) => player.pauseVideo());
      },
      stop: () => {
        settlePendingPlay(new Error("재생 시작 전에 정지되었어요."));
        const stopped = runCommand((player) => player.stopVideo());
        if (stopped) {
          setCurrentTime(0);
          emitStatus("stopped");
        }
        return stopped;
      },
      seekTo: (seconds) => {
        const nextTime = clampTime(seconds);
        const sought = runCommand((player) => player.seekTo(nextTime, true));
        if (sought) setCurrentTime(nextTime);
        return sought;
      },
      setVolume: (nextVolume) => {
        const safeVolume = clampVolume(nextVolume);
        const changed = runCommand((player) => player.setVolume(safeVolume));
        if (changed) {
          volumeRef.current = safeVolume;
          setVolumeState(safeVolume);
        }
        return changed;
      },
      playFrom: (seconds, nextVolume) =>
        new Promise<void>((resolve, reject) => {
          const player = playerRef.current;
          const api = apiRef.current;
          if (!player || !api || !readyRef.current) {
            reject(new Error("YouTube 플레이어가 아직 준비되지 않았어요."));
            return;
          }
          if (!isPlayerMostlyVisible()) {
            reject(
              new Error(
                "YouTube 영상이 절반 이상 보이는 위치에서 재생해 주세요.",
              ),
            );
            return;
          }

          settlePendingPlay(new Error("새 재생 요청으로 이전 요청이 취소되었어요."));
          const safeTime = clampTime(seconds);
          const safeVolume = clampVolume(nextVolume);
          const pending: PendingPlayAttempt = { player, resolve, reject };
          pendingPlayRef.current = pending;
          setAutoplayBlocked(false);

          const confirmPlaying = () => {
            if (pendingPlayRef.current !== pending) return;
            try {
              if (player.getPlayerState() === api.PlayerState.PLAYING) {
                settlePendingPlay();
              }
            } catch {
              settlePendingPlay(new Error("YouTube 재생 상태를 확인하지 못했어요."));
            }
          };

          try {
            player.seekTo(safeTime, true);
            player.setVolume(safeVolume);
            volumeRef.current = safeVolume;
            setVolumeState(safeVolume);
            setCurrentTime(safeTime);
            player.playVideo();
          } catch {
            settlePendingPlay(new Error("YouTube 재생을 시작하지 못했어요."));
            return;
          }

          if (pendingPlayRef.current !== pending) return;
          pending.pollTimer = window.setInterval(confirmPlaying, PLAYING_POLL_MS);
          pending.blockTimer = window.setTimeout(() => {
            if (pendingPlayRef.current !== pending) return;
            let state: number;
            try {
              state = player.getPlayerState();
            } catch {
              settlePendingPlay(new Error("YouTube 재생 상태를 확인하지 못했어요."));
              return;
            }
            if (
              state !== api.PlayerState.PLAYING &&
              state !== api.PlayerState.BUFFERING
            ) {
              notifyAutoplayBlocked();
              settlePendingPlay(
                new Error("브라우저가 YouTube 자동 재생을 차단했어요."),
              );
            }
          }, AUTOPLAY_BLOCK_CHECK_MS);
          pending.timeoutTimer = window.setTimeout(() => {
            if (pendingPlayRef.current !== pending) return;
            settlePendingPlay(
              new Error("5초 안에 YouTube 재생이 시작되지 않았어요."),
            );
          }, PLAY_CONFIRM_TIMEOUT_MS);
          confirmPlaying();
        }),
      pauseAndReset: (seconds) => {
        settlePendingPlay(new Error("재생 시작 전에 일시 정지되었어요."));
        const nextTime = clampTime(seconds);
        const reset = runCommand((player) => {
          player.pauseVideo();
          player.seekTo(nextTime, true);
        });
        if (reset) {
          setCurrentTime(nextTime);
          emitStatus("paused");
        }
        return reset;
      },
      isReady: () => readyRef.current && playerRef.current !== null,
      isMostlyVisible: isPlayerMostlyVisible,
      getCurrentTime: () => readPlayerNumber((player) => player.getCurrentTime()),
      getDuration: () => readPlayerNumber((player) => player.getDuration()),
    }),
    [
      emitStatus,
      isPlayerMostlyVisible,
      notifyAutoplayBlocked,
      readPlayerNumber,
      runCommand,
      settlePendingPlay,
    ],
  );

  useImperativeHandle(forwardedRef, () => controller, [controller]);

  useEffect(() => {
    const generation = ++generationRef.current;
    const mount = playerMountRef.current;
    readyRef.current = false;
    playerRef.current = null;
    apiRef.current = null;
    setError(null);
    setCurrentTime(0);
    setDuration(0);
    setAutoplayBlocked(false);
    callbacksRef.current.onControllerChange?.(null);

    if (!url.trim()) {
      emitStatus("idle");
      mount?.replaceChildren();
      return;
    }

    if (!parsedUrl) {
      reportError({
        kind: "invalid-url",
        message: "올바른 YouTube 링크를 붙여 넣어 주세요.",
      });
      mount?.replaceChildren();
      return;
    }

    if (!mount) return;
    emitStatus("loading");
    const playerTarget = document.createElement("div");
    mount.replaceChildren(playerTarget);
    let disposed = false;

    void loadYouTubeIframeApi()
      .then((api) => {
        if (disposed || generationRef.current !== generation) return;
        apiRef.current = api;
        const requestedStart = clampTime(startSeconds ?? parsedUrl.startSeconds);
        const player = new api.Player(playerTarget, {
          width: "100%",
          height: "100%",
          host: "https://www.youtube-nocookie.com",
          videoId: parsedUrl.videoId,
          playerVars: {
            autoplay: 0,
            controls: 1,
            enablejsapi: 1,
            origin: window.location.origin,
            playsinline: 1,
            rel: 0,
            ...(requestedStart > 0 ? { start: Math.floor(requestedStart) } : {}),
          },
          events: {
            onReady: (event) => {
              if (disposed || generationRef.current !== generation) return;
              playerRef.current = event.target;
              readyRef.current = true;
              try {
                configureIframe(
                  event.target.getIframe(),
                  title,
                  disabledRef.current,
                );
                event.target.setVolume(volumeRef.current);
              } catch {
                // The controller remains usable even when iframe metadata is unavailable.
              }
              const nextDuration = clampTime(event.target.getDuration());
              setDuration(nextDuration);
              emitStatus("ready");
              callbacksRef.current.onControllerChange?.(controller);

              if (autoPlayRef.current) {
                if (!isPlayerMostlyVisible()) {
                  callbacksRef.current.onError?.({
                    kind: "player",
                    message: "YouTube 영상이 절반 이상 보이는 위치에서 재생해 주세요.",
                  });
                  return;
                }
                event.target.playVideo();
                autoplayTimerRef.current = window.setTimeout(() => {
                  if (disposed || playerRef.current !== event.target) return;
                  let playerState: number = api.PlayerState.UNSTARTED;
                  try {
                    playerState = event.target.getPlayerState();
                  } catch {
                    return;
                  }
                  if (
                    playerState !== api.PlayerState.PLAYING &&
                    playerState !== api.PlayerState.BUFFERING
                  ) {
                    notifyAutoplayBlocked();
                  }
                }, AUTOPLAY_BLOCK_CHECK_MS);
              }
            },
            onStateChange: (event) => {
              if (disposed || generationRef.current !== generation) return;
              const nextStatus = stateFromPlayer(api, event.data);
              if (nextStatus === "playing") {
                setAutoplayBlocked(false);
                if (pendingPlayRef.current?.player === event.target) {
                  settlePendingPlay();
                }
              }
              emitStatus(nextStatus);
              try {
                const nextCurrentTime = clampTime(event.target.getCurrentTime());
                const nextDuration = clampTime(event.target.getDuration());
                setCurrentTime(nextCurrentTime);
                setDuration(nextDuration);
                callbacksRef.current.onTimeUpdate?.(
                  nextCurrentTime,
                  nextDuration,
                );
              } catch {
                // The polling pass will retry after transient iframe transitions.
              }
            },
            onError: (event) => {
              if (disposed || generationRef.current !== generation) return;
              readyRef.current = false;
              callbacksRef.current.onControllerChange?.(null);
              const nextError = playerError(event.data);
              settlePendingPlay(new Error(nextError.message));
              try {
                event.target.destroy();
              } catch {
                // YouTube may already have removed the failed iframe.
              }
              playerRef.current = null;
              mount.replaceChildren();
              reportError(nextError);
            },
          },
        });
        playerRef.current = player;
      })
      .catch(() => {
        if (disposed || generationRef.current !== generation) return;
        settlePendingPlay(new Error("YouTube 플레이어를 불러오지 못했어요."));
        reportError({
          kind: "api-load",
          message: "YouTube 플레이어를 불러오지 못했어요. 연결을 확인해 주세요.",
        });
      });

    return () => {
      disposed = true;
      readyRef.current = false;
      settlePendingPlay(new Error("YouTube 플레이어가 닫혀 재생 요청이 취소되었어요."));
      if (autoplayTimerRef.current !== null) {
        window.clearTimeout(autoplayTimerRef.current);
        autoplayTimerRef.current = null;
      }
      callbacksRef.current.onControllerChange?.(null);
      try {
        playerRef.current?.destroy();
      } catch {
        // The iframe may already have been removed during navigation.
      }
      playerRef.current = null;
      apiRef.current = null;
      mount.replaceChildren();
    };
  }, [
    controller,
    emitStatus,
    isPlayerMostlyVisible,
    notifyAutoplayBlocked,
    parsedUrl,
    reportError,
    settlePendingPlay,
    startSeconds,
    title,
    url,
  ]);

  useEffect(() => {
    const player = playerRef.current;
    if (!player || !readyRef.current) return;
    try {
      configureIframe(player.getIframe(), title, disabled);
    } catch {
      // The iframe may be between YouTube-managed document transitions.
    }
  }, [disabled, status, title]);

  useEffect(() => {
    const pauseWhenHidden = () => {
      if (!document.hidden) return;
      callbacksRef.current.onPlaybackInterrupted?.(
        "탭이 가려져 YouTube 백킹 재생을 중단했어요.",
      );
      settlePendingPlay(new Error("탭이 가려져 YouTube 재생이 중단되었어요."));
      if (runCommand((player) => player.pauseVideo())) emitStatus("paused");
    };

    document.addEventListener("visibilitychange", pauseWhenHidden);
    return () => document.removeEventListener("visibilitychange", pauseWhenHidden);
  }, [emitStatus, runCommand, settlePendingPlay]);

  useEffect(() => {
    if (status !== "playing" && status !== "buffering") return;

    const pauseWhenObscured = () => {
      if (isPlayerMostlyVisible()) return;
      callbacksRef.current.onPlaybackInterrupted?.(
        "YouTube 영상이 화면에서 벗어나 백킹 재생을 중단했어요.",
      );
      settlePendingPlay(
        new Error("YouTube 영상이 화면에서 벗어나 재생이 중단되었어요."),
      );
      if (runCommand((player) => player.pauseVideo())) emitStatus("paused");
    };

    window.addEventListener("scroll", pauseWhenObscured, { passive: true });
    window.addEventListener("resize", pauseWhenObscured);
    const timer = window.setInterval(pauseWhenObscured, 500);
    return () => {
      window.removeEventListener("scroll", pauseWhenObscured);
      window.removeEventListener("resize", pauseWhenObscured);
      window.clearInterval(timer);
    };
  }, [emitStatus, isPlayerMostlyVisible, runCommand, settlePendingPlay, status]);

  useEffect(() => {
    if (!readyRef.current || status === "error" || status === "idle") return;

    const syncTime = () => {
      const player = playerRef.current;
      if (!player || !readyRef.current) return;
      try {
        const nextCurrentTime = clampTime(player.getCurrentTime());
        const nextDuration = clampTime(player.getDuration());
        setCurrentTime(nextCurrentTime);
        setDuration(nextDuration);
        callbacksRef.current.onTimeUpdate?.(nextCurrentTime, nextDuration);
      } catch {
        // Ignore a single transient read while YouTube changes playback state.
      }
    };

    syncTime();
    const timer = window.setInterval(syncTime, status === "playing" ? 250 : 1_000);
    return () => window.clearInterval(timer);
  }, [status]);

  const hasReadyPlayer = readyRef.current && status !== "error";
  const controlsDisabled = disabled || customControlsDisabled || !hasReadyPlayer;
  const progressMaximum = Math.max(duration, 1);
  const visibleCurrentTime = Math.min(currentTime, progressMaximum);
  const rootClassName = className ? `${styles.player} ${className}` : styles.player;
  const playbackActive = status === "playing" || status === "buffering";
  const configuredStart = clampTime(startSeconds ?? parsedUrl?.startSeconds ?? 0);

  return (
    <section
      ref={rootRef}
      className={rootClassName}
      aria-label={title}
      data-disabled={disabled || customControlsDisabled || undefined}
      data-youtube-backing-player
      data-youtube-track-strip
    >
      <header className={styles.trackHeader}>
        <div className={styles.identity}>
          <span className={styles.sourceMark} aria-hidden="true">YT</span>
          <div>
            <h3>{title}</h3>
            <span className={styles.status} data-status={status} aria-live="polite">
              <i aria-hidden="true" />
              {STATUS_LABELS[status]}
            </span>
          </div>
        </div>

        <div className={styles.transport} role="group" aria-label="YouTube 재생 제어">
          <button
            type="button"
            className={styles.playButton}
            onClick={() => playbackActive ? controller.pause() : controller.play()}
            disabled={controlsDisabled}
            aria-label={playbackActive ? "YouTube 참고 트랙 일시 정지" : "YouTube 참고 트랙 재생"}
            aria-pressed={playbackActive}
          >
            {playbackActive ? (
              <Pause size={15} fill="currentColor" aria-hidden="true" />
            ) : (
              <Play size={15} fill="currentColor" aria-hidden="true" />
            )}
            <span>{playbackActive ? "일시 정지" : "재생"}</span>
          </button>
          <button
            type="button"
            className={styles.stopButton}
            onClick={() => controller.stop()}
            disabled={controlsDisabled}
            aria-label="YouTube 참고 트랙 정지"
            title="정지"
          >
            <Square size={13} fill="currentColor" aria-hidden="true" />
          </button>
        </div>

        <label className={styles.volume}>
          <Volume2 size={15} aria-hidden="true" />
          <span className={styles.visuallyHidden}>YouTube 볼륨</span>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={volume}
            onChange={(event) => controller.setVolume(Number(event.target.value))}
            disabled={controlsDisabled}
            aria-valuetext={`${volume}%`}
          />
          <output aria-label={`현재 볼륨 ${volume}%`}>{volume}</output>
        </label>

        <dl className={styles.trackMeta}>
          <div>
            <dt>동기화</dt>
            <dd data-enabled={syncEnabled || undefined}>{syncEnabled ? "켜짐" : "꺼짐"}</dd>
          </div>
          <div>
            <dt>시작점</dt>
            <dd>{formatTime(configuredStart)}</dd>
          </div>
        </dl>
      </header>

      <div className={styles.videoFrame}>
        <div ref={playerMountRef} className={styles.playerMount} />
        {!parsedUrl || error ? (
          <div className={styles.placeholder}>
            <p>{error?.message ?? "YouTube 링크를 추가하면 영상이 여기에 표시돼요."}</p>
          </div>
        ) : null}
      </div>
      {status === "loading" ? (
        <div className={styles.loading} role="status">
          <span aria-hidden="true" />
          플레이어 준비 중
        </div>
      ) : null}

      <div
        className={styles.timeline}
        aria-disabled={disabled || customControlsDisabled || undefined}
      >
        <label htmlFor={`youtube-progress-${parsedUrl?.videoId ?? "empty"}`}>
          재생 위치
        </label>
        <input
          id={`youtube-progress-${parsedUrl?.videoId ?? "empty"}`}
          type="range"
          min={0}
          max={progressMaximum}
          step={0.1}
          value={visibleCurrentTime}
          onChange={(event) => controller.seekTo(Number(event.target.value))}
          disabled={controlsDisabled || duration <= 0}
          aria-valuetext={`${formatTime(visibleCurrentTime)} / ${formatTime(duration)}`}
        />
        <output className={styles.time} aria-live="off">
          {formatTime(visibleCurrentTime)} / {formatTime(duration)}
        </output>
      </div>

      {autoplayBlocked ? (
        <p className={styles.notice} role="status">
          브라우저가 자동 재생을 막았어요. 위의 재생 버튼을 눌러 시작해 주세요.
        </p>
      ) : null}

      <footer className={styles.footer}>
        <p>공식 YouTube 플레이어 · 녹음 파일과 믹스다운에는 포함되지 않아요.</p>
        {parsedUrl ? (
          <a
            href={parsedUrl.canonicalUrl}
            target="_blank"
            rel="noreferrer"
            aria-label="YouTube에서 원본 영상 열기 (새 창)"
          >
            YouTube에서 열기
            <ExternalLink size={13} aria-hidden="true" />
          </a>
        ) : null}
      </footer>
    </section>
  );
});
