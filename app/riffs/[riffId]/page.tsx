import Link from "next/link";
import { ArrowLeft, FolderOpen } from "lucide-react";
import { notFound, redirect } from "next/navigation";

import { RecordingStudio } from "@/components/recording";
import { RiffTagEditor } from "@/components/library/RiffTagEditor";
import { getCurrentUser, getRiffById, hasAppUser } from "@/lib/data";
import { db } from "@/lib/db";
import styles from "./page.module.css";

export const dynamic = "force-dynamic";

type RiffPageProps = {
  params: Promise<{ riffId: string }>;
};

export default async function RiffPage({ params }: RiffPageProps) {
  const [configured, user] = await Promise.all([hasAppUser(), getCurrentUser()]);
  if (!configured) redirect("/setup");
  if (!user) redirect("/login");

  const { riffId } = await params;
  const riff = await getRiffById(riffId);
  if (!riff) notFound();

  const album = riff.albumId
    ? await db.query<{ id: string; name: string }>(
        "SELECT id, name FROM album WHERE id = $1",
        [riff.albumId],
      )
    : null;
  const albumRow = album?.rows[0];

  return (
    <main className={styles.page}>
      <div className={styles.editorFrame}>
        <nav className={styles.breadcrumb} aria-label="현재 위치">
          <Link className={styles.back} href="/" aria-label="홈으로 돌아가기">
            <ArrowLeft size={18} />
          </Link>
          <Link className={styles.albumLink} href={albumRow ? `/albums/${albumRow.id}` : "/albums"}>
            <FolderOpen size={15} aria-hidden="true" />
            <span>{albumRow?.name ?? "내 앨범"}</span>
          </Link>
        </nav>
        <RiffTagEditor
          key={JSON.stringify(riff.tags.map(({ id, name }) => [id, name]))}
          className={styles.tagEditor}
          riffId={riff.id}
          initialTags={riff.tags}
        />
        <RecordingStudio
          className={styles.studio}
          riffId={riff.id}
          title={riff.title}
          initialNotes={riff.notes}
          initialTab={riff.tab}
          metadata={{
            bpm: riff.bpm,
            musicalKey: riff.musicalKey,
            tuning: riff.tuning,
            timeSignature: riff.timeSignature,
            revision: riff.revision,
          }}
        />
      </div>
    </main>
  );
}
