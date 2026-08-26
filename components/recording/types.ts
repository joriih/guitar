export type RiffMetadata = {
  bpm?: number | null;
  musicalKey?: string | null;
  tuning?: string | null;
  timeSignature?: string | null;
  revision?: number;
};

export type RecordingTake = {
  id: string;
  riffId: string;
  takeNo: number;
  name: string;
  durationMs: number;
  trimStartMs: number;
  trimEndMs: number | null;
  offsetMs: number;
  mimeType: string;
  byteSize: number;
  isPrimary: boolean;
  revision: number;
  createdAt: string;
  audioUrl: string;
};

export type RecordingStudioProps = {
  riffId: string;
  title: string;
  metadata?: RiffMetadata;
  initialNotes?: string;
  initialTab?: string;
  className?: string;
};

export type MicrophoneState =
  | "idle"
  | "requesting"
  | "ready"
  | "denied"
  | "unavailable"
  | "error";

export type CaptureState =
  | "idle"
  | "preparing"
  | "counting"
  | "recording"
  | "processing"
  | "uploading";
