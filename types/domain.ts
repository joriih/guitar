import type { MarkerColor } from "@/lib/markers";

export type Album = {
  id: string;
  name: string;
  description: string;
  color: string;
  coverAsset: string | null;
  riffCount: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type Tag = {
  id: string;
  name: string;
};

export type TagSummary = Tag & {
  usageCount: number;
};

export type Riff = {
  id: string;
  albumId: string | null;
  title: string;
  bpm: number;
  musicalKey: string;
  tuning: string;
  timeSignature: string;
  notes: string;
  tab: string;
  tags: Tag[];
  takeCount: number;
  primaryTakeId: string | null;
  isFavorite: boolean;
  deletedAt: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type Take = {
  id: string;
  riffId: string;
  takeNo: number;
  name: string;
  durationMs: number | null;
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

export type RiffTrack = {
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
  mimeType: string;
  byteSize: number;
  revision: number;
  clientRequestId: string | null;
  audioUrl: string;
  createdAt: string;
  updatedAt: string;
};

export type YouTubeBackingSource = {
  id: string;
  riffId: string;
  videoId: string;
  url: string;
  name: string;
  sourceStartMs: number;
  volume: number;
  syncEnabled: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type CompSegment = {
  id: string;
  riffId: string;
  takeId: string;
  startMs: number;
  endMs: number;
  sortOrder: number;
};

export type RiffMarker = {
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
