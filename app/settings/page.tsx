import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { Archive, HardDrive, Settings2 } from "lucide-react";
import { redirect } from "next/navigation";

import { SettingsForm } from "@/components/settings/SettingsForm";
import styles from "@/components/settings/SettingsPage.module.css";
import { AppShell } from "@/components/ui";
import { getCurrentUser, hasAppUser } from "@/lib/data";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;

type StorageSummary = {
  albums: number;
  activeRiffs: number;
  trashedRiffs: number;
  takes: number;
  tracks: number;
  youtubeBackings: number;
  audioBytes: number;
  pendingAudioCleanup: number;
};

type BackupSummary =
  | { state: "ready"; createdAt: string }
  | { state: "none" }
  | { state: "unavailable" };

type StorageSummaryRow = {
  albums: number;
  active_riffs: number;
  trashed_riffs: number;
  takes: number;
  tracks: number;
  youtube_backings: number;
  audio_bytes: string | number;
  pending_audio_cleanup: number;
};

function toSafeCount(value: unknown) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("Invalid storage summary value.");
  }
  return parsed;
}

async function getStorageSummary(): Promise<StorageSummary | null> {
  try {
    const result = await db.query<StorageSummaryRow>(`
      SELECT
        (SELECT count(*)::integer FROM album) AS albums,
        (SELECT count(*)::integer FROM riff WHERE deleted_at IS NULL) AS active_riffs,
        (SELECT count(*)::integer FROM riff WHERE deleted_at IS NOT NULL) AS trashed_riffs,
        (SELECT count(*)::integer FROM take_recording) AS takes,
        (SELECT count(*)::integer FROM riff_track) AS tracks,
        (SELECT count(*)::integer FROM riff_youtube_backing) AS youtube_backings,
        (SELECT count(*)::integer FROM audio_cleanup_queue) AS pending_audio_cleanup,
        (
          SELECT COALESCE(sum(audio.byte_size), 0)::bigint
          FROM (
            SELECT byte_size FROM take_recording
            UNION ALL
            SELECT byte_size FROM riff_track
          ) AS audio
        ) AS audio_bytes
    `);
    const row = result.rows[0];
    if (!row) return null;

    return {
      albums: toSafeCount(row.albums),
      activeRiffs: toSafeCount(row.active_riffs),
      trashedRiffs: toSafeCount(row.trashed_riffs),
      takes: toSafeCount(row.takes),
      tracks: toSafeCount(row.tracks),
      youtubeBackings: toSafeCount(row.youtube_backings),
      audioBytes: toSafeCount(row.audio_bytes),
      pendingAudioCleanup: toSafeCount(row.pending_audio_cleanup),
    };
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readManifestTimestamp(value: unknown) {
  if (!isRecord(value)) return null;
  const database = value.database;
  const audio = value.audio;
  if (
    value.format !== "riff-sketchbook-backup" ||
    value.formatVersion !== 1 ||
    typeof value.createdAt !== "string" ||
    !isRecord(database) ||
    database.name !== "riff_sketchbook" ||
    database.dump !== "database.dump" ||
    typeof database.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/i.test(database.sha256) ||
    !isRecord(audio) ||
    audio.directory !== "audio" ||
    !Array.isArray(audio.files)
  ) {
    return null;
  }

  const timestamp = Date.parse(value.createdAt);
  return Number.isFinite(timestamp) ? timestamp : null;
}

async function getLatestBackupSummary(): Promise<BackupSummary> {
  const backupRoot = path.join(process.cwd(), "backups");

  try {
    const rootStats = await lstat(backupRoot);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
      return { state: "unavailable" };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { state: "none" };
    }
    return { state: "unavailable" };
  }

  let entries;
  try {
    entries = await readdir(backupRoot, { withFileTypes: true });
  } catch {
    return { state: "unavailable" };
  }

  let latestTimestamp: number | null = null;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;

    try {
      const directory = path.join(backupRoot, entry.name);
      const directoryStats = await lstat(directory);
      if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) continue;

      const manifestPath = path.join(directory, "manifest.json");
      const manifestStats = await lstat(manifestPath);
      if (
        !manifestStats.isFile() ||
        manifestStats.isSymbolicLink() ||
        manifestStats.size < 1 ||
        manifestStats.size > MAX_MANIFEST_BYTES
      ) {
        continue;
      }

      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
      const timestamp = readManifestTimestamp(manifest);
      if (timestamp !== null && (latestTimestamp === null || timestamp > latestTimestamp)) {
        latestTimestamp = timestamp;
      }
    } catch {
      // A malformed or incomplete backup is ignored without exposing local details.
    }
  }

  return latestTimestamp === null
    ? { state: "none" }
    : { state: "ready", createdAt: new Date(latestTimestamp).toISOString() };
}

