import Link from "next/link";
import { FolderPlus } from "lucide-react";
import { redirect } from "next/navigation";

import { albumSummary } from "@/components/library/catalog";
import styles from "@/components/library/LibraryPage.module.css";
import { AlbumGallery, AppShell } from "@/components/ui";
import { getCurrentUser, hasAppUser, listAlbums } from "@/lib/data";

export const dynamic = "force-dynamic";

type AlbumsPageProps = {
  searchParams: Promise<{ view?: string }>;
};

export default async function AlbumsPage({ searchParams }: AlbumsPageProps) {
  const [configured, user] = await Promise.all([hasAppUser(), getCurrentUser()]);
  if (!configured) redirect("/setup");
  if (!user) redirect("/login");

  const [albums, query] = await Promise.all([listAlbums(), searchParams]);
  const view = query.view === "list" ? "list" : "grid";

  return (
    <AppShell
      currentSection="albums"
      newHref="/riffs/new"
      searchAction="/"
      user={{ name: user.displayName, subtitle: `@${user.username}` }}
      view={view}
      gridHref="/albums?view=grid"
      listHref="/albums?view=list"
      searchPlaceholder="전체 라이브러리 검색"
    >
      <div className={styles.page}>
        <header className={styles.heading}>
          <div className={styles.headingCopy}>
            <p className={styles.eyebrow}>라이브러리</p>
            <h1>모든 앨범</h1>
            <p>{albums.length}개의 앨범 · {albums.reduce((sum, album) => sum + album.riffCount, 0)}개의 리프</p>
          </div>
          <Link className={styles.primaryLink} href="/albums/new">
            <FolderPlus size={16} /> 새 앨범
          </Link>
        </header>
        <AlbumGallery albums={albums.map(albumSummary)} layout={view} />
      </div>
    </AppShell>
  );
}
