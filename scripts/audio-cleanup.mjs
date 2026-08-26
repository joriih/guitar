import fs from "node:fs";
import { lstat, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { Client } from "pg";

import { assertLoopbackDatabaseUrl } from "./local-database-url.mjs";
import { acquireOperationLock } from "./operation-lock.mjs";
import { assertNoIncompleteRestoreState } from "./restore-state.mjs";

const APP_ROLE = "riff_sketchbook_app";
const MAIN_DATABASE = "riff_sketchbook";
const ISOLATED_NAMESPACE_PATTERN =
  /^riff_sketchbook_e2e_[1-9][0-9]*_[a-f0-9]{10}$/;
const STORED_FILE_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.(webm|ogg|wav|aiff|mp3|m4a|aac|flac|opus)$/i;
const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

function loadLocalEnv(root = process.cwd()) {
  const envPath = path.join(root, ".env.local");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

function storageDirectories(root, namespace) {
  const storageRoot = path.join(root, "storage");
  if (namespace) {
    return [
      storageRoot,
      path.join(storageRoot, "e2e"),
      path.join(storageRoot, "e2e", namespace),
    ];
  }
  return [storageRoot, path.join(storageRoot, "audio")];
}

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

function safeErrorCode(error) {
  const code = error && typeof error === "object" ? error.code : null;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,62}$/.test(code)
    ? code
    : "AUDIO_CLEANUP_IO_ERROR";
}

async function lstatOrNull(filePath) {
  return lstat(filePath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
}

export async function safeRemoveStoredAudioFile({
  root = process.cwd(),
  namespace = null,
  storagePath,
}) {
  if (typeof storagePath !== "string" || !STORED_FILE_PATTERN.test(storagePath)) {
    throw codedError("INVALID_AUDIO_STORAGE_PATH", "Invalid queued audio path.");
  }
  if (namespace !== null && !ISOLATED_NAMESPACE_PATTERN.test(namespace)) {
    throw codedError("INVALID_AUDIO_NAMESPACE", "Invalid audio namespace.");
  }

  const directories = storageDirectories(path.resolve(root), namespace);
  for (const directory of directories) {
    const directoryStat = await lstatOrNull(directory);
    if (!directoryStat) return "missing";
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw codedError(
        "UNSAFE_STORAGE_DIRECTORY",
        "Audio cleanup storage directory is unsafe.",
      );
    }
  }

  const target = path.join(directories.at(-1), storagePath);
  const targetStat = await lstatOrNull(target);
  if (!targetStat) return "missing";
  if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
    throw codedError(
      "UNSAFE_AUDIO_TARGET",
      "Audio cleanup target is not a safe regular file.",
    );
  }
  try {
    await unlink(target);
    return "removed";
  } catch (error) {
    if (error?.code === "ENOENT") return "missing";
    throw error;
  }
}

async function queueFailure(client, storagePath, error) {
  const code = safeErrorCode(error);
  await client
    .query(
      `UPDATE audio_cleanup_queue
          SET attempts = attempts + 1,
              last_error = $2
        WHERE storage_path = $1`,
      [storagePath, code],
    )
    .catch(() => undefined);
  console.error(`오디오 파일 정리를 다음 실행으로 미뤘어요. 오류 코드: ${code}`);
}

export async function drainAudioCleanup({
  client,
  root = process.cwd(),
  namespace = null,
  limit = 10_000,
  removeFile = safeRemoveStoredAudioFile,
}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
    throw new TypeError("Audio cleanup limit must be between 1 and 10000.");
  }
  const queued = await client.query(
    `SELECT storage_path
       FROM audio_cleanup_queue
      ORDER BY queued_at, storage_path
      LIMIT $1`,
    [limit],
  );
  let cleared = 0;
  let pending = 0;
  for (const row of queued.rows) {
    const storagePath = String(row.storage_path);
    try {
      if (!STORED_FILE_PATTERN.test(storagePath)) {
        throw codedError("INVALID_AUDIO_STORAGE_PATH", "Invalid queued audio path.");
      }
      const reference = await client.query(
        `SELECT EXISTS (
           SELECT 1 FROM take_recording WHERE storage_path = $1
           UNION ALL
           SELECT 1 FROM riff_track WHERE storage_path = $1
         ) AS referenced`,
        [storagePath],
      );
      if (!reference.rows[0]?.referenced) {
        await removeFile({ root, namespace, storagePath });
      }
      await client.query(
        "DELETE FROM audio_cleanup_queue WHERE storage_path = $1",
        [storagePath],
      );
      cleared += 1;
    } catch (error) {
      pending += 1;
      await queueFailure(client, storagePath, error);
    }
  }
  return { processed: queued.rows.length, cleared, pending };
}

async function assertRuntimeParentLease(root, token) {
  if (!UUID_PATTERN.test(token)) {
    throw new Error("오디오 정리 parent token이 올바르지 않아요.");
  }
  const leasePath = path.join(
    root,
    "storage",
    ".operation-lock",
    "leases",
    `runtime-${token}.json`,
  );
  const leaseStat = await lstatOrNull(leasePath);
  if (!leaseStat?.isFile() || leaseStat.isSymbolicLink()) {
    throw new Error("실행 중인 앱의 operation lock을 확인할 수 없어요.");
  }
  const lease = JSON.parse(await readFile(leasePath, "utf8"));
  if (lease?.kind !== "runtime" || lease?.token !== token || lease?.nested !== false) {
    throw new Error("실행 중인 앱의 operation lock 내용이 올바르지 않아요.");
  }
}

async function main() {
  const root = process.cwd();
  loadLocalEnv(root);
  const databaseUrl = assertLoopbackDatabaseUrl(
    process.env.DATABASE_URL ??
      `postgresql://${APP_ROLE}@127.0.0.1:5432/${MAIN_DATABASE}`,
  );
  const databaseName = databaseUrl.pathname.slice(1);
  const databaseUser = decodeURIComponent(databaseUrl.username);
  const namespace = process.env.AUDIO_STORAGE_NAMESPACE ?? null;
  const isolated =
    namespace !== null &&
    ISOLATED_NAMESPACE_PATTERN.test(namespace) &&
    namespace === databaseName;
  const mainStorage = databaseName === MAIN_DATABASE && namespace === null;
  if (
    databaseUser !== APP_ROLE ||
    (!mainStorage && !isolated)
  ) {
    throw new Error("Riff Sketchbook 전용 로컬 데이터베이스만 정리할 수 있어요.");
  }

  await assertNoIncompleteRestoreState(root);
  let operationLock = null;
  const parentToken = process.env.RIFF_AUDIO_CLEANUP_PARENT_TOKEN;
  if (parentToken) {
    await assertRuntimeParentLease(root, parentToken);
  } else if (!(isolated && process.env.RIFF_E2E_AUDIO_CLEANUP === "1")) {
    operationLock = await acquireOperationLock("runtime", { root });
  }

  const client = new Client({ connectionString: databaseUrl.toString() });
  try {
    await client.connect();
    const summary = await drainAudioCleanup({ client, root, namespace });
    if (summary.processed) {
      console.log(
        `대기 중인 오디오 정리 ${summary.processed}건을 확인했어요. 완료 ${summary.cleared}건 · 다음 실행 재시도 ${summary.pending}건`,
      );
    }
  } finally {
    await client.end().catch(() => undefined);
    await operationLock?.release();
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "대기 중인 오디오를 정리하지 못했어요.",
    );
    process.exitCode = 1;
  }
}
