import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error Node's type-stripping test runner requires the .ts extension.
import { attemptQueuedAudioCleanupWith } from "./audio-cleanup-core.ts";
// @ts-expect-error Node's type-stripping test runner requires the .ts extension.
import { isValidAudioStoragePath } from "./audio-storage-path.ts";

const STORAGE_PATH = "12345678-1234-4123-8123-123456789abc.wav";

function dependencies(options?: {
  referenced?: boolean;
  removeError?: NodeJS.ErrnoException;
  referenceError?: Error;
  acknowledgeError?: Error;
}) {
  const state = {
    removed: 0,
    acknowledged: 0,
    attempts: 0,
    lastError: null as string | null,
    logs: [] as string[],
  };
  return {
    state,
    value: {
      isReferenced: async () => {
        if (options?.referenceError) throw options.referenceError;
        return options?.referenced ?? false;
      },
      removeFile: async () => {
        state.removed += 1;
        if (options?.removeError) throw options.removeError;
      },
      acknowledge: async () => {
        state.acknowledged += 1;
        if (options?.acknowledgeError) throw options.acknowledgeError;
      },
      recordFailure: async (_storagePath: string, errorCode: string) => {
        state.attempts += 1;
        state.lastError = errorCode;
      },
      logFailure: (errorCode: string) => {
        state.logs.push(errorCode);
      },
    },
  };
}

test("successful and already-missing files both clear the durable queue", async () => {
  const success = dependencies();
  assert.deepEqual(
    await attemptQueuedAudioCleanupWith(STORAGE_PATH, success.value),
    { cleanupPending: false, outcome: "removed" },
  );
  assert.equal(success.state.removed, 1);
  assert.equal(success.state.acknowledged, 1);

  const missingError = Object.assign(new Error("missing"), { code: "ENOENT" });
  const missing = dependencies({ removeError: missingError });
  assert.deepEqual(
    await attemptQueuedAudioCleanupWith(STORAGE_PATH, missing.value),
    { cleanupPending: false, outcome: "missing" },
  );
  assert.equal(missing.state.acknowledged, 1);
  assert.equal(missing.state.attempts, 0);
});

test("unlink failures retain the queue and increment its safe error state", async () => {
  const permissionError = Object.assign(new Error(`/private/path/${STORAGE_PATH}`), {
    code: "EPERM",
  });
  const failure = dependencies({ removeError: permissionError });
  assert.deepEqual(
    await attemptQueuedAudioCleanupWith(STORAGE_PATH, failure.value),
    { cleanupPending: true, outcome: "pending" },
  );
  assert.equal(failure.state.attempts, 1);
  assert.equal(failure.state.lastError, "EPERM");
  assert.deepEqual(failure.state.logs, ["EPERM"]);
  assert.equal(failure.state.logs.join(" ").includes(STORAGE_PATH), false);
  assert.equal(failure.state.acknowledged, 0);
});

test("a stale queue entry never removes a path referenced by current data", async () => {
  const referenced = dependencies({ referenced: true });
  assert.deepEqual(
    await attemptQueuedAudioCleanupWith(STORAGE_PATH, referenced.value),
    { cleanupPending: false, outcome: "referenced" },
  );
  assert.equal(referenced.state.removed, 0);
  assert.equal(referenced.state.acknowledged, 1);
});

test("reference or queue acknowledgement failures keep work retryable", async () => {
  const referenceFailure = dependencies({ referenceError: new Error("db offline") });
  assert.equal(
    (await attemptQueuedAudioCleanupWith(STORAGE_PATH, referenceFailure.value))
      .cleanupPending,
    true,
  );
  assert.equal(referenceFailure.state.lastError, "AUDIO_REFERENCE_CHECK_FAILED");
  assert.equal(referenceFailure.state.removed, 0);

  const acknowledgementFailure = dependencies({
    acknowledgeError: new Error("db offline"),
  });
  assert.equal(
    (await attemptQueuedAudioCleanupWith(STORAGE_PATH, acknowledgementFailure.value))
      .cleanupPending,
    true,
  );
  assert.equal(
    acknowledgementFailure.state.lastError,
    "AUDIO_CLEANUP_QUEUE_ACK_FAILED",
  );
});

test("stored audio paths reject traversal, separators, and unsupported extensions", () => {
  assert.equal(isValidAudioStoragePath(STORAGE_PATH), true);
  assert.equal(isValidAudioStoragePath(`../${STORAGE_PATH}`), false);
  assert.equal(isValidAudioStoragePath(`folder/${STORAGE_PATH}`), false);
  assert.equal(isValidAudioStoragePath(`folder\\${STORAGE_PATH}`), false);
  assert.equal(
    isValidAudioStoragePath("12345678-1234-4123-8123-123456789abc.txt"),
    false,
  );
});
