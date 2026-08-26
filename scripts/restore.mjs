import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants as fsConstants, createReadStream } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { Client } from "pg";

import {
  assertLoopbackDatabaseUrl,
  normalizedDatabaseHostname,
} from "./local-database-url.mjs";
import { acquireOperationLock } from "./operation-lock.mjs";
import {
  assertNoIncompleteRestoreState,
  clearRestoreJournal,
  writeRestoreJournal,
} from "./restore-state.mjs";
import {
  assertRestoredCounts,
  assertStorageExact,
  databaseStateMatchesManifest,
} from "./restore-validation.mjs";

const APP_PORT = 3000;
const BACKUP_FORMAT = "riff-sketchbook-backup";
const BACKUP_FORMAT_VERSION = 1;
const DATABASE_NAME = "riff_sketchbook";
const APP_ROLE = "riff_sketchbook_app";
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const REQUIRED_COUNT_KEYS = ["albums", "riffs", "takes", "tracks", "comp_segments"];
const OPTIONAL_COUNT_KEYS = ["tags", "riff_tags", "markers", "youtube_backings"];
const COUNT_TABLES = {
  albums: "album",
  riffs: "riff",
  tags: "tag",
  riff_tags: "riff_tag",
  takes: "take_recording",
  tracks: "riff_track",
  youtube_backings: "riff_youtube_backing",
  comp_segments: "comp_segment",
  markers: "riff_marker",
};

let activeChild = null;
let interruptedSignal = null;

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

function postgresBinary(name) {
  const configured = process.env.POSTGRES_BIN;
  return configured
    ? path.join(configured, name)
    : `/Applications/Postgres.app/Contents/Versions/latest/bin/${name}`;
}

function handleSignal(signal) {
  interruptedSignal = signal;
  activeChild?.kill(signal);
}

const onSigint = () => handleSignal("SIGINT");
const onSigterm = () => handleSignal("SIGTERM");

function throwIfInterrupted() {
  if (interruptedSignal) {
    throw new Error(`${interruptedSignal} 신호로 복원을 취소했어요.`);
  }
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env ?? process.env,
      stdio: options.quiet ? ["ignore", "ignore", "pipe"] : "inherit",
    });
    activeChild = child;
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", (error) => {
      if (activeChild === child) activeChild = null;
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (activeChild === child) activeChild = null;
      if (code === 0) resolve();
      else {
        const detail = stderr.trim();
        reject(
          new Error(
            `${path.basename(command)} 실행에 실패했어요 (${signal ?? code}).${
              detail ? `\n${detail}` : ""
            }`,
          ),
        );
      }
    });
  });
}

async function sha256(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} 정보가 올바르지 않아요.`);
  }
  return value;
}

function safeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} 값이 올바르지 않아요.`);
  }
  return value;
}

function validSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

async function requireRegularFile(filePath, label) {
  const fileStat = await lstat(filePath).catch(() => null);
  if (!fileStat?.isFile() || fileStat.isSymbolicLink()) {
    throw new Error(`${label} 파일을 찾을 수 없거나 안전하지 않아요.`);
  }
  return fileStat;
}

async function requireDirectory(directoryPath, label) {
  const directoryStat = await lstat(directoryPath).catch(() => null);
  if (!directoryStat?.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error(`${label} 폴더를 읽을 수 없거나 안전하지 않아요.`);
  }
  return directoryStat;
}

function validateCounts(value) {
  const input = requireObject(value, "개수");
  const counts = {};
  for (const key of REQUIRED_COUNT_KEYS) {
    if (!Object.hasOwn(input, key)) {
      throw new Error(`백업의 ${key} 개수 정보가 없어요.`);
    }
    counts[key] = safeInteger(input[key], `${key} 개수`);
  }
  for (const key of OPTIONAL_COUNT_KEYS) {
    if (Object.hasOwn(input, key)) {
      counts[key] = safeInteger(input[key], `${key} 개수`);
    }
  }
  return counts;
}

