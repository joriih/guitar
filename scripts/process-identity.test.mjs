import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyProcessIdentity,
  inspectProcessIdentity,
  PROCESS_IDENTITY_STATUS,
  readProcessStartSignature,
} from "./process-identity.mjs";

const EXPECTED_SIGNATURE = "Wed Aug 27 12:34:56 2026";

test("process identity requires both the PID and its original start signature", async () => {
  assert.equal(
    classifyProcessIdentity(EXPECTED_SIGNATURE, EXPECTED_SIGNATURE),
    PROCESS_IDENTITY_STATUS.LIVE,
  );
  assert.equal(
    classifyProcessIdentity(EXPECTED_SIGNATURE, "Wed Aug 27 12:35:01 2026"),
    PROCESS_IDENTITY_STATUS.STALE,
  );
  assert.equal(
    classifyProcessIdentity(EXPECTED_SIGNATURE, null),
    PROCESS_IDENTITY_STATUS.STALE,
  );
  assert.equal(
    classifyProcessIdentity(EXPECTED_SIGNATURE, undefined),
    PROCESS_IDENTITY_STATUS.INDETERMINATE,
  );
});

test("process start lookup uses an exact ps invocation and trims its signature", async () => {
  const calls = [];
  const signature = await readProcessStartSignature(42, {
    execute: async (...argumentsList) => {
      calls.push(argumentsList);
      return { stdout: `  ${EXPECTED_SIGNATURE}  \n` };
    },
  });

  assert.equal(signature, EXPECTED_SIGNATURE);
  assert.deepEqual(calls, [
    [
      "/bin/ps",
      ["-p", "42", "-o", "lstart="],
      { encoding: "utf8", maxBuffer: 4_096 },
    ],
  ]);
});

test("missing and reused PIDs are stale while an unreliable lookup is indeterminate", async () => {
  const missing = Object.assign(new Error("missing"), { code: 1 });
  assert.equal(
    await inspectProcessIdentity(42, EXPECTED_SIGNATURE, {
      execute: async () => {
        throw missing;
      },
    }),
    PROCESS_IDENTITY_STATUS.STALE,
  );
  assert.equal(
    await inspectProcessIdentity(42, EXPECTED_SIGNATURE, {
      execute: async () => ({ stdout: "Thu Aug 28 00:00:00 2026\n" }),
    }),
    PROCESS_IDENTITY_STATUS.STALE,
  );
  assert.equal(
    await inspectProcessIdentity(42, EXPECTED_SIGNATURE, {
      execute: async () => {
        throw Object.assign(new Error("ps unavailable"), { code: "EIO" });
      },
    }),
    PROCESS_IDENTITY_STATUS.INDETERMINATE,
  );
});

test("a newly spawned server requires a trustworthy process signature", async () => {
  await assert.rejects(
    readProcessStartSignature(42, {
      required: true,
      execute: async () => {
        throw Object.assign(new Error("ps unavailable"), { code: "EIO" });
      },
    }),
    /안전하게 확인할 수 없어요/,
  );
  await assert.rejects(
    readProcessStartSignature(42, {
      required: true,
      execute: async () => {
        throw Object.assign(new Error("missing"), { code: 1 });
      },
    }),
    /이미 종료되어/,
  );
});
