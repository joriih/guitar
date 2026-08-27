import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  chmod,
  mkdir,
  mkdtemp,
  lstat,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

import {
  assertLoopbackDatabaseUrl,
  normalizedDatabaseHostname,
} from "./local-database-url.mjs";
import { operationChildInvocation } from "./operation-child-invocation.mjs";
import { acquireOperationLock } from "./operation-lock.mjs";
import { assertNoIncompleteRestoreState } from "./restore-state.mjs";
import { isRestorableAudioStoragePath } from "./restore-validation.mjs";

let activeChild = null;
let interruptedSignal = null;

export const SESSION_BEARING_BACKUP_EXCLUSIONS = Object.freeze([
  "--exclude-table-data=public.app_session",
  "--exclude-table-data=public.password_change_request",
]);

function handleSignal(signal) {
  interruptedSignal = signal;
  activeChild?.kill(signal);
}

const onSigint = () => handleSignal("SIGINT");
const onSigterm = () => handleSignal("SIGTERM");

function throwIfInterrupted() {
  if (interruptedSignal) {
    throw new Error(`${interruptedSignal} 신호로 백업을 취소했어요.`);
  }
}

async function loadLocalEnv() {
  try {
    const source = await readFile(path.join(process.cwd(), ".env.local"), "utf8");
    for (const line of source.split(/\r?\n/)) {
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
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function backupTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}-${String(
      date.getMilliseconds(),
    ).padStart(3, "0")}`,
  ].join("_");
}

function postgresBinary(name) {
  const configured = process.env.POSTGRES_BIN;
  return configured
    ? path.join(configured, name)
    : `/Applications/Postgres.app/Contents/Versions/latest/bin/${name}`;
}

function run(command, args, env, { parentToken } = {}) {
  return new Promise((resolve, reject) => {
    const invocation = parentToken
      ? operationChildInvocation(command, args, {
          leases: [{ root: process.cwd(), token: parentToken }],
          environment: env,
        })
      : { command, args, environment: env };
    const child = spawn(invocation.command, invocation.args, {
      env: invocation.environment,
      stdio: ["ignore", "inherit", "inherit"],
    });
    activeChild = child;
    child.once("error", (error) => {
      if (activeChild === child) activeChild = null;
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (activeChild === child) activeChild = null;
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(command)} failed (${signal ?? code}).`));
    });
  });
}

