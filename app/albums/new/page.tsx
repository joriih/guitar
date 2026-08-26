import { redirect } from "next/navigation";

import styles from "@/components/library/LibraryPage.module.css";
import { NewAlbumForm } from "@/components/library/NewAlbumForm";
import { AppShell } from "@/components/ui";
import { getCurrentUser, hasAppUser } from "@/lib/data";

export const dynamic = "force-dynamic";

export default async function NewAlbumPage() {
  const [configured, user] = await Promise.all([hasAppUser(), getCurrentUser()]);
  if (!configured) redirect("/setup");
  if (!user) redirect("/login");

  return (
    <AppShell
      currentSection="albums"
      newHref="/riffs/new"
      user={{ name: user.displayName, subtitle: `@${user.username}` }}
    >
      <div className={styles.page}>
        <header className={styles.heading}>
          <div className={styles.headingCopy}>
            <p className={styles.eyebrow}>라이브러리 정리</p>
            <h1>새 앨범 만들기</h1>
            <p>폴더처럼 사용할 앨범을 하나 추가합니다.</p>
          </div>
        </header>
        <NewAlbumForm />
      </div>
    </AppShell>
  );
}
