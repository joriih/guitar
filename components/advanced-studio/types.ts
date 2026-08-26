import type { MarkerColor } from "@/lib/markers";

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
  /** Starts the currently selected take/Comp plus all tracks for overdubbing. */
  start: () => Promise<void>;
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
  /** Starts a normal take from the visible YouTube reference panel. */
  onYouTubeRecordingRequest?: () => Promise<void>;
  /** Stops capture if a synchronized external backing is interrupted. */
  onYouTubePlaybackInterrupted?: (message: string) => void;
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
