"use client";

import { ArrowRight, FolderPen } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { AlbumCoverPicker } from "./AlbumCoverPicker";
import styles from "./LibraryPage.module.css";

type EditAlbumFormProps = {
  album: {
    id: string;
    name: string;
    description: string;
    color: string;
    coverAsset: string | null;
    revision: number;
  };
};

type AlbumDraft = Pick<
  EditAlbumFormProps["album"],
  "name" | "description" | "color" | "coverAsset"
>;

type AlbumVersion = AlbumDraft & { revision: number };

function toDraft(album: AlbumVersion): AlbumDraft {
  return {
    name: album.name,
    description: album.description,
    color: album.color,
    coverAsset: album.coverAsset,
  };
}

function conflictVersion(payload: unknown): AlbumVersion | null {
  if (!payload || typeof payload !== "object" || !("current" in payload)) return null;
  const current = (payload as { current?: unknown }).current;
  if (!current || typeof current !== "object") return null;
  const value = current as Record<string, unknown>;
  if (
    typeof value.name !== "string" ||
    typeof value.description !== "string" ||
    typeof value.color !== "string" ||
    (value.coverAsset !== null && typeof value.coverAsset !== "string") ||
    typeof value.revision !== "number"
  ) {
    return null;
  }
  return {
    name: value.name,
    description: value.description,
    color: value.color,
    coverAsset: value.coverAsset,
    revision: value.revision,
  };
}

function errorMessage(payload: unknown): string {
  if (payload && typeof payload === "object" && "error" in payload) {
    const value = (payload as { error?: unknown }).error;
    if (typeof value === "string") return value;
  }
  return "앨범을 수정하지 못했어요. 다시 시도해주세요.";
}

export function EditAlbumForm({ album }: EditAlbumFormProps) {
  const router = useRouter();
  const [draft, setDraft] = useState<AlbumDraft>(() => toDraft(album));
  const [revision, setRevision] = useState(album.revision);
  const [conflict, setConflict] = useState<AlbumVersion | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function saveDraft(nextDraft: AlbumDraft, expectedRevision: number) {
    if (busy) return;
    setBusy(true);
    setError(null);

    try {
      const response = await fetch(`/api/albums/${album.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...nextDraft,
          name: nextDraft.name.trim(),
          description: nextDraft.description.trim(),
          expectedRevision,
        }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (response.status === 409) {
        const current = conflictVersion(payload);
        if (!current) throw new Error(errorMessage(payload));
        setConflict(current);
        setBusy(false);
        return;
      }
      if (!response.ok) throw new Error(errorMessage(payload));
      router.push(`/albums/${album.id}`);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : errorMessage(null));
      setBusy(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (conflict) return;
    await saveDraft(draft, revision);
  }

  function useServerVersion() {
    if (!conflict || busy) return;
    setDraft(toDraft(conflict));
    setRevision(conflict.revision);
    setConflict(null);
    setError(null);
  }

  async function keepMyVersion() {
    if (!conflict || busy) return;
    await saveDraft(draft, conflict.revision);
  }

  return (
    <div className={styles.formCard}>
      <div className={styles.formIntro}>
        <span className={styles.formIcon} aria-hidden="true">
          <FolderPen size={20} />
        </span>
        <div>
          <strong>앨범 정보</strong>
          <p>폴더 이름과 메모, 기타 커버를 바꿀 수 있어요.</p>
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
              value={draft.name}
              onChange={(event) =>
                setDraft((current) => ({ ...current, name: event.target.value }))
              }
              autoFocus
              required
            />
          </div>

          <div className={styles.field}>
            <label htmlFor="album-description">짧은 메모</label>
            <textarea
              id="album-description"
              name="description"
              maxLength={500}
              value={draft.description}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  description: event.target.value,
                }))
              }
              rows={4}
              placeholder="앨범의 분위기나 목표를 적어두세요"
            />
          </div>

          <input name="color" type="hidden" value={draft.color} readOnly />

          <AlbumCoverPicker
            value={draft.coverAsset}
            onChange={(coverAsset) =>
              setDraft((current) => ({ ...current, coverAsset }))
            }
            includeAutomatic
            disabled={busy}
          />
        </fieldset>

        {conflict ? (
          <div className={styles.conflictNotice} role="alert">
            <strong>다른 창에서 이 앨범이 먼저 변경됐어요.</strong>
            <p>
              서버의 최신 내용을 불러오거나, 지금 입력한 내용으로 저장할 수 있어요.
            </p>
            <div className={styles.conflictActions}>
              <button type="button" onClick={useServerVersion} disabled={busy}>
                서버 내용 사용
              </button>
              <button
                className={styles.conflictPrimary}
                type="button"
                onClick={keepMyVersion}
                disabled={busy}
              >
                {busy ? "저장하는 중…" : "내 내용으로 저장"}
              </button>
            </div>
          </div>
        ) : null}

        {error ? <p className={styles.error} role="alert">{error}</p> : null}

        <div className={styles.formActions}>
          <Link
            className={styles.cancelButton}
            href={`/albums/${album.id}`}
            aria-disabled={busy}
            tabIndex={busy ? -1 : undefined}
            onClick={(event) => {
              if (busy) event.preventDefault();
            }}
          >
            취소
          </Link>
          <button
            className={styles.submitButton}
            type="submit"
            disabled={busy || Boolean(conflict)}
          >
            {busy ? "저장하는 중…" : "변경 내용 저장"}
            <ArrowRight size={16} aria-hidden="true" />
          </button>
        </div>
      </form>
    </div>
  );
}
