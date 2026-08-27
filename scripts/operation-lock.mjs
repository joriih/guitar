import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const LOCK_DIRECTORY_NAME = ".operation-lock";
const LEASE_DIRECTORY_NAME = "leases";
const GUARD_DIRECTORY_NAME = ".guard";
const OWNER_FILE_NAME = "owner.json";
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const GUARD_RETRY_COUNT = 500;
const GUARD_RETRY_MIN_MS = 8;
const UNOWNED_GUARD_GRACE_MS = 2_000;
const KINDS = new Set(["runtime", "backup", "doctor", "restore"]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LEASE_FILE_PATTERN =
  /^(runtime|backup|doctor|restore)-([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/;

let ownProcessStartPromise;

export class OperationLockConflictError extends Error {
  constructor(kind, activeKinds = [], message) {
    const kinds = [...new Set(activeKinds)].sort();
    super(
      message ??
        `${kind} 작업을 시작할 수 없어요. 충돌하는 작업이 이미 실행 중이에요${
          kinds.length ? ` (${kinds.join(", ")})` : ""
        }.`,
    );
    this.name = "OperationLockConflictError";
    this.code = "OPERATION_LOCK_CONFLICT";
    this.kind = kind;
    this.activeKinds = kinds;
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function lstatOrNull(filePath) {
  return lstat(filePath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
}

function assertSafeDirectory(directoryStat, label) {
  if (!directoryStat?.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error(`${label} 경로가 안전한 로컬 폴더가 아니에요.`);
  }
}

async function ensureParentDirectory(directoryPath) {
  await mkdir(directoryPath, { recursive: true, mode: DIRECTORY_MODE });
  assertSafeDirectory(await lstatOrNull(directoryPath), directoryPath);
}

async function ensurePrivateDirectory(directoryPath) {
  await mkdir(directoryPath, { recursive: true, mode: DIRECTORY_MODE });
  assertSafeDirectory(await lstatOrNull(directoryPath), directoryPath);
  await chmod(directoryPath, DIRECTORY_MODE);
}

function resolveLockPaths(root) {
  if (root !== undefined && (typeof root !== "string" || root.length === 0)) {
    throw new TypeError("operation lock root는 비어 있지 않은 문자열이어야 해요.");
  }
  const projectRoot = path.resolve(root ?? process.cwd());
  const storageDirectory = path.join(projectRoot, "storage");
  const lockDirectory = path.join(storageDirectory, LOCK_DIRECTORY_NAME);
  return {
    storageDirectory,
    lockDirectory,
    leaseDirectory: path.join(lockDirectory, LEASE_DIRECTORY_NAME),
    guardDirectory: path.join(lockDirectory, GUARD_DIRECTORY_NAME),
    guardOwnerPath: path.join(lockDirectory, GUARD_DIRECTORY_NAME, OWNER_FILE_NAME),
  };
}

async function ensureLockDirectories(paths) {
  await ensureParentDirectory(paths.storageDirectory);
  await ensurePrivateDirectory(paths.lockDirectory);
  await ensurePrivateDirectory(paths.leaseDirectory);
}

async function processStartSignature(pid, { required = false } = {}) {
  try {
    const { stdout } = await execFileAsync(
      "/bin/ps",
      ["-p", String(pid), "-o", "lstart="],
      { encoding: "utf8", maxBuffer: 4_096 },
    );
    const signature = stdout.trim();
    if (signature) return signature;
    if (required) throw new Error("현재 프로세스의 시작 시각을 확인할 수 없어요.");
    return null;
  } catch (error) {
    if (error?.code === 1 || error?.code === "1") return null;
    if (required) {
      throw new Error("현재 프로세스의 시작 시각을 확인할 수 없어요.", {
        cause: error,
      });
    }
    // A transient ps failure must never make a live operation look stale.
    return undefined;
  }
}

function ownProcessStart() {
  ownProcessStartPromise ??= processStartSignature(process.pid, { required: true });
  return ownProcessStartPromise;
}

function isCanonicalUuid(value) {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function parseJsonObject(source) {
  try {
    const value = JSON.parse(source);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function validOwner(value) {
  return Boolean(
    value &&
      value.version === 1 &&
      isCanonicalUuid(value.token) &&
      Number.isSafeInteger(value.pid) &&
      value.pid > 0 &&
      typeof value.processStart === "string" &&
      value.processStart.length > 0 &&
      typeof value.createdAt === "string" &&
      Number.isFinite(Date.parse(value.createdAt)),
  );
}

function validLease(value, filenameKind, filenameToken) {
  return Boolean(
    validOwner(value) &&
      value.kind === filenameKind &&
      value.token === filenameToken &&
      value.nested === false,
  );
}

async function ownerIsLive(owner) {
  const signature = await processStartSignature(owner.pid);
  // Undefined means ps itself could not be trusted. Retain the lease/guard safely.
  return signature === undefined || signature === owner.processStart;
}

async function writePrivateJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
    mode: FILE_MODE,
  });
  await chmod(filePath, FILE_MODE);
}

async function inspectGuardDirectory(guardDirectory) {
  const directoryStat = await lstatOrNull(guardDirectory);
  if (!directoryStat) return { status: "missing" };
  assertSafeDirectory(directoryStat, "operation lock guard");

  const ownerPath = path.join(guardDirectory, OWNER_FILE_NAME);
  const ownerStat = await lstatOrNull(ownerPath);
  if (!ownerStat) {
    return { status: "unowned", directoryStat };
  }
  if (!ownerStat.isFile() || ownerStat.isSymbolicLink()) {
    throw new Error("operation lock guard의 소유자 파일이 안전하지 않아요.");
  }
  const owner = parseJsonObject(await readFile(ownerPath, "utf8"));
  if (!validOwner(owner)) {
    return { status: "unowned", directoryStat };
  }
  return { status: "owned", directoryStat, owner };
}

function sameGuardObservation(left, right) {
  if (left.status !== right.status) return false;
  if (left.status === "owned") {
    return (
      left.owner.token === right.owner.token &&
      left.owner.pid === right.owner.pid &&
      left.owner.processStart === right.owner.processStart
    );
  }
  if (left.status === "unowned") {
    return (
      left.directoryStat.ino === right.directoryStat.ino &&
      left.directoryStat.birthtimeMs === right.directoryStat.birthtimeMs
    );
  }
  return left.status === "missing";
}

function sameDirectoryIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.birthtimeMs === right.birthtimeMs
  );
}

async function removeStaleGuard(paths, observed) {
  const current = await inspectGuardDirectory(paths.guardDirectory);
  if (!sameGuardObservation(observed, current)) return false;
  if (current.status === "owned" && (await ownerIsLive(current.owner))) return false;
  if (
    current.status === "unowned" &&
    Date.now() - current.directoryStat.mtimeMs < UNOWNED_GUARD_GRACE_MS
  ) {
    return false;
  }

  const suffix = current.status === "owned" ? current.owner.token : "unowned";
  const quarantine = path.join(paths.lockDirectory, `.stale-guard-${suffix}`);
  const existingQuarantine = await lstatOrNull(quarantine);
  if (existingQuarantine) {
    assertSafeDirectory(existingQuarantine, "operation lock stale guard");
    const quarantined = await inspectGuardDirectory(quarantine);
    const removable =
      (quarantined.status === "owned" && !(await ownerIsLive(quarantined.owner))) ||
      (quarantined.status === "unowned" &&
        Date.now() - quarantined.directoryStat.mtimeMs >= UNOWNED_GUARD_GRACE_MS);
    if (!removable) return false;
    await rm(quarantine, { recursive: true });
  }

  // Rename first so a concurrent cleaner cannot delete a newly-created guard.
  try {
    await rename(paths.guardDirectory, quarantine);
  } catch (error) {
    if (["ENOENT", "EEXIST", "ENOTEMPTY"].includes(error?.code)) return false;
    throw error;
  }

  const moved = await inspectGuardDirectory(quarantine);
  if (!sameGuardObservation(current, moved)) {
    await rename(quarantine, paths.guardDirectory).catch(() => undefined);
    return false;
  }
  await rm(quarantine, { recursive: true });
  return true;
}

async function acquireGuard(paths, requestedKind) {
  const owner = {
    version: 1,
    token: randomUUID(),
    pid: process.pid,
    processStart: await ownProcessStart(),
    createdAt: new Date().toISOString(),
  };

  for (let attempt = 0; attempt < GUARD_RETRY_COUNT; attempt += 1) {
    try {
      await mkdir(paths.guardDirectory, { mode: DIRECTORY_MODE });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const observed = await inspectGuardDirectory(paths.guardDirectory);
      if (observed.status === "owned") {
        if (!(await ownerIsLive(observed.owner))) {
          await removeStaleGuard(paths, observed);
        }
      } else if (observed.status === "unowned") {
        await removeStaleGuard(paths, observed);
      }
      await delay(GUARD_RETRY_MIN_MS + Math.floor(Math.random() * 8));
      continue;
    }

    const directoryStat = await lstatOrNull(paths.guardDirectory);
    assertSafeDirectory(directoryStat, "operation lock guard");
    const guard = { owner, directoryStat };

    try {
      await chmod(paths.guardDirectory, DIRECTORY_MODE);
      await writePrivateJson(paths.guardOwnerPath, owner);
      return guard;
    } catch (error) {
      // The directory may have been quarantined as an unowned stale guard and
      // replaced while this claimant was paused. Only remove a guard that still
      // has both this directory identity and this claimant's owner token.
      await releaseGuard(paths, guard).catch(() => undefined);
      throw error;
    }
  }

  throw new OperationLockConflictError(
    requestedKind,
    ["guard"],
    "다른 작업이 operation lock 상태를 확인 중이라 시작하지 못했어요. 잠시 후 다시 시도해주세요.",
  );
}

async function releaseGuard(paths, guard) {
  const current = await inspectGuardDirectory(paths.guardDirectory);
  if (
    current.status !== "owned" ||
    !sameDirectoryIdentity(current.directoryStat, guard.directoryStat) ||
    current.owner.token !== guard.owner.token ||
    current.owner.pid !== guard.owner.pid ||
    current.owner.processStart !== guard.owner.processStart
  ) {
    throw new Error("operation lock guard 소유권이 바뀌어 안전하게 해제할 수 없어요.");
  }
  await rm(paths.guardDirectory, { recursive: true });
}

async function readActiveLeases(paths) {
  const entries = await readdir(paths.leaseDirectory, { withFileTypes: true });
  const active = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const match = LEASE_FILE_PATTERN.exec(entry.name);
    if (!match || !entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`안전하지 않은 operation lock 항목이 있어요: ${entry.name}`);
    }
    const [, filenameKind, filenameToken] = match;
    const leasePath = path.join(paths.leaseDirectory, entry.name);
    const leaseStat = await lstatOrNull(leasePath);
    if (!leaseStat?.isFile() || leaseStat.isSymbolicLink()) {
      throw new Error(`안전하지 않은 operation lock lease가 있어요: ${entry.name}`);
    }
    const lease = parseJsonObject(await readFile(leasePath, "utf8"));
    if (!validLease(lease, filenameKind, filenameToken)) {
      throw new Error(`손상된 operation lock lease가 있어요: ${entry.name}`);
    }
    if (await ownerIsLive(lease)) {
      active.push({ ...lease, leasePath });
    } else {
      await unlink(leasePath);
    }
  }
  return active;
}

function conflictsWith(kind, activeLease) {
  if (kind === "restore") return true;
  // A doctor inspection compares one database generation with the matching
  // filesystem generation. It therefore needs the project completely still.
  if (kind === "doctor") return true;
  if (kind === "runtime") {
    return (
      activeLease.kind === "runtime" ||
      activeLease.kind === "doctor" ||
      activeLease.kind === "restore"
    );
  }
  return activeLease.kind === "doctor" || activeLease.kind === "restore";
}

function nestedLease(kind, parentToken) {
  let released = false;
  return {
    token: parentToken,
    kind,
    nested: true,
    async release() {
      released = true;
      return released;
    },
  };
}

function physicalLease(kind, token, paths, processStart) {
  const leasePath = path.join(paths.leaseDirectory, `${kind}-${token}.json`);
  let released = false;
  return {
    token,
    kind,
    nested: false,
    async release() {
      if (released) return;
      const guard = await acquireGuard(paths, kind);
      try {
        const fileStat = await lstatOrNull(leasePath);
        if (!fileStat) {
          released = true;
          return;
        }
        if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
          throw new Error("operation lock lease가 안전하지 않아 해제하지 않았어요.");
        }
        const current = parseJsonObject(await readFile(leasePath, "utf8"));
        if (
          !validLease(current, kind, token) ||
          current.pid !== process.pid ||
          current.processStart !== processStart
        ) {
          throw new Error("operation lock lease 소유권이 바뀌어 해제하지 않았어요.");
        }
        await unlink(leasePath);
        released = true;
      } finally {
        await releaseGuard(paths, guard);
      }
    },
  };
}

export async function acquireOperationLock(kind, options = {}) {
  if (!KINDS.has(kind)) {
    throw new TypeError(`지원하지 않는 operation lock 종류예요: ${String(kind)}`);
  }
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("operation lock 옵션이 올바르지 않아요.");
  }
  for (const key of Object.keys(options)) {
    if (key !== "root" && key !== "parentToken") {
      throw new TypeError(`지원하지 않는 operation lock 옵션이에요: ${key}`);
    }
  }
  const parentToken = options.parentToken;
  if (parentToken !== undefined && kind !== "backup" && kind !== "runtime") {
    throw new TypeError(
      "parentToken은 중첩 백업과 중첩 앱 실행에만 사용할 수 있어요.",
    );
  }

  const paths = resolveLockPaths(options.root);
  await ensureLockDirectories(paths);
  const guard = await acquireGuard(paths, kind);
  try {
    const active = await readActiveLeases(paths);
    if (parentToken !== undefined) {
      const parentKind = kind === "runtime" ? "runtime" : "restore";
      const parent = isCanonicalUuid(parentToken)
        ? active.find(
            (lease) => lease.kind === parentKind && lease.token === parentToken,
          )
        : undefined;
      if (!parent) {
        throw new OperationLockConflictError(
          kind,
          active.map((lease) => lease.kind),
          kind === "runtime"
            ? "중첩 앱 실행의 공유 작업 토큰을 확인할 수 없어요."
            : "중첩 백업의 복원 작업 토큰을 확인할 수 없어요.",
        );
      }
      return nestedLease(kind, parentToken);
    }

    const conflicts = active.filter((lease) => conflictsWith(kind, lease));
    if (conflicts.length > 0) {
      throw new OperationLockConflictError(
        kind,
        conflicts.map((lease) => lease.kind),
      );
    }

    const token = randomUUID();
    const processStart = await ownProcessStart();
    const leasePath = path.join(paths.leaseDirectory, `${kind}-${token}.json`);
    await writePrivateJson(leasePath, {
      version: 1,
      token,
      kind,
      nested: false,
      pid: process.pid,
      processStart,
      createdAt: new Date().toISOString(),
    });
    return physicalLease(kind, token, paths, processStart);
  } finally {
    await releaseGuard(paths, guard);
  }
}