async function validateBackup(backupDirectory) {
  await requireDirectory(backupDirectory, "선택한 백업");

  const manifestPath = path.join(backupDirectory, "manifest.json");
  await requireRegularFile(manifestPath, "manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    throw new Error("manifest.json을 읽을 수 없어요.");
  }
  requireObject(manifest, "백업");
  if (manifest.format !== BACKUP_FORMAT || manifest.formatVersion !== BACKUP_FORMAT_VERSION) {
    throw new Error("지원하지 않는 Riff Sketchbook 백업 형식이에요.");
  }

  const database = requireObject(manifest.database, "데이터베이스");
  if (
    database.name !== DATABASE_NAME ||
    database.dump !== "database.dump" ||
    !validSha256(database.sha256)
  ) {
    throw new Error("백업의 데이터베이스 정보가 올바르지 않아요.");
  }
  const counts = validateCounts(database.counts);
  const dumpPath = path.join(backupDirectory, "database.dump");
  await requireRegularFile(dumpPath, "database.dump");
  if ((await sha256(dumpPath)) !== database.sha256) {
    throw new Error("database.dump의 무결성 값이 일치하지 않아요.");
  }
  await run(postgresBinary("pg_restore"), ["--list", dumpPath], { quiet: true });
  throwIfInterrupted();

  const audio = requireObject(manifest.audio, "오디오");
  if (audio.directory !== "audio" || !Array.isArray(audio.files)) {
    throw new Error("백업의 오디오 정보가 올바르지 않아요.");
  }
  const audioDirectory = path.join(backupDirectory, "audio");
  await requireDirectory(audioDirectory, "백업 오디오");
  const seen = new Set();
  const files = [];
  for (const itemValue of audio.files) {
    throwIfInterrupted();
    const item = requireObject(itemValue, "오디오 파일");
    if (
      typeof item.path !== "string" ||
      path.basename(item.path) !== item.path ||
      seen.has(item.path) ||
      (item.kind !== "take" && item.kind !== "track") ||
      !validSha256(item.sha256)
    ) {
      throw new Error("백업에 안전하지 않거나 중복된 오디오 파일 정보가 있어요.");
    }
    seen.add(item.path);
    const bytes = safeInteger(item.bytes, `${item.path} 크기`);
    const source = path.join(audioDirectory, item.path);
    const fileStat = await requireRegularFile(source, item.path);
    if (fileStat.size !== bytes || (await sha256(source)) !== item.sha256) {
      throw new Error(`${item.path}의 크기 또는 무결성 값이 일치하지 않아요.`);
    }
    files.push({
      name: item.path,
      source,
      bytes,
      kind: item.kind,
      sha256: item.sha256.toLowerCase(),
    });
  }

  const expectedTotal = files.reduce((sum, item) => sum + item.bytes, 0);
  if (safeInteger(audio.totalBytes, "전체 오디오 크기") !== expectedTotal) {
    throw new Error("백업의 전체 오디오 크기 정보가 일치하지 않아요.");
  }

  return {
    dumpPath,
    dumpSha256: database.sha256.toLowerCase(),
    files,
    counts,
  };
}

function databaseEnvironment(databaseUrl) {
  return {
    ...process.env,
    PGHOST: normalizedDatabaseHostname(databaseUrl),
    PGPORT: databaseUrl.port || "5432",
    PGUSER: decodeURIComponent(databaseUrl.username),
    PGDATABASE: databaseUrl.pathname.slice(1),
    PGPASSWORD: decodeURIComponent(databaseUrl.password),
    PGCONNECT_TIMEOUT: "5",
  };
}

