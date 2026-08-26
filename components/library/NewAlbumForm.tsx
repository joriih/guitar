"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, FolderPlus } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";

import {
  browserSessionStorage,
  completeClientCreateRequest,
  getOrCreateClientCreateRequest,
  type ClientCreateRequest,
} from "@/lib/client-create-request";

import { AlbumCoverPicker } from "./AlbumCoverPicker";
import styles from "./LibraryPage.module.css";

function errorMessage(payload: unknown): string {
  if (payload && typeof payload === "object" && "error" in payload) {
    const value = (payload as { error?: unknown }).error;
    if (typeof value === "string") return value;
  }
  return "앨범을 만들지 못했어요. 다시 시도해주세요.";
}

export function NewAlbumForm() {
  const router = useRouter();
  const createRequestRef = useRef<ClientCreateRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const input = {
      name: String(form.get("name") ?? "").trim(),
      description: String(form.get("description") ?? "").trim(),
      color: String(form.get("color") ?? "#FFFFFF"),
      coverAsset: String(form.get("coverAsset") ?? "") || null,
    };
    const intent = JSON.stringify(input);
    const storage = browserSessionStorage();
    const createRequest =
      createRequestRef.current?.intent === intent
        ? createRequestRef.current
        : getOrCreateClientCreateRequest(storage, "album-create", intent);
    createRequestRef.current = createRequest;
    setBusy(true);
    setError(null);

    try {
      const response = await fetch("/api/albums", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...input,
          requestId: createRequest.requestId,
        }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        if (response.status === 409) {
          completeClientCreateRequest(storage, createRequest);
          createRequestRef.current = null;
        }
        throw new Error(errorMessage(payload));
      }
      const albumId =
        payload && typeof payload === "object" && "album" in payload
          ? (payload as { album?: { id?: unknown } }).album?.id
          : null;
      if (typeof albumId !== "string") throw new Error(errorMessage(null));
      completeClientCreateRequest(storage, createRequest);
      createRequestRef.current = null;
      router.push(`/albums/${albumId}`);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : errorMessage(null));
      setBusy(false);
    }
  }

  return (
    <div className={styles.formCard}>
      <div className={styles.formIntro}>
        <span className={styles.formIcon} aria-hidden="true">
          <FolderPlus size={20} />
        </span>
        <div>
          <strong>새 앨범 폴더</strong>
          <p>같은 분위기의 리프와 기타 커버를 한곳에 모아보세요.</p>
        </div>
      </div>

      <form className={styles.form} onSubmit={handleSubmit} aria-busy={busy}>
        <fieldset className={styles.formFields} disabled={busy}>
          <div className={styles.field}>
            <label htmlFor="album-name">앨범 이름</label>
            <input
              id="album-name"
              name="name"
              type="text"
              maxLength={80}
              placeholder="예: Night Drive"
              autoFocus
              required
            />
          </div>

          <div className={styles.field}>
            <label htmlFor="album-description">짧은 메모</label>
            <input
              id="album-description"
              name="description"
              type="text"
              maxLength={500}
              placeholder="앨범의 분위기나 목표를 적어두세요"
            />
          </div>

          <input name="color" type="hidden" value="#FFFFFF" readOnly />

          <AlbumCoverPicker disabled={busy} />
        </fieldset>

        {error ? <p className={styles.error} role="alert">{error}</p> : null}

        <div className={styles.formActions}>
          <Link
            className={styles.cancelButton}
            href="/albums"
            aria-disabled={busy}
            tabIndex={busy ? -1 : undefined}
            onClick={(event) => {
              if (busy) event.preventDefault();
            }}
          >
            취소
          </Link>
          <button className={styles.submitButton} type="submit" disabled={busy}>
            {busy ? "만드는 중…" : "앨범 만들기"}
            <ArrowRight size={16} aria-hidden="true" />
          </button>
        </div>
      </form>
    </div>
  );
}