async function sha256(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

export async function beginConsistentBackupSnapshot(client) {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
  // Runtime deletion commits its row removal and durable cleanup request before
  // unlinking the file. SHARE locks make that delete either fully precede this
  // snapshot or wait until every snapshotted audio file has been copied.
  await client.query("LOCK TABLE take_recording, riff_track IN SHARE MODE");
  const snapshotResult = await client.query(
    "SELECT pg_export_snapshot() AS snapshot",
  );
  const snapshot = snapshotResult.rows[0]?.snapshot;
  if (!snapshot) throw new Error("Could not create a consistent database snapshot.");
  return snapshot;
}

export async function acquireBackupGenerationLease({
  root = process.cwd(),
  parentToken,
  acquireLock = acquireOperationLock,
  assertRestoreState = assertNoIncompleteRestoreState,
} = {}) {
  const operationLock = await acquireLock("backup", {
    root,
    ...(parentToken ? { parentToken } : {}),
  });
  try {
    // The preflight check in main gives a fast explanation, but only this check
    // is authoritative: the lease prevents a restore from creating a new
    // generation between inspection and the backup snapshot.
    await assertRestoreState(root);
    return operationLock;
  } catch (error) {
    await operationLock.release();
    throw error;
  }
}

async function main() {
  await loadLocalEnv();

  const databaseUrl = assertLoopbackDatabaseUrl(
    process.env.DATABASE_URL ??
      "postgresql://riff_sketchbook_app@127.0.0.1:5432/riff_sketchbook",
  );
  const host = normalizedDatabaseHostname(databaseUrl);
  const databaseName = databaseUrl.pathname.slice(1);
  if (
    databaseName !== "riff_sketchbook" ||
    decodeURIComponent(databaseUrl.username) !== "riff_sketchbook_app"
  ) {
    throw new Error("Backup is restricted to the local riff_sketchbook database.");
  }

  await assertNoIncompleteRestoreState();
  const operationLock = await acquireBackupGenerationLease({
    ...(process.env.RIFF_OPERATION_PARENT_TOKEN
      ? { parentToken: process.env.RIFF_OPERATION_PARENT_TOKEN }
      : {}),
  });
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  try {
    throwIfInterrupted();
    await run(
      process.execPath,
      [path.join(process.cwd(), "scripts", "db-init.mjs")],
      process.env,
      { parentToken: operationLock.token },
    );
    throwIfInterrupted();

    const sourceAudioDirectory = path.join(process.cwd(), "storage", "audio");
    const sourceAudioStat = await lstat(sourceAudioDirectory).catch(() => null);
    if (!sourceAudioStat?.isDirectory() || sourceAudioStat.isSymbolicLink()) {
      throw new Error("Audio storage is missing or is not a safe local directory.");
    }
    const backupRoot = path.join(process.cwd(), "backups");
    await mkdir(backupRoot, { recursive: true, mode: 0o700 });
    await chmod(backupRoot, 0o700);
    const partialDirectory = await mkdtemp(path.join(backupRoot, ".partial-"));
    const finalDirectory = path.join(backupRoot, backupTimestamp());
    const audioDirectory = path.join(partialDirectory, "audio");
    const dumpPath = path.join(partialDirectory, "database.dump");
    const client = new Client({ connectionString: databaseUrl.toString() });

    try {
      await chmod(partialDirectory, 0o700);
      await mkdir(audioDirectory, { recursive: true, mode: 0o700 });
      await chmod(audioDirectory, 0o700);
      await client.connect();
      const snapshot = await beginConsistentBackupSnapshot(client);

      const countResult = await client.query(`
          SELECT
            (SELECT count(*)::integer FROM album) AS albums,
            (SELECT count(*)::integer FROM riff) AS riffs,
            (SELECT count(*)::integer FROM tag) AS tags,
            (SELECT count(*)::integer FROM riff_tag) AS riff_tags,
            (SELECT count(*)::integer FROM take_recording) AS takes,
            (SELECT count(*)::integer FROM riff_track) AS tracks,
            (SELECT count(*)::integer FROM riff_youtube_backing) AS youtube_backings,
            (SELECT count(*)::integer FROM comp_segment) AS comp_segments,
            (SELECT count(*)::integer FROM riff_marker) AS markers
        `);
      const storageResult = await client.query(`
          SELECT storage_path, byte_size::bigint AS byte_size, 'take' AS kind
            FROM take_recording
          UNION ALL
          SELECT storage_path, byte_size::bigint AS byte_size, 'track' AS kind
            FROM riff_track
          ORDER BY storage_path
        `);
      throwIfInterrupted();

      const pgEnvironment = {
        ...process.env,
        PGHOST: host,
        PGPORT: databaseUrl.port || "5432",
        PGUSER: decodeURIComponent(databaseUrl.username),
        PGDATABASE: databaseName,
        PGPASSWORD: decodeURIComponent(databaseUrl.password),
      };
      await run(
        postgresBinary("pg_dump"),
        [
          "--format=custom",
          "--compress=6",
          "--no-owner",
          "--no-privileges",
          ...SESSION_BEARING_BACKUP_EXCLUSIONS,
          `--snapshot=${snapshot}`,
          `--file=${dumpPath}`,
        ],
        pgEnvironment,
        { parentToken: operationLock.token },
      );
      throwIfInterrupted();

      const audioFiles = [];
      for (const row of storageResult.rows) {
        throwIfInterrupted();
        const storagePath = String(row.storage_path);
        if (!isRestorableAudioStoragePath(storagePath)) {
          throw new Error(`Unsafe audio path in database: ${storagePath}`);
        }
        const source = path.join(sourceAudioDirectory, storagePath);
        const destination = path.join(audioDirectory, storagePath);
        const sourceStat = await lstat(source).catch(() => null);
        if (!sourceStat?.isFile() || sourceStat.isSymbolicLink()) {
          throw new Error(`Referenced audio file is missing: ${storagePath}`);
        }
        if (sourceStat.size !== Number(row.byte_size)) {
          throw new Error(`Audio file size mismatch: ${storagePath}`);
        }
        await copyFile(source, destination);
        await chmod(destination, 0o600);
        audioFiles.push({
          path: storagePath,
          kind: row.kind,
          bytes: sourceStat.size,
          sha256: await sha256(destination),
        });
      }

      throwIfInterrupted();
      await client.query("COMMIT");
      const packageJson = JSON.parse(
        await readFile(path.join(process.cwd(), "package.json"), "utf8"),
      );
      const counts = countResult.rows[0] ?? {};
      const manifest = {
        format: "riff-sketchbook-backup",
        formatVersion: 1,
        createdAt: new Date().toISOString(),
        appVersion: packageJson.version,
        database: {
          name: databaseName,
          dump: "database.dump",
          sha256: await sha256(dumpPath),
          counts,
        },
        audio: {
          directory: "audio",
          totalBytes: audioFiles.reduce((sum, item) => sum + item.bytes, 0),
          files: audioFiles,
        },
      };
      await writeFile(
        path.join(partialDirectory, "manifest.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
        { flag: "wx" },
      );
      await chmod(path.join(partialDirectory, "manifest.json"), 0o600);
      await writeFile(
        path.join(partialDirectory, "백업 안내.txt"),
        [
          "Riff Sketchbook 로컬 백업",
          "",
          "database.dump: PostgreSQL 데이터",
          "audio/: 녹음과 반주 오디오",
          "manifest.json: 파일 목록과 SHA-256 무결성 정보",
          "",
          "복원 뒤에는 이 백업을 만들 당시의 사용자 이름과 비밀번호로 로그인해야 합니다.",
          "현재 비밀번호로 자동 변경하거나 초기화하지 않습니다.",
          "",
          "복원이 필요할 때는 이 폴더를 그대로 보존한 뒤 앱 폴더의 README를 확인하세요.",
          "",
        ].join("\n"),
        { flag: "wx" },
      );
      await chmod(path.join(partialDirectory, "백업 안내.txt"), 0o600);
      await chmod(dumpPath, 0o600);
      await rename(partialDirectory, finalDirectory);
      console.log(`Backup created: ${finalDirectory}`);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      await rm(partialDirectory, { recursive: true, force: true });
      throw error;
    } finally {
      await client.end().catch(() => undefined);
    }
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    await operationLock.release();
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "백업에 실패했어요.");
    process.exitCode = 1;
  }
}