async function readDatabaseState(databaseUrl) {
  const client = new Client({ connectionString: databaseUrl.toString() });
  try {
    await client.connect();
    const [countsResult, storageResult] = await Promise.all([
      client.query(`
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
      `),
      client.query(`
        SELECT storage_path, byte_size::bigint AS byte_size, 'take' AS kind
          FROM take_recording
        UNION ALL
        SELECT storage_path, byte_size::bigint AS byte_size, 'track' AS kind
          FROM riff_track
        ORDER BY storage_path, kind
      `),
    ]);
    return { counts: countsResult.rows[0], storage: storageResult.rows };
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function readCandidateDatabaseState(databaseUrl, expectedCounts) {
  const client = new Client({ connectionString: databaseUrl.toString() });
  try {
    await client.connect();
    const counts = {};
    for (const key of Object.keys(expectedCounts)) {
      const table = COUNT_TABLES[key];
      if (!table) throw new Error(`지원하지 않는 백업 개수 항목이에요: ${key}`);
      const existsResult = await client.query(
        "SELECT to_regclass($1) IS NOT NULL AS exists",
        [`public.${table}`],
      );
      if (!existsResult.rows[0]?.exists) {
        counts[key] = 0;
        continue;
      }
      const countResult = await client.query(
        `SELECT count(*)::integer AS value FROM public.${table}`,
      );
      counts[key] = countResult.rows[0]?.value;
    }

    const tableResult = await client.query(`
      SELECT
        to_regclass('public.take_recording') IS NOT NULL AS has_takes,
        to_regclass('public.riff_track') IS NOT NULL AS has_tracks
    `);
    const storage = [];
    if (tableResult.rows[0]?.has_takes) {
      const takeResult = await client.query(`
        SELECT storage_path, byte_size::bigint AS byte_size, 'take' AS kind
          FROM take_recording
      `);
      storage.push(...takeResult.rows);
    }
    if (tableResult.rows[0]?.has_tracks) {
      const trackResult = await client.query(`
        SELECT storage_path, byte_size::bigint AS byte_size, 'track' AS kind
          FROM riff_track
      `);
      storage.push(...trackResult.rows);
    }
    const receiptTableResult = await client.query(
      "SELECT to_regclass('public._riff_restore_receipt') IS NOT NULL AS exists",
    );
    let receiptToken = null;
    if (receiptTableResult.rows[0]?.exists) {
      const receiptResult = await client.query(
        "SELECT token::text AS token FROM public._riff_restore_receipt",
      );
      if (receiptResult.rowCount !== 1 || typeof receiptResult.rows[0]?.token !== "string") {
        throw new Error("복원 완료 영수증이 손상됐어요.");
      }
      receiptToken = receiptResult.rows[0].token;
    }
    return { counts, storage, receiptToken };
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function removeRestoreReceipt(databaseUrl, expectedToken) {
  const client = new Client({ connectionString: databaseUrl.toString() });
  try {
    await client.connect();
    await client.query("BEGIN");
    const receiptResult = await client.query(
      "SELECT token::text AS token FROM public._riff_restore_receipt FOR UPDATE",
    );
    if (receiptResult.rowCount !== 1 || receiptResult.rows[0]?.token !== expectedToken) {
      throw new Error("복원 완료 영수증이 현재 작업과 일치하지 않아요.");
    }
    await client.query("DROP TABLE public._riff_restore_receipt");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end().catch(() => undefined);
  }
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function validationSql(validated, receiptToken) {
  const expectedAudio = validated.files.map((file) => ({
    storage_path: file.name,
    byte_size: file.bytes,
    kind: file.kind,
  }));
  const expectedCounts = Object.entries(validated.counts).map(([name, value]) => ({
    name,
    value,
  }));
  const audioJson = sqlLiteral(JSON.stringify(expectedAudio));
  const countJson = sqlLiteral(JSON.stringify(expectedCounts));
  const countStatements = Object.entries(COUNT_TABLES)
    .map(
      ([name, table]) => `
    IF EXISTS (SELECT 1 FROM restore_expected_counts WHERE name = '${name}') THEN
      IF to_regclass('public.${table}') IS NULL THEN
        INSERT INTO restore_actual_counts VALUES ('${name}', 0);
      ELSE
        EXECUTE 'INSERT INTO restore_actual_counts SELECT ''${name}'', count(*)::bigint FROM public.${table}';
      END IF;
    END IF;`,
    )
    .join("");

  return `
CREATE TEMP TABLE restore_expected_audio (
  storage_path text PRIMARY KEY,
  byte_size bigint NOT NULL,
  kind text NOT NULL CHECK (kind IN ('take', 'track'))
) ON COMMIT DROP;
INSERT INTO restore_expected_audio (storage_path, byte_size, kind)
SELECT storage_path, byte_size, kind
  FROM jsonb_to_recordset(${audioJson}::jsonb)
       AS item(storage_path text, byte_size bigint, kind text);

CREATE TEMP TABLE restore_actual_audio (
  storage_path text NOT NULL,
  byte_size bigint NOT NULL,
  kind text NOT NULL
) ON COMMIT DROP;
DO $riff_restore_audio$
BEGIN
  IF to_regclass('public.take_recording') IS NOT NULL THEN
    EXECUTE 'INSERT INTO restore_actual_audio SELECT storage_path, byte_size::bigint, ''take'' FROM public.take_recording';
  END IF;
  IF to_regclass('public.riff_track') IS NOT NULL THEN
    EXECUTE 'INSERT INTO restore_actual_audio SELECT storage_path, byte_size::bigint, ''track'' FROM public.riff_track';
  END IF;
END
$riff_restore_audio$;
DO $riff_restore_audio_match$
BEGIN
  IF EXISTS (
    SELECT storage_path, byte_size, kind FROM restore_actual_audio
    EXCEPT
    SELECT storage_path, byte_size, kind FROM restore_expected_audio
  ) OR EXISTS (
    SELECT storage_path, byte_size, kind FROM restore_expected_audio
    EXCEPT
    SELECT storage_path, byte_size, kind FROM restore_actual_audio
  ) THEN
    RAISE EXCEPTION 'database audio metadata does not match manifest';
  END IF;
END
$riff_restore_audio_match$;

CREATE TEMP TABLE restore_expected_counts (
  name text PRIMARY KEY,
  value bigint NOT NULL CHECK (value >= 0)
) ON COMMIT DROP;
INSERT INTO restore_expected_counts (name, value)
SELECT name, value
  FROM jsonb_to_recordset(${countJson}::jsonb) AS item(name text, value bigint);
CREATE TEMP TABLE restore_actual_counts (
  name text PRIMARY KEY,
  value bigint NOT NULL
) ON COMMIT DROP;
DO $riff_restore_counts$
BEGIN${countStatements}
END
$riff_restore_counts$;
DO $riff_restore_count_match$
BEGIN
  IF EXISTS (
    SELECT name, value FROM restore_actual_counts
    EXCEPT
    SELECT name, value FROM restore_expected_counts
  ) OR EXISTS (
    SELECT name, value FROM restore_expected_counts
    EXCEPT
    SELECT name, value FROM restore_actual_counts
  ) THEN
    RAISE EXCEPTION 'database row counts do not match manifest';
  END IF;
END
$riff_restore_count_match$;

DROP TABLE IF EXISTS public._riff_restore_receipt;
CREATE TABLE public._riff_restore_receipt (
  token uuid PRIMARY KEY,
  committed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO public._riff_restore_receipt (token) VALUES (${sqlLiteral(receiptToken)}::uuid);
`;
}

async function portHasListener() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: APP_PORT });
    const finish = (value) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(750, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function assertAppStopped() {
  if (await portHasListener()) {
    throw new Error(
      "안전한 복원을 위해 Riff Sketchbook을 실행한 터미널에서 Control + C를 누른 뒤 다시 시도해주세요.",
    );
  }
}

function recoveryTimestamp(date = new Date()) {
  return date.toISOString().replaceAll(":", "-").replace(".", "-");
}

async function createRecoveryDirectory(storageRoot, label) {
  const recoveryRoot = path.join(storageRoot, "recovery");
  await mkdir(recoveryRoot, { recursive: true, mode: DIRECTORY_MODE });
  await chmod(recoveryRoot, DIRECTORY_MODE);
  const recoveryDirectory = path.join(
    recoveryRoot,
    `${label}-${recoveryTimestamp()}-${randomUUID().slice(0, 8)}`,
  );
  await mkdir(recoveryDirectory, { mode: DIRECTORY_MODE });
  await chmod(recoveryDirectory, DIRECTORY_MODE);
  return recoveryDirectory;
}

async function writeRecoveryGuide(recoveryDirectory, lines) {
  const guidePath = path.join(
    recoveryDirectory,
    `복구 안내-${randomUUID().slice(0, 8)}.txt`,
  );
  await writeFile(guidePath, `${lines.join("\n")}\n`, {
    flag: "wx",
    mode: FILE_MODE,
  });
  await chmod(guidePath, FILE_MODE);
}

async function hardenRecoveryTree(targetPath) {
  const targetStat = await lstat(targetPath);
  if (targetStat.isSymbolicLink()) return;
  if (targetStat.isDirectory()) {
    await chmod(targetPath, DIRECTORY_MODE);
    for (const entry of await readdir(targetPath)) {
      await hardenRecoveryTree(path.join(targetPath, entry));
    }
    return;
  }
  if (targetStat.isFile()) await chmod(targetPath, FILE_MODE);
}

async function preserveOrphans(previousDirectory, referencedPaths, storageRoot) {
  const entries = await readdir(previousDirectory, { withFileTypes: true });
  const orphanNames = entries
    .map((entry) => entry.name)
    .filter((name) => name !== ".gitkeep" && !referencedPaths.has(name));
  if (!orphanNames.length) return null;

  const recoveryDirectory = await createRecoveryDirectory(storageRoot, "orphan-audio");
  for (const name of orphanNames) {
    const destination = path.join(recoveryDirectory, name);
    await rename(path.join(previousDirectory, name), destination);
    await hardenRecoveryTree(destination);
  }
  await writeRecoveryGuide(recoveryDirectory, [
    "Riff Sketchbook 복원 전 미연결 오디오 보관함",
    "",
    "복원 전 데이터베이스에서 참조하지 않던 파일을 자동 삭제하지 않고 보존했습니다.",
    "앱에 자동으로 나타나지는 않으므로 Finder에서 직접 확인해주세요.",
  ]);
  return recoveryDirectory;
}

async function preservePreviousDirectory(previousDirectory, storageRoot, reason) {
  const previousStat = await lstat(previousDirectory).catch(() => null);
  if (!previousStat) return null;
  const recoveryDirectory = await createRecoveryDirectory(storageRoot, "pre-restore-audio");
  const payloadDirectory = path.join(recoveryDirectory, "audio");
  await rename(previousDirectory, payloadDirectory);
  await hardenRecoveryTree(payloadDirectory);
  await writeRecoveryGuide(recoveryDirectory, [
    "Riff Sketchbook 복원 전 오디오 보관함",
    "",
    reason,
    "자동으로 삭제하지 않았습니다. 직전에 만든 안전 백업과 함께 보존해주세요.",
  ]);
  return recoveryDirectory;
}

async function rollbackAudio({ activeAudioDirectory, previousDirectory, storageRoot }) {
  const failedIncoming = path.join(storageRoot, `.restore-failed-${randomUUID()}`);
  let activeMoved = false;
  try {
    await rename(activeAudioDirectory, failedIncoming);
    activeMoved = true;
    await rename(previousDirectory, activeAudioDirectory);
    await rm(failedIncoming, { recursive: true, force: true });
  } catch (error) {
    if (activeMoved) {
      await rename(failedIncoming, activeAudioDirectory).catch(() => undefined);
    }
    throw new Error(
      "복원 실패 후 기존 오디오를 자동으로 되돌리지 못했어요. storage의 복원 폴더를 보존해주세요.",
      { cause: error },
    );
  }
}

async function main() {
await loadLocalEnv();

const backupArgument = process.argv[2];
if (!backupArgument) {
  throw new Error("복원할 백업 폴더를 지정해주세요.");
}
const backupDirectory = path.resolve(backupArgument.replace(/\/+$/, ""));
const databaseUrl = assertLoopbackDatabaseUrl(
  process.env.DATABASE_URL ??
    `postgresql://${APP_ROLE}@127.0.0.1:5432/${DATABASE_NAME}`,
);
if (
  databaseUrl.pathname.slice(1) !== DATABASE_NAME ||
  decodeURIComponent(databaseUrl.username) !== APP_ROLE
) {
  throw new Error("복원은 로컬 riff_sketchbook 데이터베이스와 전용 역할에서만 가능해요.");
}

const originalUmask = process.umask(0o077);
await assertNoIncompleteRestoreState();
const operationLock = await acquireOperationLock("restore");
try {
  // A prior restore can start after the preflight above, leave an artifact,
  // and die before this process acquires the stale lease. Recheck while this
  // restore owns the generation so a second restore never builds on that state.
  await assertNoIncompleteRestoreState();
} catch (error) {
  await operationLock.release();
  process.umask(originalUmask);
  throw error;
}
process.on("SIGINT", onSigint);
process.on("SIGTERM", onSigterm);

const storageRoot = path.join(process.cwd(), "storage");
const activeAudioDirectory = path.join(storageRoot, "audio");
let incomingDirectory = null;
let workDirectory = null;
let previousDirectory = null;
let activeAudioMoved = false;
let incomingActivated = false;
let databaseRestored = false;
let databaseRestoreAttempted = false;
let currentReferencedPaths = new Set();
let validated = null;
let restoreAttemptToken = null;
let journal = null;
let journalCreated = false;
let safeToClearJournal = false;

async function updateJournal(phase, extra = {}) {
  const now = new Date().toISOString();
  journal = {
    ...journal,
    ...extra,
    phase,
    updatedAt: now,
  };
  await writeRestoreJournal(journal);
}

try {
  await assertAppStopped();
  for (const binary of ["pg_restore", "psql"]) {
    await access(postgresBinary(binary), fsConstants.X_OK).catch(() => {
      throw new Error(`Postgres.app의 ${binary} 도구를 찾을 수 없어요.`);
    });
  }
  await run(process.execPath, [path.join(process.cwd(), "scripts", "db-init.mjs")], {
    env: { ...process.env, RIFF_OPERATION_PARENT_TOKEN: operationLock.token },
  });
  throwIfInterrupted();

  console.log("백업 파일 무결성을 확인하고 있어요…");
  validated = await validateBackup(backupDirectory);
  throwIfInterrupted();

  console.log("현재 데이터를 안전 백업하고 있어요…");
  await run(process.execPath, [path.join(process.cwd(), "scripts", "backup.mjs")], {
    env: { ...process.env, RIFF_OPERATION_PARENT_TOKEN: operationLock.token },
  });
  throwIfInterrupted();

  const currentState = await readDatabaseState(databaseUrl);
  currentReferencedPaths = new Set(
    currentState.storage.map((row) => String(row.storage_path)),
  );

  await mkdir(activeAudioDirectory, { recursive: true, mode: DIRECTORY_MODE });
  await requireDirectory(activeAudioDirectory, "현재 오디오 저장소");
  await chmod(activeAudioDirectory, DIRECTORY_MODE);
  incomingDirectory = await mkdtemp(path.join(storageRoot, ".restore-incoming-"));
  await chmod(incomingDirectory, DIRECTORY_MODE);
  await writeFile(path.join(incomingDirectory, ".gitkeep"), "", {
    flag: "wx",
    mode: FILE_MODE,
  });
  for (const file of validated.files) {
    throwIfInterrupted();
    const destination = path.join(incomingDirectory, file.name);
    await copyFile(file.source, destination);
    await chmod(destination, FILE_MODE);
    const copiedStat = await requireRegularFile(destination, file.name);
    if (copiedStat.size !== file.bytes || (await sha256(destination)) !== file.sha256) {
      throw new Error(`${file.name}을 복원 준비 폴더에 안전하게 복사하지 못했어요.`);
    }
  }

  workDirectory = await mkdtemp(path.join(storageRoot, ".restore-work-"));
  await chmod(workDirectory, DIRECTORY_MODE);
  const restoreSqlPath = path.join(workDirectory, "restore.sql");
  const validationSqlPath = path.join(workDirectory, "validate.sql");
  restoreAttemptToken = randomUUID();
  await run(
    postgresBinary("pg_restore"),
    [
      "--clean",
      "--if-exists",
      "--no-owner",
      "--no-privileges",
      `--file=${restoreSqlPath}`,
      validated.dumpPath,
    ],
    { env: databaseEnvironment(databaseUrl) },
  );
  await chmod(restoreSqlPath, FILE_MODE);
  await writeFile(validationSqlPath, validationSql(validated, restoreAttemptToken), {
    flag: "wx",
    mode: FILE_MODE,
  });
  await chmod(validationSqlPath, FILE_MODE);
  throwIfInterrupted();
  await assertAppStopped();

  previousDirectory = path.join(storageRoot, `.restore-previous-${randomUUID()}`);
  const now = new Date().toISOString();
  journal = {
    version: 1,
    operationToken: operationLock.token,
    phase: "prepared",
    database: DATABASE_NAME,
    backupDirectory,
    databaseDumpSha256: validated.dumpSha256,
    restoreAttemptToken,
    activeAudio: "audio",
    previousAudio: path.basename(previousDirectory),
    incomingAudio: path.basename(incomingDirectory),
    workDirectory: path.basename(workDirectory),
    createdAt: now,
    updatedAt: now,
  };
  await writeRestoreJournal(journal, { initial: true });
  journalCreated = true;
  await rename(activeAudioDirectory, previousDirectory);
  activeAudioMoved = true;
  await updateJournal("previous-audio-preserved");
  await rename(incomingDirectory, activeAudioDirectory);
  incomingDirectory = null;
  incomingActivated = true;
  await updateJournal("audio-swapped", { incomingAudio: null });

  const resetSchemaSql = [
    "DROP SCHEMA IF EXISTS public CASCADE",
    `CREATE SCHEMA public AUTHORIZATION ${APP_ROLE}`,
    "REVOKE CREATE ON SCHEMA public FROM PUBLIC",
    `GRANT USAGE, CREATE ON SCHEMA public TO ${APP_ROLE}`,
  ].join("; ");
  console.log("데이터베이스와 오디오를 복원하고 있어요…");
  await updateJournal("database-restoring");
  databaseRestoreAttempted = true;
  await run(
    postgresBinary("psql"),
    [
      "--no-psqlrc",
      "--no-password",
      "--single-transaction",
      "--set=ON_ERROR_STOP=1",
      `--dbname=${DATABASE_NAME}`,
      "--command",
      resetSchemaSql,
      "--file",
      restoreSqlPath,
      "--file",
      validationSqlPath,
    ],
    { env: databaseEnvironment(databaseUrl) },
  );
  databaseRestored = true;
  await updateJournal("database-restored");
  throwIfInterrupted();

  await run(process.execPath, [path.join(process.cwd(), "scripts", "db-init.mjs")], {
    env: { ...process.env, RIFF_OPERATION_PARENT_TOKEN: operationLock.token },
  });
  const restoredState = await readDatabaseState(databaseUrl);
  assertRestoredCounts(restoredState.counts, validated.counts);
  assertStorageExact(restoredState.storage, validated.files);
  await removeRestoreReceipt(databaseUrl, restoreAttemptToken);
  await updateJournal("verified", { restoreReceiptCleared: true });
  throwIfInterrupted();

  const orphanRecovery = await preserveOrphans(
    previousDirectory,
    currentReferencedPaths,
    storageRoot,
  );
  await rm(previousDirectory, { recursive: true, force: true });
  previousDirectory = null;
  await updateJournal("completed", {
    previousAudio: null,
    orphanRecovery: orphanRecovery
      ? path.relative(storageRoot, orphanRecovery)
      : null,
  });
  safeToClearJournal = true;
  if (orphanRecovery) {
    console.log(`복원 전 미연결 오디오는 여기에 보존했어요: ${orphanRecovery}`);
  }
  console.log("복원이 완료됐어요. 백업을 만들 당시의 사용자 이름과 비밀번호로 로그인해주세요.");
} catch (error) {
  let recoveryDirectory = null;
  let commitCheckError = null;
  if (!databaseRestored && databaseRestoreAttempted && validated) {
    try {
      const candidateState = await readCandidateDatabaseState(
        databaseUrl,
        validated.counts,
      );
      const stateMatches =
        databaseStateMatchesManifest(
          candidateState,
          validated.counts,
          validated.files,
        );
      if (candidateState.receiptToken === restoreAttemptToken && stateMatches) {
        databaseRestored = true;
        await updateJournal("database-commit-detected", {
          note: "psql 결과가 유실된 뒤 데이터베이스와 manifest가 일치함을 확인했습니다.",
        }).catch(() => undefined);
      } else if (candidateState.receiptToken === null) {
        // The transaction did not commit to the manifest state, so audio can roll back.
      } else {
        throw new Error(
          "복원 완료 영수증 또는 데이터베이스 상태가 manifest와 일치하지 않아요.",
        );
      }
    } catch (checkError) {
      commitCheckError = checkError;
      await updateJournal("attention-required", {
        note: "psql 종료 뒤 데이터베이스 상태를 확인할 수 없어 오디오를 자동 변경하지 않았습니다.",
      }).catch(() => undefined);
    }
  }

  if (commitCheckError) {
    throw new Error(
      `${error instanceof Error ? error.message : "복원 결과를 확인하지 못했어요."}\n데이터베이스 반영 여부가 불확실해 오디오를 되돌리지 않았습니다. storage의 복원 저널과 두 오디오 폴더를 모두 보존해주세요.`,
      { cause: commitCheckError },
    );
  }
  if (!databaseRestored && incomingActivated && previousDirectory) {
    await rollbackAudio({ activeAudioDirectory, previousDirectory, storageRoot });
    previousDirectory = null;
    activeAudioMoved = false;
  } else if (!databaseRestored && activeAudioMoved && previousDirectory) {
    await rename(previousDirectory, activeAudioDirectory);
    previousDirectory = null;
    activeAudioMoved = false;
  } else if (databaseRestored && previousDirectory) {
    recoveryDirectory = await preservePreviousDirectory(
      previousDirectory,
      storageRoot,
      "데이터베이스 복원 뒤 후속 확인이 끝나기 전에 작업이 중단됐습니다.",
    ).catch(() => null);
    if (recoveryDirectory) {
      previousDirectory = null;
      await updateJournal("attention-required", {
        previousAudio: null,
        recoveryDirectory: path.relative(storageRoot, recoveryDirectory),
      }).catch(() => undefined);
    }
  }
  if (!databaseRestored && !previousDirectory) {
    safeToClearJournal = true;
  }
  if (recoveryDirectory) {
    throw new Error(
      `${error instanceof Error ? error.message : "복원 후 확인에 실패했어요."}\n복원 전 오디오는 ${recoveryDirectory}에 보존했어요.`,
      { cause: error },
    );
  }
  throw error;
} finally {
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
  let finalizationError = null;
  if (incomingDirectory) {
    await rm(incomingDirectory, { recursive: true, force: true }).catch((error) => {
      finalizationError = new Error(
        "복원 준비 오디오 폴더를 정리하지 못했어요. storage 폴더를 보존해주세요.",
        { cause: error },
      );
    });
  }
  if (workDirectory) {
    await rm(workDirectory, { recursive: true, force: true }).catch((error) => {
      finalizationError ??= new Error(
        "복원 임시 작업 폴더를 정리하지 못했어요. storage 폴더를 보존해주세요.",
        { cause: error },
      );
    });
  }
  if (journalCreated && safeToClearJournal && !finalizationError) {
    await clearRestoreJournal().catch((error) => {
      finalizationError = new Error(
        "복원은 끝났지만 안전 저널을 정리하지 못했어요. storage 폴더를 보존해주세요.",
        { cause: error },
      );
    });
  }
  process.umask(originalUmask);
  await operationLock.release().catch((error) => {
    finalizationError ??= error;
  });
  if (finalizationError) throw finalizationError;
}
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "복원에 실패했어요.");
  process.exitCode = 1;
}
