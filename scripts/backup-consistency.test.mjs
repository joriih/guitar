import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  acquireBackupGenerationLease,
  beginConsistentBackupSnapshot,
  SESSION_BEARING_BACKUP_EXCLUSIONS,
} from "./backup.mjs";

function normalized(sql) {
  return sql.replace(/\s+/g, " ").trim();
}

test("backup excludes all session-bearing recovery rows", () => {
  assert.deepEqual(SESSION_BEARING_BACKUP_EXCLUSIONS, [
    "--exclude-table-data=public.app_session",
    "--exclude-table-data=public.password_change_request",
  ]);
});

test("backup locks audio reference tables before exporting its snapshot", async () => {
  const queries = [];
  const client = {
    async query(sql) {
      queries.push(normalized(sql));
      if (sql.includes("pg_export_snapshot")) {
        return { rows: [{ snapshot: "00000003-0000002A-1" }] };
      }
      return { rows: [] };
    },
  };

  assert.equal(
    await beginConsistentBackupSnapshot(client),
    "00000003-0000002A-1",
  );
  assert.deepEqual(queries, [
    "BEGIN ISOLATION LEVEL REPEATABLE READ",
    "LOCK TABLE take_recording, riff_track IN SHARE MODE",
    "SELECT pg_export_snapshot() AS snapshot",
  ]);
});

test("backup fails closed when PostgreSQL does not export a snapshot", async () => {
  const client = {
    async query(sql) {
      return sql.includes("pg_export_snapshot") ? { rows: [] } : { rows: [] };
    },
  };

  await assert.rejects(
    beginConsistentBackupSnapshot(client),
    /Could not create a consistent database snapshot/,
  );
});

test("backup acquires its generation lease before the authoritative restore check", async () => {
  const events = [];
  const lease = {
    async release() {
      events.push("release");
    },
  };

  const acquired = await acquireBackupGenerationLease({
    root: "/isolated-test-root",
    parentToken: "restore-parent-token",
    acquireLock: async (kind, options) => {
      events.push(`acquire:${kind}:${options.root}:${options.parentToken}`);
      return lease;
    },
    assertRestoreState: async (root) => {
      events.push(`assert:${root}`);
    },
  });

  assert.equal(acquired, lease);
  assert.deepEqual(events, [
    "acquire:backup:/isolated-test-root:restore-parent-token",
    "assert:/isolated-test-root",
  ]);
  await acquired.release();
  assert.equal(events.at(-1), "release");
});

test("backup releases a replacement lease when a stale restore left an artifact", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "riff-backup-generation-"));
  try {
    const storage = path.join(root, "storage");
    const leaseDirectory = path.join(storage, ".operation-lock", "leases");
    await mkdir(leaseDirectory, { recursive: true, mode: 0o700 });
    await chmod(storage, 0o700);
    await chmod(path.join(storage, ".operation-lock"), 0o700);
    await chmod(leaseDirectory, 0o700);

    const staleToken = randomUUID();
    await writeFile(
      path.join(leaseDirectory, `restore-${staleToken}.json`),
      `${JSON.stringify({
        version: 1,
        token: staleToken,
        kind: "restore",
        nested: false,
        pid: process.pid,
        processStart: "Thu Jan  1 00:00:00 1970",
        createdAt: new Date().toISOString(),
      })}\n`,
      { mode: 0o600 },
    );
    await mkdir(path.join(storage, ".restore-incoming-crashed"));

    await assert.rejects(
      acquireBackupGenerationLease({ root }),
      /완전히 끝나지 않은 복원 흔적/,
    );
    assert.deepEqual(await readdir(leaseDirectory), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
