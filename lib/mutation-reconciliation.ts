type UnknownRecord = Record<string, unknown>;

export type RevisionedEntity = Readonly<{ id: string; revision: number }>;

export type TakeMutationSnapshot = RevisionedEntity &
  Readonly<{
    name: string;
    durationMs: number;
    trimStartMs: number;
    trimEndMs: number | null;
    offsetMs: number;
    isPrimary: boolean;
  }>;

export type TrackMutationSnapshot = RevisionedEntity &
  Readonly<{
    name: string;
    offsetMs: number;
    volume: number;
    pan: number;
    muted: boolean;
    solo: boolean;
    fadeInMs: number;
    fadeOutMs: number;
  }>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function nonnegativeRevision(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : null;
}

export function conflictCurrent(payload: unknown): UnknownRecord | null {
  if (!isRecord(payload)) return null;
  const current = payload.current;
  return isRecord(current) && nonnegativeRevision(current.revision) !== null
    ? current
    : null;
}

function sameValue(actual: unknown, expected: unknown): boolean {
  if (typeof actual === "number" && typeof expected === "number") {
    return Number.isFinite(actual) && Number.isFinite(expected) && actual === expected;
  }
  return actual === expected;
}

export function mutationAlreadyApplied<T extends object>(
  entity: T | null | undefined,
  patch: Partial<T>,
): entity is T {
  if (!entity) return false;
  return Object.entries(patch).every(([key, expected]) =>
    sameValue((entity as UnknownRecord)[key], expected),
  );
}

export function deletionAlreadyApplied<T extends Readonly<{ id: string }>>(
  entityId: string,
  entities: readonly T[],
): boolean {
  return !entities.some((entity) => entity.id === entityId);
}

export function reconciledTakeDuplicate(
  source: TakeMutationSnapshot,
  idsBeforeRequest: ReadonlySet<string>,
  takes: readonly TakeMutationSnapshot[],
): TakeMutationSnapshot | null {
  return (
    takes.find(
      (take) =>
        !idsBeforeRequest.has(take.id) &&
        take.id !== source.id &&
        take.name.startsWith(source.name) &&
        take.durationMs === source.durationMs &&
        take.trimStartMs === source.trimStartMs &&
        take.trimEndMs === source.trimEndMs &&
        take.offsetMs === source.offsetMs &&
        !take.isPrimary,
    ) ?? null
  );
}

export function reconciledTakeSplit(
  source: TakeMutationSnapshot,
  splitMs: number,
  idsBeforeRequest: ReadonlySet<string>,
  takes: readonly TakeMutationSnapshot[],
): TakeMutationSnapshot | null {
  const updatedSource = takes.find((take) => take.id === source.id);
  if (!updatedSource || updatedSource.trimEndMs !== splitMs) return null;

  const expectedOffset = source.offsetMs + (splitMs - source.trimStartMs);
  const expectedEnd = source.trimEndMs ?? source.durationMs;
  return (
    takes.find(
      (take) =>
        !idsBeforeRequest.has(take.id) &&
        take.id !== source.id &&
        take.durationMs === source.durationMs &&
        take.trimStartMs === splitMs &&
        take.trimEndMs === expectedEnd &&
        take.offsetMs === expectedOffset &&
        !take.isPrimary,
    ) ?? null
  );
}
