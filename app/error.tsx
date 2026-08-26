"use client";

import Link from "next/link";
import { House, RefreshCw, TriangleAlert } from "lucide-react";
import { useEffect } from "react";

import styles from "./status.module.css";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className={styles.page}>
      <div className={styles.card} role="alert">
        <span className={styles.icon} aria-hidden="true"><TriangleAlert size={23} /></span>
        <h1>페이지를 불러오지 못했어요</h1>
        <p>잠시 후 다시 시도해 주세요. 작업 중이던 녹음은 복구 보관함에 남아 있을 수 있어요.</p>
        <div className={styles.actions}>
          <button className={styles.primary} type="button" onClick={reset}>
            <RefreshCw size={16} aria-hidden="true" /> 다시 시도
          </button>
          <Link className={styles.secondary} href="/">
            <House size={16} aria-hidden="true" /> 홈
          </Link>
        </div>
      </div>
    </main>
  );
}
