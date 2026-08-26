import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error Node's type-stripping test runner requires the .ts extension.
import * as recordingUtils from "./utils.ts";

// @ts-expect-error Node's type-stripping test runner requires the .ts extension.
import * as riffPatchOutbox from "./riff-patch-outbox.ts";

const {
  completeTakeDuplicateRequest,
  captureLocksStudioTransport,
  createClientRecordingId,
  createTakeMutationLock,
  createTapTempoState,
  extractTakes,
  getOrCreateTakeDuplicateRequest,
  nextCycleDeadline,
  registerTapTempo,
} = recordingUtils;

const {
  classifyRiffPatchRecovery,
  clearAppliedRiffPatchOutboxes,
  createRiffPatchOwner,
  discardRiffPatchSources,
  persistRiffPatchOutbox,
  readRiffPatchOutbox,
  readRiffPatchOutboxWithSources,
  riffPatchStorageKey,
} = riffPatchOutbox;

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    get length() {
      return values.size;
    },
    key: (index: number) => Array.from(values.keys())[index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

test("recording recovery IDs are strict UUID v4 values", () => {
  const first = createClientRecordingId();
  const second = createClientRecordingId();
  assert.match(
    first,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  assert.notEqual(first, second);
});

test("shared studio transport stays locked through every non-idle capture phase", () => {
  assert.equal(captureLocksStudioTransport("idle"), false);
  for (const state of [
    "preparing",
    "counting",
    "recording",
    "processing",
    "uploading",
  ] as const) {
    assert.equal(captureLocksStudioTransport(state), true, state);
  }
});

test("take duplicate response-loss retry reuses one ID, then completion rotates it", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  const firstId = "10000000-0000-4000-8000-000000000001";
  const secondId = "20000000-0000-4000-8000-000000000002";
  const first = getOrCreateTakeDuplicateRequest(
    storage,
    "riff-a",
    "take-a",
    () => firstId,
  );
  const responseLossRetry = getOrCreateTakeDuplicateRequest(
    storage,
    "riff-a",
    "take-a",
    () => {
      throw new Error("a stored request ID should be reused");
    },
  );
  assert.equal(responseLossRetry.requestId, first.requestId);

  // A successful server response or GET-list reconciliation completes the
  // first operation. The next user click must create an intentional new copy.
  completeTakeDuplicateRequest(storage, responseLossRetry.storageKey);
  const nextIntentionalDuplicate = getOrCreateTakeDuplicateRequest(
    storage,
    "riff-a",
    "take-a",
    () => secondId,
  );
  assert.equal(nextIntentionalDuplicate.requestId, secondId);
  assert.notEqual(nextIntentionalDuplicate.requestId, first.requestId);
});

test("take mutation lock rejects follow-up inspector writes until refresh completes", () => {
  const lock = createTakeMutationLock();
  assert.equal(lock.tryAcquire("take-a"), true);
  assert.equal(lock.pendingTakeId, "take-a");
  assert.equal(lock.tryAcquire("take-a"), false);
  assert.equal(lock.tryAcquire("take-b"), false);

  // A stale completion from another operation cannot unlock the active take.
  assert.equal(lock.release("take-b"), false);
  assert.equal(lock.pendingTakeId, "take-a");
  assert.equal(lock.release("take-a"), true);
  assert.equal(lock.pendingTakeId, null);
  assert.equal(lock.tryAcquire("take-b"), true);
});

test("riff patch owner writes stay isolated while recovery merges safe drafts", () => {
  const local = memoryStorage();
  const firstSession = memoryStorage();
  const secondSession = memoryStorage();
  const firstOwnerId = "10000000-0000-4000-8000-000000000001";
  const secondOwnerId = "20000000-0000-4000-8000-000000000002";
  const reloadedOwnerId = "30000000-0000-4000-8000-000000000003";

  const firstMount = createRiffPatchOwner(firstSession, "riff-a", () => firstOwnerId);
  persistRiffPatchOutbox(local, "riff-a", firstMount.ownerId, 4, {
    title: "새로고침 전 제목",
  });
  const firstOwner = createRiffPatchOwner(
    firstSession,
    "riff-a",
    () => reloadedOwnerId,
  );
  assert.deepEqual(firstOwner, {
    ownerId: reloadedOwnerId,
    previousOwnerId: firstOwnerId,
  });
  assert.deepEqual(
    readRiffPatchOutbox(
      local,
      "riff-a",
      firstOwner.ownerId,
      firstOwner.previousOwnerId,
    ),
    { baseRevision: 4, patch: { title: "새로고침 전 제목" } },
  );
  assert.equal(local.values.has(riffPatchStorageKey("riff-a", firstOwnerId)), true);
  assert.equal(
    clearAppliedRiffPatchOutboxes(
      local,
      "riff-a",
      { revision: 5, title: "새로고침 전 제목" },
      firstOwner.ownerId,
    ),
    2,
  );

  const secondOwner = createRiffPatchOwner(
    secondSession,
    "riff-a",
    () => secondOwnerId,
  );

  assert.equal(persistRiffPatchOutbox(local, "riff-a", firstOwner.ownerId, 4, {
    title: "첫 번째 탭",
  }), true);
  assert.equal(persistRiffPatchOutbox(local, "riff-a", secondOwner.ownerId, 4, {
    notes: "두 번째 탭",
  }), true);
  assert.deepEqual(readRiffPatchOutbox(local, "riff-a", firstOwner.ownerId), {
    baseRevision: 4,
    patch: { title: "첫 번째 탭", notes: "두 번째 탭" },
  });
  assert.deepEqual(readRiffPatchOutbox(local, "riff-a", secondOwner.ownerId), {
    baseRevision: 4,
    patch: { title: "첫 번째 탭", notes: "두 번째 탭" },
  });

  persistRiffPatchOutbox(local, "riff-a", firstOwner.ownerId, 4, {});
  assert.equal(
    local.values.has(riffPatchStorageKey("riff-a", firstOwner.ownerId)),
    false,
  );
  assert.deepEqual(readRiffPatchOutbox(local, "riff-a", secondOwner.ownerId).patch, {
    title: "첫 번째 탭",
    notes: "두 번째 탭",
  });
});

test("a duplicated tab cannot steal the original tab's only durable outbox", () => {
  const local = memoryStorage();
  const originalSession = memoryStorage();
  const duplicatedSession = memoryStorage();
  const originalOwner = createRiffPatchOwner(
    originalSession,
    "riff-a",
    () => "10000000-0000-4000-8000-000000000001",
  );
  persistRiffPatchOutbox(local, "riff-a", originalOwner.ownerId, 6, {
    title: "아직 서버에 없는 제목",
  });

  // Browser tab duplication clones sessionStorage, so the new document sees
  // the live original owner as its previous owner.
  for (const [key, value] of originalSession.values) {
    duplicatedSession.values.set(key, value);
  }
  const duplicatedOwner = createRiffPatchOwner(
    duplicatedSession,
    "riff-a",
    () => "20000000-0000-4000-8000-000000000002",
  );
  assert.equal(duplicatedOwner.previousOwnerId, originalOwner.ownerId);
  assert.deepEqual(
    readRiffPatchOutbox(
      local,
      "riff-a",
      duplicatedOwner.ownerId,
      duplicatedOwner.previousOwnerId,
    ).patch,
    { title: "아직 서버에 없는 제목" },
  );
  assert.equal(
    local.values.has(riffPatchStorageKey("riff-a", originalOwner.ownerId)),
    true,
  );

  // Even if the duplicate disappears and the original crashes, the original
  // session can still rotate owners and recover its own durable source.
  const reloadedOriginal = createRiffPatchOwner(
    originalSession,
    "riff-a",
    () => "30000000-0000-4000-8000-000000000003",
  );
  assert.deepEqual(
    readRiffPatchOutbox(
      local,
      "riff-a",
      reloadedOriginal.ownerId,
      reloadedOriginal.previousOwnerId,
    ).patch,
    { title: "아직 서버에 없는 제목" },
  );

  // Once the desired state is proven on the server, the self-owned copy is
  // removed while exact foreign snapshots are suppressed without mutating them.
  assert.equal(
    clearAppliedRiffPatchOutboxes(
      local,
      "riff-a",
      { revision: 7, title: "아직 서버에 없는 제목" },
      reloadedOriginal.ownerId,
    ),
    3,
  );
  assert.equal(
    Array.from(local.values.keys()).filter((key) =>
      key.startsWith("riff-sketchbook:pending-riff:riff-a:owner:"),
    ).length,
    2,
  );
  assert.deepEqual(
    readRiffPatchOutbox(
      local,
      "riff-a",
      "40000000-0000-4000-8000-000000000004",
    ),
    { baseRevision: null, patch: {} },
  );
});

test("known owners still merge a newer orphan into an explicit conflict", () => {
  const local = memoryStorage();
  const previousOwnerId = "10000000-0000-4000-8000-000000000001";
  const currentOwnerId = "20000000-0000-4000-8000-000000000002";
  const closedOwnerId = "30000000-0000-4000-8000-000000000003";
  persistRiffPatchOutbox(
    local,
    "riff-a",
    previousOwnerId,
    9,
    { title: "이전 탭 제목", notes: "이전 탭 메모" },
    100,
  );
  persistRiffPatchOutbox(
    local,
    "riff-a",
    currentOwnerId,
    9,
    { title: "현재 탭 제목", tab: "e|--3--|" },
    150,
  );
  persistRiffPatchOutbox(
    local,
    "riff-a",
    closedOwnerId,
    9,
    { title: "닫힌 탭의 최신 제목", bpm: 140 },
    200,
  );

  const recovered = readRiffPatchOutboxWithSources(
    local,
    "riff-a",
    currentOwnerId,
    previousOwnerId,
  );
  assert.deepEqual(
    { baseRevision: recovered.baseRevision, patch: recovered.patch },
    {
      baseRevision: null,
      patch: {
        title: "닫힌 탭의 최신 제목",
        notes: "이전 탭 메모",
        tab: "e|--3--|",
        bpm: 140,
      },
    },
  );
  assert.deepEqual(
    recovered.sources.map((source) => source.key),
    [
      riffPatchStorageKey("riff-a", previousOwnerId),
      riffPatchStorageKey("riff-a", currentOwnerId),
      riffPatchStorageKey("riff-a", closedOwnerId),
    ],
  );
  assert.equal(
    classifyRiffPatchRecovery(
      { revision: 9, title: "서버 제목", notes: "", tab: "", bpm: 120 },
      recovered,
    ),
    "conflict",
  );
  assert.equal(
    local.values.has(riffPatchStorageKey("riff-a", previousOwnerId)),
    true,
  );
  assert.equal(
    local.values.has(riffPatchStorageKey("riff-a", closedOwnerId)),
    true,
  );
});

test("other riff reloads cannot orphan this riff's session owner chain", () => {
  const local = memoryStorage();
  const session = memoryStorage();
  const riffAOwner = createRiffPatchOwner(
    session,
    "riff-a",
    () => "10000000-0000-4000-8000-000000000001",
  );
  persistRiffPatchOutbox(local, "riff-a", riffAOwner.ownerId, 2, {
    notes: "A의 오프라인 메모",
  });

  createRiffPatchOwner(
    session,
    "riff-b",
    () => "20000000-0000-4000-8000-000000000002",
  );
  createRiffPatchOwner(
    session,
    "riff-b",
    () => "30000000-0000-4000-8000-000000000003",
  );
  createRiffPatchOwner(
    session,
    "riff-b",
    () => "40000000-0000-4000-8000-000000000004",
  );

  const reopenedRiffA = createRiffPatchOwner(
    session,
    "riff-a",
    () => "50000000-0000-4000-8000-000000000005",
  );
  assert.equal(reopenedRiffA.previousOwnerId, riffAOwner.ownerId);
  assert.deepEqual(
    readRiffPatchOutbox(
      local,
      "riff-a",
      reopenedRiffA.ownerId,
      reopenedRiffA.previousOwnerId,
    ),
    { baseRevision: 2, patch: { notes: "A의 오프라인 메모" } },
  );
});

test("a new tab discovers a riff outbox after sessionStorage is gone", () => {
  const local = memoryStorage();
  const closedTabSession = memoryStorage();
  const closedOwner = createRiffPatchOwner(
    closedTabSession,
    "riff-a",
    () => "10000000-0000-4000-8000-000000000001",
  );
  persistRiffPatchOutbox(
    local,
    "riff-a",
    closedOwner.ownerId,
    11,
    { tab: "e|--0--3--|" },
    100,
  );

  // A completely new tab has no per-riff session owner pointer.
  const newOwner = createRiffPatchOwner(
    memoryStorage(),
    "riff-a",
    () => "20000000-0000-4000-8000-000000000002",
  );
  assert.equal(newOwner.previousOwnerId, null);
  assert.deepEqual(
    readRiffPatchOutbox(
      local,
      "riff-a",
      newOwner.ownerId,
      newOwner.previousOwnerId,
    ),
    { baseRevision: 11, patch: { tab: "e|--0--3--|" } },
  );
  assert.equal(
    local.values.has(riffPatchStorageKey("riff-a", closedOwner.ownerId)),
    true,
  );
  assert.equal(
    local.values.has(riffPatchStorageKey("riff-a", newOwner.ownerId)),
    true,
  );
});

test("divergent orphan owners force an explicit conflict and keep every source", () => {
  const local = memoryStorage();
  const olderOwnerId = "10000000-0000-4000-8000-000000000001";
  const newerOwnerId = "20000000-0000-4000-8000-000000000002";
  const recoveringOwnerId = "30000000-0000-4000-8000-000000000003";
  persistRiffPatchOutbox(
    local,
    "riff-a",
    olderOwnerId,
    5,
    { title: "오래된 탭 제목", notes: "오래된 탭 메모" },
    100,
  );
  persistRiffPatchOutbox(
    local,
    "riff-a",
    newerOwnerId,
    5,
    { title: "최신 탭 제목", tab: "e|--7--|" },
    200,
  );

  const recovered = readRiffPatchOutbox(
    local,
    "riff-a",
    recoveringOwnerId,
  );
  assert.deepEqual(recovered, {
    baseRevision: null,
    patch: {
      title: "최신 탭 제목",
      notes: "오래된 탭 메모",
      tab: "e|--7--|",
    },
  });
  assert.equal(
    classifyRiffPatchRecovery(
      { revision: 5, title: "서버 제목", notes: "", tab: "" },
      recovered,
    ),
    "conflict",
  );
  assert.equal(local.values.has(riffPatchStorageKey("riff-a", olderOwnerId)), true);
  assert.equal(local.values.has(riffPatchStorageKey("riff-a", newerOwnerId)), true);
  assert.equal(
    local.values.has(riffPatchStorageKey("riff-a", recoveringOwnerId)),
    true,
  );
});

test("explicit server-version discard suppresses only the exact orphan snapshot", () => {
  const local = memoryStorage();
  const sourceOwnerId = "10000000-0000-4000-8000-000000000001";
  const recoveringOwnerId = "20000000-0000-4000-8000-000000000002";
  persistRiffPatchOutbox(
    local,
    "riff-a",
    sourceOwnerId,
    4,
    { title: "버릴 임시 제목" },
    100,
  );
  const recovered = readRiffPatchOutboxWithSources(
    local,
    "riff-a",
    recoveringOwnerId,
  );
  assert.equal(recovered.sources.length, 1);
  assert.equal(discardRiffPatchSources(local, "riff-a", recovered.sources), 1);
  persistRiffPatchOutbox(local, "riff-a", recoveringOwnerId, 5, {});

  // The exact source remains durable for a live tab, but does not reappear
  // after the user explicitly chose the authoritative server version.
  assert.equal(local.values.has(riffPatchStorageKey("riff-a", sourceOwnerId)), true);
  assert.deepEqual(
    readRiffPatchOutbox(
      local,
      "riff-a",
      "30000000-0000-4000-8000-000000000003",
    ),
    { baseRevision: null, patch: {} },
  );

  // A later write from that live source owner clears/mismatches the tombstone
  // and must become discoverable again.
  persistRiffPatchOutbox(
    local,
    "riff-a",
    sourceOwnerId,
    5,
    { title: "라이브 탭의 새 제목" },
    200,
  );
  assert.deepEqual(
    readRiffPatchOutbox(
      local,
      "riff-a",
      "40000000-0000-4000-8000-000000000004",
    ),
    { baseRevision: 5, patch: { title: "라이브 탭의 새 제목" } },
  );
});

test("explicit local rebase consumes a losing divergent source without deleting it", () => {
  const local = memoryStorage();
  const losingOwnerId = "10000000-0000-4000-8000-000000000001";
  const winningOwnerId = "20000000-0000-4000-8000-000000000002";
  const recoveringOwnerId = "30000000-0000-4000-8000-000000000003";
  persistRiffPatchOutbox(
    local,
    "riff-a",
    losingOwnerId,
    8,
    { title: "이전 제목", notes: "살릴 메모" },
    100,
  );
  persistRiffPatchOutbox(
    local,
    "riff-a",
    winningOwnerId,
    8,
    { title: "선택할 제목", tab: "e|--5--|" },
    200,
  );
  const recovered = readRiffPatchOutboxWithSources(
    local,
    "riff-a",
    recoveringOwnerId,
  );
  assert.equal(recovered.baseRevision, null);
  assert.equal(recovered.sources.length, 2);

  // Mirrors the user's explicit "내 내용으로 저장" choice before the CAS retry.
  assert.equal(discardRiffPatchSources(local, "riff-a", recovered.sources), 2);
  persistRiffPatchOutbox(
    local,
    "riff-a",
    recoveringOwnerId,
    8,
    recovered.patch,
    300,
  );
  const acknowledged = { revision: 9, ...recovered.patch };
  clearAppliedRiffPatchOutboxes(
    local,
    "riff-a",
    acknowledged as Record<string, unknown> & { revision: number },
    recoveringOwnerId,
  );

  // The losing source is still durable because one field did not match the
  // acknowledgement, but its exact consumed snapshot stays suppressed.
  assert.equal(local.values.has(riffPatchStorageKey("riff-a", losingOwnerId)), true);
  assert.deepEqual(
    readRiffPatchOutbox(
      local,
      "riff-a",
      "40000000-0000-4000-8000-000000000004",
    ),
    { baseRevision: null, patch: {} },
  );

  persistRiffPatchOutbox(
    local,
    "riff-a",
    losingOwnerId,
    9,
    { title: "원래 탭의 새 변경" },
    400,
  );
  assert.deepEqual(
    readRiffPatchOutbox(
      local,
      "riff-a",
      "50000000-0000-4000-8000-000000000005",
    ),
    { baseRevision: 9, patch: { title: "원래 탭의 새 변경" } },
  );
});

test("failed local replacement write leaves recovery sources unsuppressed", () => {
  const local = memoryStorage();
  const sourceOwnerId = "10000000-0000-4000-8000-000000000001";
  const replacementOwnerId = "20000000-0000-4000-8000-000000000002";
  persistRiffPatchOutbox(
    local,
    "riff-a",
    sourceOwnerId,
    2,
    { notes: "반드시 남아야 할 메모" },
    100,
  );
  const replacementKey = riffPatchStorageKey("riff-a", replacementOwnerId);
  const failingReplacement = {
    get length() {
      return local.values.size;
    },
    key: local.key,
    getItem: local.getItem,
    removeItem: local.removeItem,
    setItem: (key: string, value: string) => {
      if (key === replacementKey) throw new Error("quota full");
      local.setItem(key, value);
    },
  };
  const recovered = readRiffPatchOutboxWithSources(
    failingReplacement,
    "riff-a",
    replacementOwnerId,
  );
  const replacementPersisted = persistRiffPatchOutbox(
    failingReplacement,
    "riff-a",
    replacementOwnerId,
    2,
    recovered.patch,
  );
  if (replacementPersisted) {
    discardRiffPatchSources(failingReplacement, "riff-a", recovered.sources);
  }
  assert.equal(replacementPersisted, false);
  assert.deepEqual(
    readRiffPatchOutbox(
      local,
      "riff-a",
      "30000000-0000-4000-8000-000000000003",
    ),
    { baseRevision: 2, patch: { notes: "반드시 남아야 할 메모" } },
  );
});

test("partial source suppression is detectable and safely retryable", () => {
  const local = memoryStorage();
  const recoveringOwnerId = "30000000-0000-4000-8000-000000000003";
  persistRiffPatchOutbox(
    local,
    "riff-a",
    "10000000-0000-4000-8000-000000000001",
    6,
    { notes: "첫 임시본" },
    100,
  );
  persistRiffPatchOutbox(
    local,
    "riff-a",
    "20000000-0000-4000-8000-000000000002",
    6,
    { tab: "e|--9--|" },
    200,
  );
  const recovered = readRiffPatchOutboxWithSources(
    local,
    "riff-a",
    recoveringOwnerId,
  );
  assert.equal(recovered.sources.length, 2);
  let tombstoneWrites = 0;
  const partiallyFailing = {
    get length() {
      return local.values.size;
    },
    key: local.key,
    getItem: local.getItem,
    removeItem: local.removeItem,
    setItem: (key: string, value: string) => {
      if (key.includes(":discarded:")) {
        tombstoneWrites += 1;
        if (tombstoneWrites === 2) throw new Error("quota full");
      }
      local.setItem(key, value);
    },
  };

  const firstAttempt = discardRiffPatchSources(
    partiallyFailing,
    "riff-a",
    recovered.sources,
  );
  assert.equal(firstAttempt, 1);
  // Mirrors the component guard: do not clear the replacement/conflict unless
  // every source snapshot was durably suppressed.
  if (Number(firstAttempt) === Number(recovered.sources.length)) {
    persistRiffPatchOutbox(local, "riff-a", recoveringOwnerId, 6, {});
  }
  assert.equal(
    local.values.has(riffPatchStorageKey("riff-a", recoveringOwnerId)),
    true,
  );

  assert.equal(
    discardRiffPatchSources(local, "riff-a", recovered.sources),
    recovered.sources.length,
  );
  persistRiffPatchOutbox(local, "riff-a", recoveringOwnerId, 6, {});
  assert.deepEqual(
    readRiffPatchOutbox(
      local,
      "riff-a",
      "40000000-0000-4000-8000-000000000004",
    ),
    { baseRevision: null, patch: {} },
  );
});

test("applied cleanup suppresses a foreign snapshot without deleting a racing rewrite", () => {
  const local = memoryStorage();
  const foreignOwnerId = "10000000-0000-4000-8000-000000000001";
  const foreignKey = riffPatchStorageKey("riff-a", foreignOwnerId);
  persistRiffPatchOutbox(
    local,
    "riff-a",
    foreignOwnerId,
    3,
    { title: "이미 서버에 반영됨" },
    100,
  );
  let raced = false;
  const racingStorage = {
    get length() {
      return local.values.size;
    },
    key: local.key,
    getItem: local.getItem,
    removeItem: local.removeItem,
    setItem: (key: string, value: string) => {
      if (!raced && key.includes(":discarded:")) {
        raced = true;
        local.values.set(
          foreignKey,
          JSON.stringify({
            baseRevision: 4,
            patch: { title: "라이브 탭의 더 새로운 값" },
            updatedAt: 200,
          }),
        );
      }
      local.setItem(key, value);
    },
  };
  clearAppliedRiffPatchOutboxes(
    racingStorage,
    "riff-a",
    { revision: 4, title: "이미 서버에 반영됨" },
    "90000000-0000-4000-8000-000000000009",
  );
  assert.equal(local.values.has(foreignKey), true);
  assert.deepEqual(
    readRiffPatchOutbox(
      local,
      "riff-a",
      "20000000-0000-4000-8000-000000000002",
    ),
    { baseRevision: 4, patch: { title: "라이브 탭의 더 새로운 값" } },
  );
});

test("legacy migration cannot delete a live legacy writer's racing edit", () => {
  const local = memoryStorage();
  const legacyKey = "riff-sketchbook:pending-riff:riff-a";
  local.values.set(legacyKey, JSON.stringify({ title: "이전 legacy 값" }));
  let raced = false;
  const racingStorage = {
    get length() {
      return local.values.size;
    },
    key: local.key,
    getItem: local.getItem,
    removeItem: local.removeItem,
    setItem: (key: string, value: string) => {
      if (!raced && key.includes(":discarded:")) {
        raced = true;
        local.values.set(legacyKey, JSON.stringify({ title: "legacy 탭의 새 값" }));
      }
      local.setItem(key, value);
    },
  };
  assert.deepEqual(
    readRiffPatchOutbox(
      racingStorage,
      "riff-a",
      "10000000-0000-4000-8000-000000000001",
    ),
    { baseRevision: null, patch: { title: "이전 legacy 값" } },
  );
  assert.equal(local.values.has(legacyKey), true);
  const recoveredRace = readRiffPatchOutboxWithSources(
    local,
    "riff-a",
    "20000000-0000-4000-8000-000000000002",
  );
  // The copied pre-race value and the live legacy rewrite are both retained;
  // neither is silently selected as safe when their title values diverge.
  assert.deepEqual(
    { baseRevision: recoveredRace.baseRevision, patch: recoveredRace.patch },
    { baseRevision: null, patch: { title: "이전 legacy 값" } },
  );
  assert.equal(recoveredRace.sources.length, 2);
});

test("legacy overlap migration preserves fields and requires an explicit conflict", () => {
  const storage = memoryStorage();
  const ownerId = "10000000-0000-4000-8000-000000000001";
  const legacyKey = "riff-sketchbook:pending-riff:riff-a";
  storage.values.set(
    legacyKey,
    JSON.stringify({
      baseRevision: 7,
      patch: { title: "이전 제목", notes: "보존할 메모" },
    }),
  );
  persistRiffPatchOutbox(storage, "riff-a", ownerId, 7, {
    title: "현재 탭 제목",
    bpm: 132,
  });

  assert.deepEqual(readRiffPatchOutbox(storage, "riff-a", ownerId), {
    baseRevision: null,
    patch: { title: "현재 탭 제목", notes: "보존할 메모", bpm: 132 },
  });
  assert.equal(storage.values.has(legacyKey), true);
  const migrated = JSON.parse(
    storage.values.get(riffPatchStorageKey("riff-a", ownerId)) ?? "null",
  ) as Record<string, unknown>;
  assert.deepEqual(
    { baseRevision: migrated.baseRevision, patch: migrated.patch },
    {
      baseRevision: null,
      patch: { title: "현재 탭 제목", notes: "보존할 메모", bpm: 132 },
    },
  );
  assert.equal(typeof migrated.updatedAt, "number");
});

test("legacy riff migration keeps unsafe base merges explicit and never deletes before write", () => {
  const values = new Map<string, string>();
  const legacyKey = "riff-sketchbook:pending-riff:riff-a";
  const ownerId = "10000000-0000-4000-8000-000000000001";
  values.set(
    legacyKey,
    JSON.stringify({ baseRevision: 3, patch: { notes: "legacy" } }),
  );
  values.set(
    riffPatchStorageKey("riff-a", ownerId),
    JSON.stringify({ baseRevision: 5, patch: { tab: "owner" } }),
  );
  const failingStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: () => {
      throw new Error("quota full");
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };

  assert.deepEqual(readRiffPatchOutbox(failingStorage, "riff-a", ownerId), {
    baseRevision: null,
    patch: { notes: "legacy", tab: "owner" },
  });
  assert.equal(values.has(legacyKey), true);
});

test("pagehide keepalive recovery accepts matching server fields as applied", () => {
  const current = {
    revision: 9,
    title: "서버에 저장됨",
    bpm: 128,
    notes: "다른 탭의 메모",
  };
  assert.equal(
    classifyRiffPatchRecovery(current, {
      baseRevision: 8,
      patch: { title: "서버에 저장됨", bpm: 128 },
    }),
    "already-applied",
  );
  assert.equal(
    classifyRiffPatchRecovery(current, {
      baseRevision: 8,
      patch: { title: "아직 저장 안 됨", bpm: 128 },
    }),
    "conflict",
  );
  assert.equal(
    classifyRiffPatchRecovery(current, {
      baseRevision: 9,
      patch: { title: "다음 제목" },
    }),
    "ready",
  );
});

test("nextCycleDeadline keeps successive takes on the original grid", () => {
  const first = nextCycleDeadline(1_000, 0, 4_000);
  const second = nextCycleDeadline(5_120, first, 4_000);

  assert.equal(first, 5_000);
  assert.equal(second, 9_000);
});

test("nextCycleDeadline reanchors after a suspended page misses the next loop", () => {
  assert.equal(nextCycleDeadline(12_000, 5_000, 4_000), 16_000);
});

test("extractTakes defensively normalizes mixed API fields", () => {
  const takes = extractTakes({
    takes: [
      {
        id: "take-a",
        take_no: "2",
        duration_seconds: 1.25,
        trim_end_ms: null,
        is_primary: "true",
      },
    ],
  });

  assert.deepEqual(takes, [
    {
      id: "take-a",
      riffId: "",
      takeNo: 2,
      name: "Take 02",
      durationMs: 1_250,
      trimStartMs: 0,
      trimEndMs: null,
      offsetMs: 0,
      mimeType: "audio/webm",
      byteSize: 0,
      isPrimary: true,
      revision: 0,
      createdAt: "",
      audioUrl: "/api/takes/take-a/audio",
    },
  ]);
});

test("registerTapTempo derives a stable BPM from recent jittered taps", () => {
  let state = createTapTempoState();
  const bpms: Array<number | null> = [];

  for (const tapAtMs of [1_000, 1_500, 1_990, 2_500]) {
    const result = registerTapTempo(state, tapAtMs);
    state = result.state;
    bpms.push(result.bpm);
  }

  assert.deepEqual(bpms, [null, 120, 121, 120]);
  assert.equal(state.intervalsMs.length, 3);
});

test("registerTapTempo resets after idle and learns the new tempo", () => {
  let first = registerTapTempo(createTapTempoState(), 1_000);
  first = registerTapTempo(first.state, 1_500);
  assert.equal(first.bpm, 120);

  const idle = registerTapTempo(first.state, 4_100);
  assert.equal(idle.resetReason, "idle");
  assert.equal(idle.bpm, null);
  assert.equal(idle.tapCount, 1);

  const newTempo = registerTapTempo(idle.state, 4_500);
  assert.equal(newTempo.bpm, 150);
});

test("registerTapTempo resets an outlier instead of skewing the pulse", () => {
  let result = registerTapTempo(createTapTempoState(), 1_000);
  result = registerTapTempo(result.state, 1_500);
  result = registerTapTempo(result.state, 2_000);

  const outlier = registerTapTempo(result.state, 2_800);
  assert.equal(outlier.resetReason, "outlier");
  assert.equal(outlier.bpm, null);

  const recovered = registerTapTempo(outlier.state, 3_400);
  assert.equal(recovered.bpm, 100);
});

test("registerTapTempo accepts and clamps the supported BPM boundaries", () => {
  const fastestStart = registerTapTempo(createTapTempoState(), 1_000);
  const fastest = registerTapTempo(fastestStart.state, 1_200);
  assert.equal(fastest.bpm, 300);

  const slowestStart = registerTapTempo(createTapTempoState(), 1_000);
  const slowest = registerTapTempo(slowestStart.state, 3_000);
  assert.equal(slowest.bpm, 30);
});
