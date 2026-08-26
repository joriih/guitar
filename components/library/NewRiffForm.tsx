"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, FileMusic } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";

import {
  browserSessionStorage,
  completeClientCreateRequest,
  getOrCreateClientCreateRequest,
  type ClientCreateRequest,
} from "@/lib/client-create-request";

import styles from "./LibraryPage.module.css";

type AlbumOption = {
  id: string;
  name: string;
};

type NewRiffFormProps = {
  albums: AlbumOption[];
  defaultAlbumId?: string;
};

function errorMessage(payload: unknown): string {
  if (payload && typeof payload === "object" && "error" in payload) {
    const error = (payload as { error?: unknown }).error;
    if (typeof error === "string") return error;
  }
  return "리프를 만들지 못했어요. 다시 시도해주세요.";
}

export function NewRiffForm({ albums, defaultAlbumId }: NewRiffFormProps) {
  const router = useRouter();
  const createRequestRef = useRef<ClientCreateRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;

    const form = new FormData(event.currentTarget);
    const title = String(form.get("title") ?? "").trim();
    const selectedAlbum = String(form.get("albumId") ?? "");
    const input = { title, albumId: selectedAlbum || null };
    const intent = JSON.stringify(input);
    const storage = browserSessionStorage();
    const createRequest =
      createRequestRef.current?.intent === intent
        ? createRequestRef.current
        : getOrCreateClientCreateRequest(storage, "riff-create", intent);
    createRequestRef.current = createRequest;
    setBusy(true);
    setError(null);

    try {
      const response = await fetch("/api/riffs", {
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
      const riffId =
        payload && typeof payload === "object" && "riff" in payload
          ? (payload as { riff?: { id?: unknown } }).riff?.id
          : null;
      if (typeof riffId !== "string") throw new Error(errorMessage(null));
      completeClientCreateRequest(storage, createRequest);
      createRequestRef.current = null;
      router.push(`/riffs/${riffId}`);
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
          <FileMusic size={20} />
        </span>
        <div>
          <strong>빈 리프 노트</strong>
          <p>이름과 앨범만 정하면 바로 녹음 화면으로 이동해요.</p>
        </div>
      </div>

      <form className={styles.form} onSubmit={handleSubmit} aria-busy={busy}>
        <fieldset className={styles.formFields} disabled={busy}>
          <div className={styles.field}>
            <label htmlFor="riff-title">리프 이름</label>
            <input
              id="riff-title"
              name="title"
              type="text"
              maxLength={120}
              placeholder="예: 새벽 드라이브 인트로"
              autoFocus
              required
            />
          </div>

          <div className={styles.field}>
            <label htmlFor="riff-album">저장할 앨범</label>
            <select
              id="riff-album"
              name="albumId"
              defaultValue={defaultAlbumId ?? albums[0]?.id ?? ""}
            >
              <option value="">앨범 없이 저장</option>
              {albums.map((album) => (
                <option value={album.id} key={album.id}>
                  {album.name}
                </option>
              ))}
            </select>
            <small>앨범을 고르지 않아도 바로 시작할 수 있어요.</small>
          </div>
        </fieldset>

        {error ? <p className={styles.error} role="alert">{error}</p> : null}

        <div className={styles.formActions}>
          <Link
            className={styles.cancelButton}
            href="/"
            aria-disabled={busy}
            tabIndex={busy ? -1 : undefined}
            onClick={(event) => {
              if (busy) event.preventDefault();
            }}
          >
            취소
          </Link>
          <button className={styles.submitButton} type="submit" disabled={busy}>
            {busy ? "만드는 중…" : "리프 만들기"}
            <ArrowRight size={16} aria-hidden="true" />
          </button>
        </div>
      </form>
    </div>
  );
}
