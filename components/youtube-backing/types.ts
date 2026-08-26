export type YouTubeBackingPlayerStatus =
  | "idle"
  | "loading"
  | "ready"
  | "playing"
  | "paused"
  | "buffering"
  | "cued"
  | "ended"
  | "stopped"
  | "error";

export type YouTubeBackingPlayerError = Readonly<{
  kind: "invalid-url" | "api-load" | "player";
  message: string;
  code?: number;
}>;

/**
 * Imperative controls exposed to a parent through `ref` and
 * `onControllerChange`. Commands return false until the iframe is ready.
 */
export type YouTubeBackingPlayerHandle = Readonly<{
  play: () => boolean;
  pause: () => boolean;
  stop: () => boolean;
  seekTo: (seconds: number) => boolean;
  setVolume: (volume: number) => boolean;
  /** Seeks, applies volume, starts playback, and resolves only after PLAYING. */
  playFrom: (seconds: number, volume: number) => Promise<void>;
  /** Pauses playback and returns the playhead to the requested position. */
  pauseAndReset: (seconds: number) => boolean;
  isReady: () => boolean;
  /** True when at least half of a 200×200px-or-larger player is in view. */
  isMostlyVisible: () => boolean;
  getCurrentTime: () => number;
  getDuration: () => number;
}>;

export type YouTubeBackingPlayerProps = Readonly<{
  /** A youtube.com/watch, youtu.be, shorts, live, or embed URL. */
  url: string;
  title?: string;
  className?: string;
  /** Locks the visible controls and direct iframe input without hiding video. */
  disabled?: boolean;
  autoPlay?: boolean;
  initialVolume?: number;
  /** Overrides a timestamp included in the pasted URL. */
  startSeconds?: number;
  onControllerChange?: (
    controller: YouTubeBackingPlayerHandle | null,
  ) => void;
  onStatusChange?: (status: YouTubeBackingPlayerStatus) => void;
  onError?: (error: YouTubeBackingPlayerError) => void;
  onTimeUpdate?: (currentTime: number, duration: number) => void;
  onAutoplayBlocked?: () => void;
  /** Reports a forced pause such as the document becoming hidden. */
  onPlaybackInterrupted?: (message: string) => void;
}>;
