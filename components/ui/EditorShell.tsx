import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowLeft, Check, SlidersHorizontal } from "lucide-react";
import styles from "./EditorShell.module.css";

export type EditorShellProps = {
  children: ReactNode;
  albumTitle?: string;
  albumHref?: string;
  backHref?: string;
  title: string;
  titleInputName?: string;
  saveStatus?: string;
  transport?: ReactNode;
  rail?: ReactNode;
  inspector?: ReactNode;
  bottomDock?: ReactNode;
  headerActions?: ReactNode;
};

export function EditorShell({
  children,
  albumTitle = "내 앨범",
  albumHref = "/albums",
  backHref = "/",
  title,
  titleInputName = "title",
  saveStatus = "저장됨",
  transport,
  rail,
  inspector,
  bottomDock,
  headerActions,
}: EditorShellProps) {
  return (
    <main className={styles.editorShell}>
      <header className={styles.editorHeader}>
        <nav className={styles.breadcrumb} aria-label="편집기 현재 위치">
          <Link className={styles.backButton} href={backHref} aria-label="뒤로 가기">
            <ArrowLeft size={19} />
          </Link>
          <Link href={albumHref}>{albumTitle}</Link>
        </nav>

        <label className={styles.titleField}>
          <span className="sr-only">리프 제목</span>
          <input name={titleInputName} defaultValue={title} aria-label="리프 제목" />
        </label>

        <div className={styles.headerActions}>
          <span className={styles.saveStatus}>
            <Check size={13} aria-hidden="true" /> {saveStatus}
          </span>
          {headerActions}
        </div>
      </header>

      {transport ? <div className={styles.transportSlot}>{transport}</div> : null}

      <div
        className={`${styles.editorBody} ${rail ? styles.withRail : ""} ${inspector ? styles.withInspector : ""}`}
      >
        {rail ? <aside className={styles.editorRail}>{rail}</aside> : null}
        <section className={styles.editorViewport} aria-label="녹음 작업 영역">
          <div className={styles.editorCanvas}>{children}</div>
        </section>
        {inspector ? <aside className={styles.inspectorSlot}>{inspector}</aside> : null}
      </div>

      {bottomDock ? <div className={styles.bottomDock}>{bottomDock}</div> : null}
    </main>
  );
}

export type EditorPanelProps = {
  children: ReactNode;
  title: string;
  actions?: ReactNode;
  icon?: ReactNode;
  className?: string;
};

export function EditorPanel({ children, title, actions, icon, className }: EditorPanelProps) {
  return (
    <section className={`${styles.panel} ${className ?? ""}`}>
      <div className={styles.panelHeader}>
        <span className={styles.panelTitle}>
          {icon ?? <SlidersHorizontal size={15} aria-hidden="true" />}
          <strong>{title}</strong>
        </span>
        {actions ? <div className={styles.panelActions}>{actions}</div> : null}
      </div>
      <div className={styles.panelBody}>{children}</div>
    </section>
  );
}

export function EditorPanelSection({
  children,
  title,
}: {
  children: ReactNode;
  title?: string;
}) {
  return (
    <div className={styles.panelSection}>
      {title ? <h3>{title}</h3> : null}
      {children}
    </div>
  );
}

export function TrackWorkspaceFrame({
  children,
  label = "트랙",
  tools,
}: {
  children: ReactNode;
  label?: string;
  tools?: ReactNode;
}) {
  return (
    <section className={styles.trackFrame} aria-label={label}>
      {tools ? <div className={styles.trackFrameTools}>{tools}</div> : null}
      <div className={styles.trackFrameCanvas}>{children}</div>
    </section>
  );
}
