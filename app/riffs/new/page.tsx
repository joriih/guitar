import { redirect } from "next/navigation";

import { NewRiffForm } from "@/components/library/NewRiffForm";
import styles from "@/components/library/LibraryPage.module.css";
import { AppShell } from "@/components/ui";
import { getCurrentUser, hasAppUser, listAlbums } from "@/lib/data";

export const dynamic = "force-dynamic";

type NewRiffPageProps = {
  searchParams: Promise<{ albumId?: string }>;
};

export default async function NewRiffPage({ searchParams }: NewRiffPageProps) {
  const [configured, user] = await Promise.all([hasAppUser(), getCurrentUser()]);
  if (!configured) redirect("/setup");
  if (!user) redirect("/login");

  const [albums, query] = await Promise.all([listAlbums(), searchParams]);
  const defaultAlbumId = albums.some((album) => album.id === query.albumId)
    ? query.albumId
    : undefined;
  return (
    <AppShell
      currentSection="home"
      newHref="/riffs/new"
      searchAction="/"
      user={{ name: user.displayName, subtitle: `@${user.username}` }}
    >
      <div className={styles.page}>
        <header className={styles.heading}>
          <div className={styles.headingCopy}>
            <p className={styles.eyebrow}>새 스케치</p>
            <h1>새 리프 만들기</h1>
            <p>아이디어를 적고 바로 첫 테이크를 녹음해보세요.</p>
          </div>
        </header>
        <NewRiffForm
          albums={albums.map(({ id, name }) => ({ id, name }))}
          defaultAlbumId={defaultAlbumId}
        />
      </div>
    </AppShell>
  );
}
