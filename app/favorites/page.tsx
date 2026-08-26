import { Star } from "lucide-react";
import { redirect } from "next/navigation";

import { LibraryEmptyState } from "@/components/library/LibraryEmptyState";
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

export default async function FavoritesPage() {
  const [configured, user] = await Promise.all([hasAppUser(), getCurrentUser()]);
  if (!configured) redirect("/setup");
  if (!user) redirect("/login");

  const [albums, riffs, totalRiffCount] = await Promise.all([
    listAlbums(),
    listRiffs({ favoriteOnly: true, limit: 200 }),
    countRiffs({ favoriteOnly: true }),
  ]);
  const albumNames = new Map(albums.map((album) => [album.id, album.name]));

  return (
    <AppShell
      currentSection="favorites"
      newHref="/riffs/new"
      user={{ name: user.displayName, subtitle: `@${user.username}` }}
    >
      <div className={styles.page}>
        <header className={styles.heading}>
          <div className={styles.headingCopy}>
            <p className={styles.eyebrow}><Star size={14} /> 골라둔 아이디어</p>
            <h1>즐겨찾기</h1>
            <p>
              {totalRiffCount > riffs.length
                ? `전체 ${totalRiffCount}개 · 최근 ${riffs.length}개 표시`
                : `${riffs.length}개의 리프`}
            </p>
          </div>
        </header>
        {riffs.length ? (
          <RecentRiffList
            riffs={riffs.map((riff) =>
              riffSummary(
                riff,
                riff.albumId ? albumNames.get(riff.albumId) ?? "내 앨범" : "분류되지 않음",
              ),
            )}
          />
        ) : (
          <LibraryEmptyState
            icon={Star}
            title="아직 즐겨찾기한 리프가 없어요"
            description="리프 목록의 별을 누르면 이곳에서 빠르게 다시 찾을 수 있어요."
            actionHref="/recent"
            actionLabel="최근 리프 보기"
          />
        )}
      </div>
    </AppShell>
  );
}
