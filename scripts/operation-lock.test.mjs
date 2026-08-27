import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fileSystemPromises, {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  acquireOperationLock,
  OperationLockConflictError,
} from "./operation-lock.mjs";

const roots = new Set();

async function testRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "riff-operation-lock-"));
  roots.add(root);
  return root;
}

function lockPaths(root) {
  const lockDirectory = path.join(root, "storage", ".operation-lock");
  return {
    lockDirectory,
    leaseDirectory: path.join(lockDirectory, "leases"),
    guardDirectory: path.join(lockDirectory, ".guard"),
  };
}

function permissionBits(fileStat) {
  return fileStat.mode & 0o777;
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function assertConflict(promise, kind, activeKinds) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof OperationLockConflictError);
    assert.equal(error.code, "OPERATION_LOCK_CONFLICT");
    assert.equal(error.kind, kind);
    assert.deepEqual(error.activeKinds, [...activeKinds].sort());
    return true;
  });
}

test.after(async () => {
  await Promise.all(
    [...roots].map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("runtime and backups use private leases with the intended coexistence rules", async () => {
  const root = await testRoot();
  const runtime = await acquireOperationLock("runtime", { root });
  const [firstBackup, secondBackup] = await Promise.all([
    acquireOperationLock("backup", { root }),
    acquireOperationLock("backup", { root }),
  ]);

  assert.equal(runtime.nested, false);
  assert.equal(firstBackup.nested, false);
  assert.equal(secondBackup.nested, false);
  assert.notEqual(firstBackup.token, secondBackup.token);
  await assertConflict(acquireOperationLock("runtime", { root }), "runtime", [
    "runtime",
  ]);
  await assertConflict(acquireOperationLock("restore", { root }), "restore", [
    "backup",
    "runtime",
  ]);

  const paths = lockPaths(root);
  assert.equal(permissionBits(await lstat(paths.lockDirectory)), 0o700);
  assert.equal(permissionBits(await lstat(paths.leaseDirectory)), 0o700);
  const leaseFiles = await readdir(paths.leaseDirectory);
  assert.equal(leaseFiles.length, 3);
  for (const filename of leaseFiles) {
    const filePath = path.join(paths.leaseDirectory, filename);
    assert.equal(permissionBits(await lstat(filePath)), 0o600);
    const value = JSON.parse(await readFile(filePath, "utf8"));
    assert.equal(value.pid, process.pid);
    assert.equal(typeof value.processStart, "string");
    assert.ok(value.processStart.length > 0);
  }

  await Promise.all([firstBackup.release(), secondBackup.release()]);
  await runtime.release();
  assert.deepEqual(await readdir(paths.leaseDirectory), []);
});

test("restore excludes every physical operation and release is idempotent", async () => {
  const root = await testRoot();
  const backup = await acquireOperationLock("backup", { root });
  await assertConflict(acquireOperationLock("restore", { root }), "restore", [
    "backup",
  ]);
  await backup.release();
  await backup.release();

  const restore = await acquireOperationLock("restore", { root });
  await assertConflict(acquireOperationLock("runtime", { root }), "runtime", [
    "restore",
  ]);
  await assertConflict(acquireOperationLock("backup", { root }), "backup", [
    "restore",
  ]);
  await assertConflict(acquireOperationLock("restore", { root }), "restore", [
    "restore",
  ]);
  await restore.release();

  const runtime = await acquireOperationLock("runtime", { root });
  await runtime.release();
});

test("doctor inspection excludes every changing operation in both directions", async () => {
  const root = await testRoot();
  const doctor = await acquireOperationLock("doctor", { root });
  await assertConflict(acquireOperationLock("runtime", { root }), "runtime", [
    "doctor",
  ]);
  await assertConflict(acquireOperationLock("backup", { root }), "backup", [
    "doctor",
  ]);
  await assertConflict(acquireOperationLock("restore", { root }), "restore", [
    "doctor",
  ]);
  await assertConflict(acquireOperationLock("doctor", { root }), "doctor", [
    "doctor",
  ]);
  await doctor.release();

  for (const activeKind of ["runtime", "backup", "restore"]) {
    const active = await acquireOperationLock(activeKind, { root });
    await assertConflict(acquireOperationLock("doctor", { root }), "doctor", [
      activeKind,
    ]);
    await active.release();
  }
});

test("stale leases and guards require both PID and process-start signature", async () => {
  const root = await testRoot();
  const paths = lockPaths(root);
  await mkdir(paths.leaseDirectory, { recursive: true, mode: 0o700 });
  await chmod(paths.lockDirectory, 0o700);
  await chmod(paths.leaseDirectory, 0o700);

  const staleLeaseToken = randomUUID();
  await writeFile(
    path.join(paths.leaseDirectory, `runtime-${staleLeaseToken}.json`),
    `${JSON.stringify({
      version: 1,
      token: staleLeaseToken,
      kind: "runtime",
      nested: false,
      pid: process.pid,
      processStart: "Thu Jan  1 00:00:00 1970",
      createdAt: new Date().toISOString(),
    })}\n`,
    { mode: 0o600 },
  );

  const staleGuardToken = randomUUID();
  await mkdir(paths.guardDirectory, { mode: 0o700 });
  await writeFile(
    path.join(paths.guardDirectory, "owner.json"),
    `${JSON.stringify({
      version: 1,
      token: staleGuardToken,
      pid: process.pid,
      processStart: "Thu Jan  1 00:00:00 1970",
      createdAt: new Date().toISOString(),
    })}\n`,
    { mode: 0o600 },
  );

  const runtime = await acquireOperationLock("runtime", { root });
  const filenames = await readdir(paths.leaseDirectory);
  assert.equal(filenames.length, 1);
  assert.equal(filenames[0], `runtime-${runtime.token}.json`);
  assert.equal(await lstat(paths.guardDirectory).catch(() => null), null);
  await runtime.release();
});

test("a failed guard claimant never removes a replacement guard", async () => {
  const root = await testRoot();
  const paths = lockPaths(root);
  const ownerPath = path.join(paths.guardDirectory, "owner.json");
  const firstGuardMarkerPath = path.join(
    paths.guardDirectory,
    "first-claimant-marker",
  );
  const firstGuardPaused = deferred();
  const resumeFirstGuard = deferred();
  const replacementOwnerPaused = deferred();
  const resumeReplacementOwner = deferred();
  const originalChmod = fileSystemPromises.chmod;
  const originalWriteFile = fileSystemPromises.writeFile;
  let pauseFirstGuard = true;
  let pauseReplacementOwner = true;
  let firstAcquisition;
  let replacementAcquisition;

  fileSystemPromises.chmod = async (...argumentsList) => {
    const result = await originalChmod(...argumentsList);
    if (
      pauseFirstGuard &&
      path.resolve(argumentsList[0]) === paths.guardDirectory
    ) {
      pauseFirstGuard = false;
      firstGuardPaused.resolve();
      await resumeFirstGuard.promise;
    }
    return result;
  };
  fileSystemPromises.writeFile = async (...argumentsList) => {
    const result = await originalWriteFile(...argumentsList);
    if (
      pauseReplacementOwner &&
      path.resolve(argumentsList[0]) === ownerPath
    ) {
      pauseReplacementOwner = false;
      replacementOwnerPaused.resolve();
      await resumeReplacementOwner.promise;
    }
    return result;
  };
  syncBuiltinESMExports();

  try {
    firstAcquisition = acquireOperationLock("runtime", { root });
    await firstGuardPaused.promise;
    await writeFile(firstGuardMarkerPath, "first claimant\n", { mode: 0o600 });
    const staleTime = new Date(Date.now() - 10_000);
    await utimes(paths.guardDirectory, staleTime, staleTime);

    replacementAcquisition = acquireOperationLock("backup", { root });
    await replacementOwnerPaused.promise;
    const replacementGuardStat = await lstat(paths.guardDirectory);
    const replacementOwner = JSON.parse(await readFile(ownerPath, "utf8"));
    assert.equal(
      await lstat(firstGuardMarkerPath).catch((error) => {
        if (error?.code === "ENOENT") return null;
        throw error;
      }),
      null,
    );

    resumeFirstGuard.resolve();
    await assert.rejects(firstAcquisition, { code: "EEXIST" });

    const currentGuardStat = await lstat(paths.guardDirectory);
    const currentOwner = JSON.parse(await readFile(ownerPath, "utf8"));
    assert.equal(currentGuardStat.dev, replacementGuardStat.dev);
    assert.equal(currentGuardStat.ino, replacementGuardStat.ino);
    assert.equal(currentOwner.token, replacementOwner.token);

    resumeReplacementOwner.resolve();
    const replacement = await replacementAcquisition;
    await replacement.release();
  } finally {
    resumeFirstGuard.resolve();
    resumeReplacementOwner.resolve();
    fileSystemPromises.chmod = originalChmod;
    fileSystemPromises.writeFile = originalWriteFile;
    syncBuiltinESMExports();

    const acquisitions = [firstAcquisition, replacementAcquisition].filter(
      Boolean,
    );
    const results = await Promise.allSettled(acquisitions);
    await Promise.all(
      results
        .filter((result) => result.status === "fulfilled")
        .map((result) => result.value.release()),
    );
  }
});

test("a restore token authorizes only a no-op nested backup lease", async () => {
  const root = await testRoot();
  const restore = await acquireOperationLock("restore", { root });
  await assertConflict(
    acquireOperationLock("backup", { root, parentToken: randomUUID() }),
    "backup",
    ["restore"],
  );

  const nested = await acquireOperationLock("backup", {
    root,
    parentToken: restore.token,
  });
  assert.equal(nested.kind, "backup");
  assert.equal(nested.nested, true);
  assert.equal(nested.token, restore.token);
  assert.equal((await readdir(lockPaths(root).leaseDirectory)).length, 1);
  await nested.release();
  await nested.release();
  assert.equal((await readdir(lockPaths(root).leaseDirectory)).length, 1);

  await restore.release();
  await assertConflict(
    acquireOperationLock("backup", { root, parentToken: restore.token }),
    "backup",
    [],
  );
});

test("a runtime token authorizes only a no-op nested runtime lease", async () => {
  const root = await testRoot();
  const runtime = await acquireOperationLock("runtime", { root });
  await assertConflict(
    acquireOperationLock("runtime", { root, parentToken: randomUUID() }),
    "runtime",
    ["runtime"],
  );

  const nested = await acquireOperationLock("runtime", {
    root,
    parentToken: runtime.token,
  });
  assert.equal(nested.kind, "runtime");
  assert.equal(nested.nested, true);
  assert.equal(nested.token, runtime.token);
  assert.equal((await readdir(lockPaths(root).leaseDirectory)).length, 1);
  await nested.release();
  await nested.release();
  assert.equal((await readdir(lockPaths(root).leaseDirectory)).length, 1);

  await runtime.release();
  await assertConflict(
    acquireOperationLock("runtime", { root, parentToken: runtime.token }),
    "runtime",
    [],
  );
});

test("unsupported kinds and options are rejected before creating lock state", async () => {
  const root = await testRoot();
  await assert.rejects(
    acquireOperationLock("vacuum", { root }),
    (error) => error instanceof TypeError,
  );
  await assert.rejects(
    acquireOperationLock("restore", { root, parentToken: randomUUID() }),
    (error) => error instanceof TypeError,
  );
  await assert.rejects(
    acquireOperationLock("backup", { root, arbitraryPath: "/tmp/elsewhere" }),
    (error) => error instanceof TypeError,
  );
  assert.equal(await lstat(path.join(root, "storage")).catch(() => null), null);
});
