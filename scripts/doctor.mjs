import { lstat, readdir } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

import { assertLoopbackDatabaseUrl } from "./local-database-url.mjs";
import { acquireOperationLock } from "./operation-lock.mjs";
import { assertNoIncompleteRestoreState } from "./restore-state.mjs";

function loadLocalEnv() {
  const envPath = path.join(process.cwd(), ".env.local");
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

export async function acquireDoctorInspectionLease({
  root = process.cwd(),
  acquireLock = acquireOperationLock,
  assertRestoreState = assertNoIncompleteRestoreState,
} = {}) {
  const lease = await acquireLock("doctor", { root });
  try {
    // Take the generation lease first. A restore that races this assertion
    // will then conflict instead of creating mixed-generation artifacts.
    await assertRestoreState(root);
    return lease;
  } catch (error) {
    await lease.release();
    throw error;
  }
}

async function main() {
loadLocalEnv();

const databaseUrl = assertLoopbackDatabaseUrl(
  process.env.DATABASE_URL ??
    "postgresql://riff_sketchbook_app@127.0.0.1:5432/riff_sketchbook",
);
if (
  databaseUrl.pathname.slice(1) !== "riff_sketchbook" ||
  decodeURIComponent(databaseUrl.username) !== "riff_sketchbook_app"
) {
  throw new Error("점검은 로컬 riff_sketchbook 데이터베이스에서만 실행할 수 있어요.");
}

const client = new Client({ connectionString: databaseUrl.toString() });
const audioDirectory = path.join(process.cwd(), "storage", "audio");
const problems = [];
const warnings = [];
const operationLock = await acquireDoctorInspectionLease();

try {
  const audioDirectoryStat = await lstat(audioDirectory).catch(() => null);
  if (!audioDirectoryStat?.isDirectory() || audioDirectoryStat.isSymbolicLink()) {
    throw new Error("오디오 저장 폴더가 없거나 안전한 로컬 폴더가 아니에요.");
  }

  try {
    await client.connect();
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");

  const countsResult = await client.query(`
        SELECT
          (SELECT count(*)::integer FROM album) AS albums,
          (SELECT count(*)::integer FROM riff WHERE deleted_at IS NULL) AS riffs,
          (SELECT count(*)::integer FROM riff WHERE deleted_at IS NOT NULL) AS trashed_riffs,
          (SELECT count(*)::integer FROM tag) AS tags,
          (SELECT count(*)::integer FROM riff_tag) AS riff_tags,
          (SELECT count(*)::integer FROM take_recording) AS takes,
          (SELECT count(*)::integer FROM riff_track) AS tracks,
          (SELECT count(*)::integer FROM riff_youtube_backing) AS youtube_backings,
          (SELECT count(*)::integer FROM comp_segment) AS comp_segments,
          (SELECT count(*)::integer FROM riff_marker) AS markers
      `);
  const storageResult = await client.query(`
        SELECT storage_path, byte_size::bigint AS byte_size, '테이크' AS kind
          FROM take_recording
        UNION ALL
        SELECT storage_path, byte_size::bigint AS byte_size, '트랙' AS kind
          FROM riff_track
        ORDER BY storage_path
      `);
  const cleanupQueueResult = await client.query(`
        SELECT storage_path
          FROM audio_cleanup_queue
         ORDER BY queued_at, storage_path
      `);
  const compResult = await client.query(`
        SELECT c.id
          FROM comp_segment c
          JOIN take_recording t ON t.id = c.take_id
         WHERE c.riff_id <> t.riff_id
      `);
  const trimResult = await client.query(`
        SELECT id
          FROM take_recording
         WHERE (trim_end_ms IS NOT NULL AND trim_end_ms <= trim_start_ms)
            OR (duration_ms IS NOT NULL AND trim_start_ms >= duration_ms)
            OR (duration_ms IS NOT NULL AND trim_end_ms > duration_ms)
      `);
  const primaryResult = await client.query(`
        SELECT riff_id
          FROM take_recording
         GROUP BY riff_id
        HAVING count(*) FILTER (WHERE is_primary) <> 1
      `);
  const orphanTagResult = await client.query(`
        SELECT tag.id
          FROM tag
          LEFT JOIN riff_tag ON riff_tag.tag_id = tag.id
         WHERE riff_tag.tag_id IS NULL
      `);
  const tagLimitResult = await client.query(`
        SELECT riff_id
          FROM riff_tag
         GROUP BY riff_id
        HAVING count(*) > 12
      `);
  const markerLimitResult = await client.query(`
        SELECT riff_id
          FROM riff_marker
         GROUP BY riff_id
        HAVING count(*) > 64
      `);

  if (compResult.rowCount) {
    problems.push(`다른 리프의 테이크를 참조하는 Comp 구간 ${compResult.rowCount}개`);
  }
  if (trimResult.rowCount) {
    problems.push(`길이 범위를 벗어난 테이크 트림 ${trimResult.rowCount}개`);
  }
  if (primaryResult.rowCount) {
    problems.push(`대표 테이크 상태가 올바르지 않은 리프 ${primaryResult.rowCount}개`);
  }
  if (tagLimitResult.rowCount) {
    problems.push(`태그 개수 제한을 넘은 리프 ${tagLimitResult.rowCount}개`);
  }
  if (markerLimitResult.rowCount) {
    problems.push(`마커 개수 제한을 넘은 리프 ${markerLimitResult.rowCount}개`);
  }
  if (orphanTagResult.rowCount) {
    warnings.push(`어떤 리프에도 연결되지 않은 태그 ${orphanTagResult.rowCount}개`);
  }

  const referencedFiles = new Set();
  const queuedCleanupFiles = new Set(
    cleanupQueueResult.rows.map((row) => String(row.storage_path)),
  );
  for (const row of storageResult.rows) {
    const storagePath = String(row.storage_path);
    if (path.basename(storagePath) !== storagePath) {
      problems.push(`${row.kind}에 안전하지 않은 파일 경로가 있어요: ${storagePath}`);
      continue;
    }
    referencedFiles.add(storagePath);
    const filePath = path.join(audioDirectory, storagePath);
    const fileStat = await lstat(filePath).catch(() => null);
    if (!fileStat?.isFile() || fileStat.isSymbolicLink()) {
      problems.push(`${row.kind} 파일이 없어요: ${storagePath}`);
    } else if (fileStat.size !== Number(row.byte_size)) {
      problems.push(`${row.kind} 파일 크기가 달라요: ${storagePath}`);
    }
  }

  const directoryEntries = await readdir(audioDirectory, { withFileTypes: true }).catch(
    (error) => {
      problems.push(`오디오 저장 폴더를 읽을 수 없어요: ${error.message}`);
      return [];
    },
  );
  for (const entry of directoryEntries) {
    if (entry.name === ".gitkeep") continue;
    if (!entry.isFile()) {
      warnings.push(`오디오 폴더에 일반 파일이 아닌 항목이 있어요: ${entry.name}`);
    } else if (
      !referencedFiles.has(entry.name) &&
      !queuedCleanupFiles.has(entry.name)
    ) {
      warnings.push(`데이터베이스에서 사용하지 않는 오디오 파일: ${entry.name}`);
    }
  }

  await client.query("COMMIT");
  const counts = countsResult.rows[0];
  console.log(
    [
      "Riff Sketchbook 데이터 점검",
      `앨범 ${counts.albums} · 리프 ${counts.riffs} · 휴지통 ${counts.trashed_riffs}`,
      `태그 ${counts.tags} · 태그 연결 ${counts.riff_tags}`,
      `테이크 ${counts.takes} · 트랙 ${counts.tracks} · YouTube 참고 ${counts.youtube_backings} · Comp ${counts.comp_segments} · 마커 ${counts.markers}`,
      `오디오 정리 대기 ${cleanupQueueResult.rowCount}건`,
    ].join("\n"),
  );

  if (warnings.length) {
    console.warn(`\n주의 ${warnings.length}건`);
    for (const warning of warnings) console.warn(`- ${warning}`);
  }
  if (problems.length) {
    console.error(`\n문제 ${problems.length}건`);
    for (const problem of problems) console.error(`- ${problem}`);
    process.exitCode = 1;
  } else {
    console.log("\n데이터와 오디오 연결 상태가 정상이에요.");
  }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end().catch(() => undefined);
  }
} finally {
  await operationLock.release();
}
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "데이터 점검에 실패했어요.");
    process.exitCode = 1;
  }
}
