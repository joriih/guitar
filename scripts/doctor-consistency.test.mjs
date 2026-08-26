import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { acquireDoctorInspectionLease } from "./doctor.mjs";
import { acquireOperationLock } from "./operation-lock.mjs";

test("doctor acquires its generation lease before checking restore state", async () => {
  const events = [];
  const lease = {
    async release() {
      events.push("release");
    },
  };

  const acquired = await acquireDoctorInspectionLease({
    root: "/isolated-test-root",
    acquireLock: async (kind, options) => {
      events.push(`acquire:${kind}:${options.root}`);
      return lease;
    },
    assertRestoreState: async (root) => {
      events.push(`assert:${root}`);
    },
  });

  assert.equal(acquired, lease);
  assert.deepEqual(events, [
    "acquire:doctor:/isolated-test-root",
    "assert:/isolated-test-root",
  ]);
  await acquired.release();
  assert.equal(events.at(-1), "release");
});

test("doctor releases its lease when incomplete restore state blocks inspection", async () => {
  let releases = 0;
  await assert.rejects(
    acquireDoctorInspectionLease({
      root: "/isolated-test-root",
      acquireLock: async () => ({
        async release() {
          releases += 1;
        },
      }),
      assertRestoreState: async () => {
        throw new Error("incomplete restore");
      },
    }),
    /incomplete restore/,
  );
  assert.equal(releases, 1);
});

test("doctor fails closed on a real restore artifact without leaking its lease", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "riff-doctor-generation-"));
  try {
    const storage = path.join(root, "storage");
    await mkdir(storage, { recursive: true });
    await writeFile(path.join(storage, ".restore-journal.json"), "{}\n");

    await assert.rejects(
      acquireDoctorInspectionLease({ root }),
      /완전히 끝나지 않은 복원 흔적/,
    );

    const probe = await acquireOperationLock("doctor", { root });
    await probe.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
