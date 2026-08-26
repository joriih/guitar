import styles from "./status.module.css";

export default function Loading() {
  return (
    <main className={styles.page} aria-busy="true" aria-live="polite">
      <div className={styles.card}>
        <div className={styles.loadingBars} aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <p>스케치북을 여는 중…</p>
      </div>
    </main>
  );
}
