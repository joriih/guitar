import { Trash2 } from "lucide-react";
import { redirect } from "next/navigation";

import { LibraryEmptyState } from "@/components/library/LibraryEmptyState";
import { riffSummary } from "@/components/library/format";
import { TrashRiffList } from "@/components/library/TrashRiffList";
import styles from "@/components/library/LibraryPage.module.css";
import { AppShell } from "@/components/ui";
import {
  countRiffs,
  getCurrentUser,
  hasAppUser,
  listAlbums,
  listRiffs,
} from "@/lib/data";

export const dynamic = "force-dynamic";

export default async function TrashPage() {
  const [configured, user] = await Promise.all([hasAppUser(), getCurrentUser()]);
  if (!configured) redirect("/setup");
  if (!user) redirect("/login");

  const [albums, riffs, totalRiffCount] = await Promise.all([
    listAlbums(),
    listRiffs({ deletedOnly: true, limit: 200 }),
    countRiffs({ deletedOnly: true }),
  ]);
  const albumNames = new Map(albums.map((album) => [album.id, album.name]));

  return (
    <AppShell
      currentSection="trash"
      newHref="/riffs/new"
      user={{ name: user.displayName, subtitle: `@${user.username}` }}
    >
      <div className={styles.page}>
        <header className={styles.heading}>
          <div className={styles.headingCopy}>
            <p className={styles.eyebrow}><Trash2 size={14} /> 보관된 삭제 항목</p>
            <h1>휴지통</h1>
            <p>
              {totalRiffCount > riffs.length
                ? `전체 ${totalRiffCount}개 · 최근 ${riffs.length}개 표시 · 필요할 때 다시 복원할 수 있어요.`
                : `${riffs.length}개의 리프 · 필요할 때 다시 복원할 수 있어요.`}
            </p>
          </div>
        </header>
        {riffs.length ? (
          <TrashRiffList
            riffs={riffs.map((riff) =>
              riffSummary(
                riff,
                riff.albumId ? albumNames.get(riff.albumId) ?? "내 앨범" : "분류되지 않음",
              ),
            )}
          />
        ) : (
          <LibraryEmptyState
            icon={Trash2}
            title="휴지통이 비어 있어요"
            description="휴지통으로 옮긴 리프를 확인하고 다시 복원할 수 있어요."
            actionHref="/albums"
            actionLabel="앨범으로 돌아가기"
          />
        )}
      </div>
    </AppShell>
  );
}
