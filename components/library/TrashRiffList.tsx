import { Clock3, Trash2 } from "lucide-react";

import type { RecentRiffSummary } from "@/components/ui/HomeContent";
import styles from "@/components/ui/HomeContent.module.css";

import { RestoreRiffButton } from "./RestoreRiffButton";

export function TrashRiffList({ riffs }: { riffs: RecentRiffSummary[] }) {
  return (
    <div className={styles.riffList}>
      {riffs.map((riff) => (
        <article className={`${styles.riffRow} ${styles.trashedRiffRow}`} key={riff.id}>
          <span className={styles.trashRiffIcon} aria-hidden="true">
            <Trash2 size={16} />
          </span>
          <div className={styles.riffIdentity}>
            <strong>{riff.title}</strong>
            <span>{riff.album}</span>
          </div>
          <div className={styles.riffSession}>
            {riff.bpm ? <span>{riff.bpm} BPM</span> : null}
            {riff.keyName ? <span>{riff.keyName}</span> : null}
          </div>
          <span className={styles.riffUpdated}>
            <Clock3 size={13} aria-hidden="true" /> {riff.updatedLabel}
          </span>
          <RestoreRiffButton
            riffId={riff.id}
            title={riff.title}
            revision={riff.revision}
          />
        </article>
      ))}
    </div>
  );
}
