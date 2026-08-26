import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertNoIncompleteRestoreState,
  clearRestoreJournal,
  listIncompleteRestoreArtifacts,
  RESTORE_JOURNAL_NAME,
  writeRestoreJournal,
} from "./restore-state.mjs";

const roots = new Set();

async function testRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "riff-restore-state-"));
  roots.add(root);
  return root;
}

function permissionBits(fileStat) {
  return fileStat.mode & 0o777;
}

test.after(async () => {
  await Promise.all(
    [...roots].map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("a durable private journal is updated atomically and cleared explicitly", async () => {
  const root = await testRoot();
  const initial = {
    version: 1,
    operationToken: randomUUID(),
    phase: "prepared",
  };
  await writeRestoreJournal(initial, { root, initial: true });

  const storage = path.join(root, "storage");
  const journalPath = path.join(storage, RESTORE_JOURNAL_NAME);
  assert.equal(permissionBits(await lstat(storage)), 0o700);
  assert.equal(permissionBits(await lstat(journalPath)), 0o600);
  assert.deepEqual(JSON.parse(await readFile(journalPath, "utf8")), initial);
  await assert.rejects(writeRestoreJournal(initial, { root, initial: true }));

  const updated = { ...initial, phase: "database-restored" };
  await writeRestoreJournal(updated, { root });
  assert.deepEqual(JSON.parse(await readFile(journalPath, "utf8")), updated);
  assert.deepEqual(await listIncompleteRestoreArtifacts(root), [RESTORE_JOURNAL_NAME]);
  await assert.rejects(assertNoIncompleteRestoreState(root));

  await clearRestoreJournal({ root });
  await assertNoIncompleteRestoreState(root);
});

test("every crash-sensitive restore directory makes Start and Backup fail closed", async () => {
  const root = await testRoot();
  const storage = path.join(root, "storage");
  await mkdir(storage, { recursive: true });
  const artifacts = [
    ".restore-incoming-test",
    ".restore-work-test",
    ".restore-previous-test",
    ".restore-failed-test",
    ".restore-journal.test.tmp",
  ];
  for (const name of artifacts) {
    await mkdir(path.join(storage, name));
  }

  assert.deepEqual(await listIncompleteRestoreArtifacts(root), [...artifacts].sort());
  await assert.rejects(
    assertNoIncompleteRestoreState(root),
    /완전히 끝나지 않은 복원 흔적/,
  );
});

