import Link from "next/link";
import type { LucideIcon } from "lucide-react";

import styles from "./LibraryPage.module.css";

type LibraryEmptyStateProps = {
  icon: LucideIcon;
  title: string;
  description: string;
  actionHref?: string;
  actionLabel?: string;
};

export function LibraryEmptyState({
  icon: Icon,
  title,
  description,
  actionHref,
  actionLabel,
}: LibraryEmptyStateProps) {
  return (
    <div className={styles.emptyState}>
      <span className={styles.emptyStateIcon} aria-hidden="true">
        <Icon size={20} />
      </span>
      <strong>{title}</strong>
      <p>{description}</p>
      {actionHref && actionLabel ? (
        <Link href={actionHref}>{actionLabel}</Link>
      ) : null}
    </div>
  );
}
