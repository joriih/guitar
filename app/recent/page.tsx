import Link from "next/link";
import { Clock3, Plus } from "lucide-react";
import { redirect } from "next/navigation";

import { riffSummary } from "@/components/library/format";
import styles from "@/components/library/LibraryPage.module.css";
import { AppShell, RecentRiffList } from "@/components/ui";
import {
  countRiffs,
  getCurrentUser,
  hasAppUser,
  listAlbums,
  listRiffs,
} from "@/lib/data";

export const dynamic = "force-dynamic";

export default async function RecentPage() {
  const [configured, user] = await Promise.all([hasAppUser(), getCurrentUser()]);
  if (!configured) redirect("/setup");
  if (!user) redirect("/login");

  const [albums, riffs, totalRiffCount] = await Promise.all([
    listAlbums(),
    listRiffs({ limit: 200 }),
    countRiffs(),
  ]);
  const albumNames = new Map(albums.map((album) => [album.id, album.name]));

  return (
    <AppShell
      currentSection="recent"
      newHref="/riffs/new"
      searchAction="/"
      user={{ name: user.displayName, subtitle: `@${user.username}` }}
      searchPlaceholder="전체 라이브러리 검색"
    >
      <div className={styles.page}>
        <header className={styles.heading}>
          <div className={styles.headingCopy}>
            <p className={styles.eyebrow}>
              <Clock3 size={14} /> 최근 작업 순서
            </p>
            <h1>최근 리프</h1>
            <p>
              {totalRiffCount > riffs.length
                ? `전체 ${totalRiffCount}개 · 최근 ${riffs.length}개 표시`
                : `${riffs.length}개의 리프`}
            </p>
          </div>
          <Link className={styles.primaryLink} href="/riffs/new">
            <Plus size={16} /> 새 리프
          </Link>
        </header>
        <RecentRiffList
          riffs={riffs.map((riff) =>
            riffSummary(
              riff,
              riff.albumId
                ? albumNames.get(riff.albumId) ?? "내 앨범"
                : "분류되지 않음",
            ),
          )}
        />
      </div>
    </AppShell>
  );
}
