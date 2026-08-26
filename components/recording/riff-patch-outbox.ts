export type RiffPatchStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
> &
  Partial<Pick<Storage, "key" | "length">>;

export type StoredRiffPatch = {
  baseRevision: number | null;
  patch: Record<string, unknown>;
};

export type RiffPatchSourceSnapshot = {
  key: string;
  raw: string;
  updatedAt: number | null;
};

export type RiffPatchReadResult = StoredRiffPatch & {
  sources: RiffPatchSourceSnapshot[];
};

type ParsedStoredRiffPatch = StoredRiffPatch & {
  updatedAt: number | null;
};

export type RiffPatchRecoveryState =
  | "empty"
  | "already-applied"
  | "ready"
  | "conflict";

export type RiffPatchOwner = {
  ownerId: string;
  previousOwnerId: string | null;
};

const LEGACY_OWNER_SESSION_KEY = "riff-sketchbook:riff-patch-owner";
const OWNER_SESSION_KEY_PREFIX = `${LEGACY_OWNER_SESSION_KEY}:riff:`;
const OWNER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function nonnegativeRevision(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function legacyRiffPatchStorageKey(riffId: string): string {
  return `riff-sketchbook:pending-riff:${riffId}`;
}

function riffPatchDiscardKey(riffId: string, sourceKey: string): string {
  return `${legacyRiffPatchStorageKey(riffId)}:discarded:${encodeURIComponent(sourceKey)}`;
}

export function riffPatchStorageKey(riffId: string, ownerId: string): string {
  return `${legacyRiffPatchStorageKey(riffId)}:owner:${ownerId}`;
}

export function createRiffPatchOwner(
  sessionStorage: RiffPatchStorage | null,
  riffId: string,
  createId: () => string,
): RiffPatchOwner {
  const ownerSessionKey = `${OWNER_SESSION_KEY_PREFIX}${encodeURIComponent(riffId)}`;
  let previousOwnerId: string | null = null;
  if (sessionStorage) {
    try {
      const scoped = sessionStorage.getItem(ownerSessionKey);
      // Adopt the former document-global pointer only when this riff has not
      // established its own chain yet. Keep the legacy pointer because another
      // riff may still need it to discover an outbox written before this change.
      const stored = scoped ?? sessionStorage.getItem(LEGACY_OWNER_SESSION_KEY);
      if (stored && OWNER_ID_PATTERN.test(stored)) previousOwnerId = stored;
      else if (scoped) sessionStorage.removeItem(ownerSessionKey);
    } catch {
      // The in-memory owner created below still separates this mounted editor.
    }
  }

  // Rotate on every mounted editor instead of reusing the session value.
  // Browsers may clone sessionStorage when a tab is duplicated; a fresh owner
  // keeps those two live editors from falling back onto the same outbox key.
  let ownerId = createId();
  if (ownerId === previousOwnerId) ownerId = createId();
  if (sessionStorage) {
    try {
      sessionStorage.setItem(ownerSessionKey, ownerId);
    } catch {
      // localStorage writes can still use the in-memory owner for this page.
    }
  }
  return { ownerId, previousOwnerId };
}

function parseStoredRiffPatch(raw: string | null): ParsedStoredRiffPatch | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value)) return null;

    if ("patch" in value || "baseRevision" in value) {
      if (!isRecord(value.patch)) return null;
      return {
        baseRevision: nonnegativeRevision(value.baseRevision),
        patch: value.patch,
        updatedAt:
          typeof value.updatedAt === "number" &&
          Number.isSafeInteger(value.updatedAt) &&
          value.updatedAt >= 0
            ? value.updatedAt
            : null,
      };
    }

    // The first outbox format stored the patch object directly.
    return { baseRevision: null, patch: value, updatedAt: null };
  } catch {
    return null;
  }
}

function mergeStoredRiffPatches(
  older: ParsedStoredRiffPatch,
  newer: ParsedStoredRiffPatch | null,
): ParsedStoredRiffPatch {
  if (!newer) return older;
  const hasDivergentOverlap = Object.entries(older.patch).some(
    ([key, value]) =>
      Object.prototype.hasOwnProperty.call(newer.patch, key) &&
      !sameValue(newer.patch[key], value),
  );
  return {
    // Different base revisions or competing values for the same field cannot
    // be safely auto-rebased. A null base routes the merged, lossless draft to
    // the existing explicit conflict choice. Newer values win deterministically
    // for presentation while all source snapshots remain available for retry.
    baseRevision:
      older.baseRevision === newer.baseRevision && !hasDivergentOverlap
        ? newer.baseRevision
        : null,
    patch: { ...older.patch, ...newer.patch },
    updatedAt: newer.updatedAt ?? older.updatedAt,
  };
}

