import type { MarkerColor } from "@/lib/markers";
import type { YouTubeBackingTransport } from "@/components/youtube-backing";

export type AdvancedStudioTake = {
  id: string;
  name: string;
  durationMs: number | null;
  trimStartMs: number;
  trimEndMs: number | null;
  offsetMs: number;
  isPrimary: boolean;
  audioUrl: string;
};

export type PunchRequest = {
  startMs: number;
  endMs: number;
  preRollMs: number;
};

export type AdvancedStudioRecordingTransport = {
  /** Primes external playback permission synchronously from the record click. */
  prime: () => Promise<void>;
  /**
   * Starts the selected arrangement and returns the measured milliseconds that
   * playback was already running before microphone capture can begin.
   */
  start: () => Promise<number>;
  /** Stops and releases the scheduled mix nodes. */
  stop: () => void;
};

export type AdvancedStudioToolsProps = {
  riffId: string;
  takes: readonly AdvancedStudioTake[];
  bpm: number;
  timeSignature: string;
  sharedStream?: MediaStream | null;
  /** True from capture preparation through final processing/upload. */
  captureInProgress?: boolean;
  onPunchRequest?: (request: PunchRequest) => void | Promise<void>;
  /** External reference transport owned by the recording workspace dock. */
  youtubeTransport?: YouTubeBackingTransport | null;
  onRecordingTransportReady?: (
    transport: AdvancedStudioRecordingTransport | null,
  ) => void;
  className?: string;
};

export type StudioTrack = {
  id: string;
  riffId: string;
  kind: "guitar" | "backing";
  name: string;
  durationMs: number | null;
  offsetMs: number;
  volume: number;
  pan: number;
  muted: boolean;
  solo: boolean;
  fadeInMs: number;
  fadeOutMs: number;
  revision: number;
  clientRequestId: string | null;
  audioUrl: string;
};

export type CompDraftRow = {
  clientId: string;
  id?: string;
  takeId: string;
  startMs: number;
  endMs: number;
};

export type TrackPatch = Partial<
  Pick<
    StudioTrack,
    "name" | "offsetMs" | "volume" | "pan" | "muted" | "solo" | "fadeInMs" | "fadeOutMs"
  >
>;

export type StudioMarker = {
  id: string;
  riffId: string;
  positionMs: number;
  label: string;
  color: MarkerColor;
  sortOrder: number;
  revision: number;
  clientRequestId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MarkerPatch = Partial<
  Pick<StudioMarker, "positionMs" | "label" | "color">
>;
