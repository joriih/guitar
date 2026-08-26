import Link from "next/link";
import { FileQuestion, House } from "lucide-react";

import styles from "./status.module.css";

export default function NotFound() {
  return (
    <main className={styles.page}>
      <div className={styles.card}>
        <span className={styles.icon} aria-hidden="true"><FileQuestion size={23} /></span>
        <h1>이 페이지를 찾을 수 없어요</h1>
        <p>주소가 달라졌거나 휴지통으로 옮겨진 리프일 수 있어요.</p>
        <div className={styles.actions}>
          <Link className={styles.primary} href="/">
            <House size={16} aria-hidden="true" /> 홈으로 돌아가기
          </Link>
        </div>
      </div>
    </main>
  );
}