export function persistRiffPatchOutbox(
  storage: RiffPatchStorage | null,
  riffId: string,
  ownerId: string,
  baseRevision: number | null,
  patch: Record<string, unknown>,
  updatedAt?: number,
): boolean {
  if (!storage) return false;
  try {
    const key = riffPatchStorageKey(riffId, ownerId);
    if (Object.keys(patch).length === 0) {
      storage.removeItem(key);
      storage.removeItem(riffPatchDiscardKey(riffId, key));
    } else {
      const existing = parseStoredRiffPatch(storage.getItem(key));
      const now = Date.now();
      const nextUpdatedAt =
        updatedAt ??
        Math.max(now, (existing?.updatedAt ?? -1) + 1);
      storage.setItem(
        key,
        JSON.stringify({ baseRevision, patch, updatedAt: nextUpdatedAt }),
      );
      // A live owner writing a newer draft makes any exact older discard stale.
      storage.removeItem(riffPatchDiscardKey(riffId, key));
    }
    return true;
  } catch {
    return false;
  }
}

function sourceSnapshot(
  key: string,
  raw: string | null,
  stored: ParsedStoredRiffPatch | null,
): RiffPatchSourceSnapshot | null {
  if (!raw || !stored || Object.keys(stored.patch).length === 0) return null;
  return { key, raw, updatedAt: stored.updatedAt };
}

function isDiscardedSource(
  storage: RiffPatchStorage,
  riffId: string,
  source: RiffPatchSourceSnapshot,
): boolean {
  try {
    const raw = storage.getItem(riffPatchDiscardKey(riffId, source.key));
    if (!raw) return false;
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value)) return false;
    if (source.updatedAt !== null) return value.updatedAt === source.updatedAt;
    return value.raw === source.raw;
  } catch {
    return false;
  }
}

export function discardRiffPatchSources(
  storage: RiffPatchStorage | null,
  riffId: string,
  sources: readonly RiffPatchSourceSnapshot[],
): number {
  if (!storage) return 0;
  let recorded = 0;
  for (const source of sources) {
    try {
      storage.setItem(
        riffPatchDiscardKey(riffId, source.key),
        JSON.stringify(
          source.updatedAt === null
            ? { raw: source.raw }
            : { updatedAt: source.updatedAt },
        ),
      );
      recorded += 1;
    } catch {
      // If the tombstone cannot be persisted, resurfacing is safer than loss.
    }
  }
  return recorded;
}

function ownerCandidateKeys(
  storage: RiffPatchStorage,
  riffId: string,
): string[] {
  const ownerPrefix = `${legacyRiffPatchStorageKey(riffId)}:owner:`;
  const keys: string[] = [];
  try {
    if (typeof storage.length !== "number" || typeof storage.key !== "function") {
      return keys;
    }
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(ownerPrefix)) keys.push(key);
    }
  } catch {
    return [];
  }
  return keys;
}

function publicStoredRiffPatch(value: ParsedStoredRiffPatch): StoredRiffPatch {
  return { baseRevision: value.baseRevision, patch: value.patch };
}

export function readRiffPatchOutboxWithSources(
  storage: RiffPatchStorage | null,
  riffId: string,
  ownerId: string,
  previousOwnerId: string | null = null,
): RiffPatchReadResult {
  const empty: RiffPatchReadResult = {
    baseRevision: null,
    patch: {},
    sources: [],
  };
  if (!storage) return empty;

  const ownedKey = riffPatchStorageKey(riffId, ownerId);
  const previousOwnedKey =
    previousOwnerId && previousOwnerId !== ownerId
      ? riffPatchStorageKey(riffId, previousOwnerId)
      : null;
  const legacyKey = legacyRiffPatchStorageKey(riffId);
  // A known current/previous/legacy source must not hide an outbox whose tab
  // has since closed. Always enumerate every owner key, then deduplicate by key
  // before parsing so all durable drafts participate in one safe merge.
  const candidateKeys = new Set<string>([ownedKey, legacyKey]);
  if (previousOwnedKey) candidateKeys.add(previousOwnedKey);
  for (const key of ownerCandidateKeys(storage, riffId)) candidateKeys.add(key);

  const candidates = Array.from(candidateKeys)
    .map((key) => {
      try {
        const raw = storage.getItem(key);
        const stored = parseStoredRiffPatch(raw);
        return { key, stored, source: sourceSnapshot(key, raw, stored) };
      } catch {
        return { key, stored: null, source: null };
      }
    })
    .filter(
      (
        candidate,
      ): candidate is {
        key: string;
        stored: ParsedStoredRiffPatch;
        source: RiffPatchSourceSnapshot;
      } =>
        candidate.stored !== null &&
        candidate.source !== null &&
        !isDiscardedSource(storage, riffId, candidate.source) &&
        Object.keys(candidate.stored.patch).length > 0,
    )
    .sort((first, second) => {
      const byUpdatedAt =
        (first.stored.updatedAt ?? 0) - (second.stored.updatedAt ?? 0);
      return byUpdatedAt || first.key.localeCompare(second.key);
    });

  if (candidates.length === 0) return empty;
  let durableCopy = candidates[0]!.stored;
  for (const candidate of candidates.slice(1)) {
    durableCopy = mergeStoredRiffPatches(durableCopy, candidate.stored);
  }
  const legacyCandidate = candidates.find(
    (candidate) => candidate.key === legacyKey,
  );
  // A previous owner can still belong to a live original tab when a browser
  // duplicates sessionStorage into a new tab. Copy its outbox, but never move
  // it: the server acknowledgement cleanup below is the only safe time to
  // remove owner-specific sources whose continuity cannot be proven.
  if (
    persistRiffPatchOutbox(
      storage,
      riffId,
      ownerId,
      durableCopy.baseRevision,
      durableCopy.patch,
      durableCopy.updatedAt ?? Date.now(),
    )
  ) {
    if (legacyCandidate) {
      // The shared key may still be written by a live pre-owner tab. Suppress
      // only the exact migrated snapshot; never delete a foreign key after a
      // non-atomic read/copy sequence.
      discardRiffPatchSources(storage, riffId, [legacyCandidate.source]);
    }
  }
  return {
    ...publicStoredRiffPatch(durableCopy),
    sources: candidates.map((candidate) => candidate.source),
  };
}

