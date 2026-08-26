import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { EditAlbumForm } from "@/components/library/EditAlbumForm";
import styles from "@/components/library/LibraryPage.module.css";
import { AppShell } from "@/components/ui";
import { getAlbumById, getCurrentUser, hasAppUser } from "@/lib/data";
import { uuidSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

type EditAlbumPageProps = {
  params: Promise<{ albumId: string }>;
};

export default async function EditAlbumPage({ params }: EditAlbumPageProps) {
  const [configured, user] = await Promise.all([hasAppUser(), getCurrentUser()]);
  if (!configured) redirect("/setup");
  if (!user) redirect("/login");

  const parsed = uuidSchema.safeParse((await params).albumId);
  if (!parsed.success) notFound();
  const album = await getAlbumById(parsed.data);
  if (!album) notFound();

  return (
    <AppShell
      currentSection="albums"
      newHref="/riffs/new"
      searchAction="/"
      user={{ name: user.displayName, subtitle: `@${user.username}` }}
      searchPlaceholder="전체 라이브러리 검색"
    >
      <div className={styles.page}>
        <header className={styles.heading}>
          <div className={styles.headingCopy}>
            <Link className={styles.backLink} href={`/albums/${album.id}`}>
              <ArrowLeft size={15} /> 앨범으로 돌아가기
            </Link>
            <p className={styles.eyebrow}>앨범 정리</p>
            <h1>앨범 수정</h1>
            <p>리프와 녹음 파일은 그대로 유지됩니다.</p>
          </div>
        </header>
        <EditAlbumForm album={album} />
      </div>
    </AppShell>
  );
}
