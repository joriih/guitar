import Link from "next/link";
import Image from "next/image";
import { ArrowLeft, FolderOpen, Pencil, Plus } from "lucide-react";
import { notFound, redirect } from "next/navigation";

import { riffSummary } from "@/components/library/format";
import styles from "@/components/library/LibraryPage.module.css";
import { AppShell, RecentRiffList } from "@/components/ui";
import { DEFAULT_ALBUM_COVER } from "@/lib/album-covers";
import { getAlbumById, getCurrentUser, hasAppUser, listRiffs } from "@/lib/data";
import { uuidSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

type AlbumPageProps = {
  params: Promise<{ albumId: string }>;
};

export default async function AlbumPage({ params }: AlbumPageProps) {
  const [configured, user] = await Promise.all([hasAppUser(), getCurrentUser()]);
  if (!configured) redirect("/setup");
  if (!user) redirect("/login");

  const parsed = uuidSchema.safeParse((await params).albumId);
  if (!parsed.success) notFound();
  const album = await getAlbumById(parsed.data);
  if (!album) notFound();
  const riffs = await listRiffs({ albumId: album.id, limit: 200 });

  return (
    <AppShell
      currentSection="albums"
      newHref={`/riffs/new?albumId=${album.id}`}
      searchAction="/"
      user={{ name: user.displayName, subtitle: `@${user.username}` }}
      searchPlaceholder="전체 라이브러리 검색"
    >
      <div className={styles.page}>
        <header className={styles.heading}>
          <div className={styles.albumHeadingGroup}>
            <div className={styles.albumCover} aria-hidden="true">
              <Image
                src={album.coverAsset ?? DEFAULT_ALBUM_COVER}
                alt=""
                fill
                priority
                sizes="(max-width: 700px) 68px, 92px"
              />
            </div>
            <div className={styles.headingCopy}>
              <Link className={styles.backLink} href="/albums">
                <ArrowLeft size={15} /> 모든 앨범
              </Link>
              <p className={styles.eyebrow}>
                <FolderOpen size={14} />{
                  album.riffCount > riffs.length
                    ? `전체 ${album.riffCount}개 · 최근 ${riffs.length}개 표시`
                    : `${riffs.length}개의 리프`
                }
              </p>
              <h1>{album.name}</h1>
              {album.description ? <p>{album.description}</p> : null}
            </div>
          </div>
          <div className={styles.headingActions}>
            <Link className={styles.secondaryLink} href={`/albums/${album.id}/edit`}>
              <Pencil size={15} aria-hidden="true" /> 앨범 수정
            </Link>
            <Link className={styles.primaryLink} href={`/riffs/new?albumId=${album.id}`}>
              <Plus size={16} aria-hidden="true" /> 새 리프
            </Link>
          </div>
        </header>
        <RecentRiffList
          riffs={riffs.map((riff) => riffSummary(riff, album.name))}
          emptyActionHref={`/riffs/new?albumId=${album.id}`}
        />
      </div>
    </AppShell>
  );
}