export function readRiffPatchOutbox(
  storage: RiffPatchStorage | null,
  riffId: string,
  ownerId: string,
  previousOwnerId: string | null = null,
): StoredRiffPatch {
  const result = readRiffPatchOutboxWithSources(
    storage,
    riffId,
    ownerId,
    previousOwnerId,
  );
  return { baseRevision: result.baseRevision, patch: result.patch };
}

function sameValue(actual: unknown, expected: unknown): boolean {
  if (typeof actual === "number" && typeof expected === "number") {
    return Number.isFinite(actual) && Number.isFinite(expected) && actual === expected;
  }
  return actual === expected;
}

export function classifyRiffPatchRecovery(
  current: Record<string, unknown> & { revision: number },
  stored: StoredRiffPatch,
): RiffPatchRecoveryState {
  const entries = Object.entries(stored.patch);
  if (entries.length === 0) return "empty";
  if (entries.every(([key, expected]) => sameValue(current[key], expected))) {
    return "already-applied";
  }
  return stored.baseRevision === current.revision ? "ready" : "conflict";
}

export function clearAppliedRiffPatchOutboxes(
  storage: RiffPatchStorage | null,
  riffId: string,
  current: Record<string, unknown> & { revision: number },
  currentOwnerId: string | null = null,
): number {
  if (!storage) return 0;
  const legacyKey = legacyRiffPatchStorageKey(riffId);
  const ownerPrefix = `${legacyKey}:owner:`;
  const candidates = new Set<string>([legacyKey]);
  const currentOwnerKey = currentOwnerId
    ? riffPatchStorageKey(riffId, currentOwnerId)
    : null;
  if (currentOwnerKey) candidates.add(currentOwnerKey);

  // Enumerating catches applied copies left by older reloads or a closed
  // duplicated tab. Snapshot keys before deletion because Storage indices move.
  try {
    if (typeof storage.length === "number" && typeof storage.key === "function") {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key?.startsWith(ownerPrefix)) candidates.add(key);
      }
    }
  } catch {
    // Known current/previous owner keys can still be cleaned below.
  }

  let removed = 0;
  for (const key of candidates) {
    try {
      const raw = storage.getItem(key);
      const stored = parseStoredRiffPatch(raw);
      if (!stored) continue;
      const state = classifyRiffPatchRecovery(current, stored);
      if (state !== "empty" && state !== "already-applied") continue;
      if (currentOwnerKey && key === currentOwnerKey) {
        // This document owns the key exclusively. No other tab receives this
        // freshly rotated owner ID, so synchronous removal cannot erase a
        // foreign writer's later patch.
        storage.removeItem(key);
        storage.removeItem(riffPatchDiscardKey(riffId, key));
        removed += 1;
        continue;
      }
      const source = sourceSnapshot(key, raw, stored);
      if (source) {
        // Foreign and legacy keys have no localStorage CAS. Keep them intact and
        // suppress only the exact applied snapshot; a later write has a new
        // updatedAt/raw fingerprint and becomes discoverable again.
        removed += discardRiffPatchSources(storage, riffId, [source]);
      }
    } catch {
      // Cleanup is best-effort; an unsuppressed copy is safer than false deletion.
    }
  }
  return removed;
}