function formatCount(value: number) {
  return new Intl.NumberFormat("ko-KR").format(value);
}

function formatBytes(value: number) {
  if (value < 1024) return `${formatCount(value)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = value;
  let unit = -1;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 1 }).format(size)} ${units[unit]}`;
}

function formatBackupDate(value: string) {
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Seoul",
  }).format(new Date(value));
}

function StorageHealthCard({
  storage,
  backup,
}: {
  storage: StorageSummary | null;
  backup: BackupSummary;
}) {
  const metrics = storage
    ? [
        ["앨범", formatCount(storage.albums)],
        ["사용 중 리프", formatCount(storage.activeRiffs)],
        ["휴지통", formatCount(storage.trashedRiffs)],
        ["전체 테이크", formatCount(storage.takes)],
        ["전체 트랙", formatCount(storage.tracks)],
        ["YouTube 참고", formatCount(storage.youtubeBackings)],
        ["연결된 오디오", formatBytes(storage.audioBytes)],
        ["오디오 정리 대기", `${formatCount(storage.pendingAudioCleanup)}건`],
      ]
    : [];

  return (
    <section className={`${styles.card} ${styles.healthCard}`} aria-labelledby="storage-health-title">
      <div className={styles.cardHeading}>
        <span className={`${styles.cardIcon} ${styles.storageIcon}`} aria-hidden="true">
          <HardDrive size={20} />
        </span>
        <div>
          <h2 id="storage-health-title">저장소와 백업</h2>
          <p>라이브러리 규모와 최근 로컬 백업을 한눈에 확인해요.</p>
        </div>
      </div>

      <div className={styles.healthBody}>
        {storage ? (
          <dl className={styles.healthMetrics} aria-label="라이브러리 저장소 통계">
            {metrics.map(([label, value]) => (
              <div className={styles.healthMetric} key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className={styles.healthUnavailable}>저장소 통계를 확인하지 못했어요.</p>
        )}

        <div className={styles.backupPanel}>
          <span className={styles.backupIcon} aria-hidden="true">
            <Archive size={18} />
          </span>
          <div className={styles.backupCopy}>
            <span>최근 백업</span>
            {backup.state === "ready" ? (
              <strong>
                <time dateTime={backup.createdAt}>{formatBackupDate(backup.createdAt)}</time>
              </strong>
            ) : backup.state === "none" ? (
              <strong>아직 확인된 백업이 없어요.</strong>
            ) : (
              <strong>백업 상태를 확인하지 못했어요.</strong>
            )}
            <small>완료된 백업의 manifest 기준</small>
          </div>
        </div>

        <p className={styles.backupGuidance}>
          웹에서는 백업을 만들거나 지우지 않아요. Finder에서{" "}
          <code>Backup Riff Sketchbook.command</code>를 더블클릭하면 PostgreSQL 데이터와
          오디오를 함께 보관할 수 있어요.
        </p>
      </div>
    </section>
  );
}

export default async function SettingsPage() {
  const [configured, user] = await Promise.all([hasAppUser(), getCurrentUser()]);
  if (!configured) redirect("/setup");
  if (!user) redirect("/login");

  const [storage, backup] = await Promise.all([
    getStorageSummary(),
    getLatestBackupSummary(),
  ]);

  return (
    <AppShell
      currentSection="settings"
      newHref="/riffs/new"
      searchAction="/"
      searchPlaceholder="전체 라이브러리 검색"
      user={{ name: user.displayName, subtitle: `@${user.username}` }}
    >
      <div className={styles.page}>
        <header className={styles.heading}>
          <p className={styles.eyebrow}>
            <Settings2 size={14} aria-hidden="true" /> 내 스케치북
          </p>
          <h1>설정</h1>
          <p>표시 이름과 로그인 비밀번호를 안전하게 관리해요.</p>
        </header>
        <SettingsForm
          initialUser={{ username: user.username, displayName: user.displayName }}
        />
        <StorageHealthCard storage={storage} backup={backup} />
      </div>
    </AppShell>
  );
}
