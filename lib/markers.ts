export const MARKER_COLORS = [
  "rose",
  "amber",
  "lime",
  "sky",
  "violet",
  "slate",
] as const;

export type MarkerColor = (typeof MARKER_COLORS)[number];

export const MAX_MARKERS_PER_RIFF = 64;
export const MAX_MARKER_LABEL_LENGTH = 32;
export const MAX_MARKER_POSITION_MS = 86_400_000;

const MARKER_COLOR_SET = new Set<string>(MARKER_COLORS);

export function isMarkerColor(value: unknown): value is MarkerColor {
  return typeof value === "string" && MARKER_COLOR_SET.has(value);
}

export function cleanMarkerLabel(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

export function sortMarkers<
  T extends { id: string; positionMs: number; sortOrder: number },
>(markers: readonly T[]): T[] {
  return [...markers].sort(
    (left, right) =>
      left.positionMs - right.positionMs ||
      left.sortOrder - right.sortOrder ||
      left.id.localeCompare(right.id),
  );
}

export function markerPositionPercent(
  positionMs: number,
  timelineDurationMs: number,
): number {
  if (!Number.isFinite(positionMs) || positionMs <= 0) return 0;
  if (!Number.isFinite(timelineDurationMs) || timelineDurationMs <= 0) return 0;
  return Math.min(100, (positionMs / timelineDurationMs) * 100);
}

export type MarkerPatchReconciliation = "ready" | "applied" | "conflict";

export function reconcileMarkerPatch<T extends object>(
  currentRevision: number,
  current: T,
  baseRevision: number | null,
  patch: Partial<T>,
): MarkerPatchReconciliation {
  if (baseRevision === currentRevision) return "ready";
  const currentRecord = current as Record<string, unknown>;
  const alreadyApplied = Object.entries(patch).every(
    ([key, value]) => currentRecord[key] === value,
  );
  return alreadyApplied ? "applied" : "conflict";
}
