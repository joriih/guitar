import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("standalone database initialization takes an exclusive generation lease first", async () => {
  const source = await readFile(
    new URL("./db-init.mjs", import.meta.url),
    "utf8",
  );
  const leaseIndex = source.indexOf(
    'const operationLock = await acquireOperationLock("doctor"',
  );
  const storageIndex = source.indexOf("const audioStorageDirectory");
  const adminIndex = source.indexOf("const admin = new Pool");

  assert.ok(leaseIndex > 0);
  assert.ok(storageIndex > leaseIndex);
  assert.ok(adminIndex > leaseIndex);
  assert.match(
    source.slice(leaseIndex, storageIndex),
    /if \(!parentToken\)[\s\S]*assertNoIncompleteRestoreState/,
  );
});

test("account profile revision migrates old schema dumps idempotently", async () => {
  const migration = await readFile(
    new URL("./migrations/20260827_account_profile_revision.sql", import.meta.url),
    "utf8",
  );

  assert.match(
    migration,
    /ALTER TABLE app_user\s+ADD COLUMN IF NOT EXISTS revision integer;/,
  );
  assert.match(migration, /UPDATE app_user\s+SET revision = 0\s+WHERE revision IS NULL;/);
  assert.match(migration, /ALTER COLUMN revision SET DEFAULT 0/);
  assert.match(migration, /ALTER COLUMN revision SET NOT NULL/);
  assert.match(
    migration,
    /IF NOT EXISTS[\s\S]*conname = 'app_user_revision_nonnegative'[\s\S]*CHECK \(revision >= 0\) NOT VALID/,
  );
  assert.match(
    migration,
    /VALIDATE CONSTRAINT app_user_revision_nonnegative/,
  );
});

test("audio cleanup rechecks restore state after acquiring its runtime lease", async () => {
  const source = await readFile(
    new URL("./audio-cleanup.mjs", import.meta.url),
    "utf8",
  );
  const firstCheck = source.indexOf("await assertNoIncompleteRestoreState(root)");
  const acquire = source.indexOf('acquireOperationLock("runtime"', firstCheck);
  const authoritativeCheck = source.indexOf(
    "await assertNoIncompleteRestoreState(root)",
    firstCheck + 1,
  );
  const drain = source.indexOf("await drainAudioCleanup", authoritativeCheck);

  assert.ok(firstCheck > 0);
  assert.ok(acquire > firstCheck);
  assert.ok(authoritativeCheck > acquire);
  assert.ok(drain > authoritativeCheck);
});
