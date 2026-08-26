"use client";

import { RotateCcw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import styles from "@/components/ui/HomeContent.module.css";

export function RestoreRiffButton({
  riffId,
  title,
  revision,
}: {
  riffId: string;
  title: string;
  revision: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revisionRef = useRef(revision);

  useEffect(() => {
    revisionRef.current = revision;
  }, [revision]);

  async function restore() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/riffs/${riffId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trashed: false, expectedRevision: revisionRef.current }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        if (
          response.status === 409 &&
          payload &&
          typeof payload === "object" &&
          "current" in payload
        ) {
          const current = (payload as { current?: unknown }).current;
          if (
            current &&
            typeof current === "object" &&
            "revision" in current &&
            typeof (current as { revision?: unknown }).revision === "number"
          ) {
            revisionRef.current = (current as { revision: number }).revision;
          }
          router.refresh();
          if (
            current &&
            typeof current === "object" &&
            "deletedAt" in current &&
            (current as { deletedAt?: unknown }).deletedAt === null
          ) {
            return;
          }
        }
        const message =
          payload && typeof payload === "object" && "error" in payload
            ? String((payload as { error: unknown }).error)
            : "복원하지 못했어요.";
        throw new Error(message);
      }
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "복원하지 못했어요.");
      setBusy(false);
    }
  }

  return (
    <div className={styles.restoreAction}>
      <button type="button" onClick={restore} disabled={busy} aria-label={`${title} 복원`}>
        <RotateCcw size={15} aria-hidden="true" />
        <span>{busy ? "복원 중…" : "복원"}</span>
      </button>
      {error ? <span role="alert">{error}</span> : null}
    </div>
  );
}
