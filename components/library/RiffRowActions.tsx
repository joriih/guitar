"use client";

import { Copy, FolderInput, MoreHorizontal, Star, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";

import styles from "@/components/ui/HomeContent.module.css";

type RiffRowActionsProps = {
  riffId: string;
  title: string;
  initialFavorite?: boolean;
  initialAlbumId?: string | null;
  initialRevision: number;
};

type AlbumOption = {
  id: string;
  name: string;
};

class RiffRevisionConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RiffRevisionConflict";
  }
}

function responseError(
  payload: unknown,
  fallback = "변경 내용을 저장하지 못했어요.",
): string {
  if (payload && typeof payload === "object") {
    const value = payload as Record<string, unknown>;
    if (typeof value.message === "string") return value.message;
    if (typeof value.error === "string") return value.error;
  }
  return fallback;
}

export function RiffRowActions({
  riffId,
  title,
  initialFavorite = false,
  initialAlbumId = null,
  initialRevision,
}: RiffRowActionsProps) {
  const router = useRouter();
  const menuId = useId();
  const menuErrorId = useId();
  const moveSelectId = useId();
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const duplicateButtonRef = useRef<HTMLButtonElement>(null);
  const duplicateRequestIdRef = useRef<string | null>(null);
  const revisionRef = useRef(initialRevision);
  const [favorite, setFavorite] = useState(initialFavorite);
  const [currentAlbumId, setCurrentAlbumId] = useState(initialAlbumId ?? "");
  const [selectedAlbumId, setSelectedAlbumId] = useState(initialAlbumId ?? "");
  const [albumOptions, setAlbumOptions] = useState<AlbumOption[] | null>(null);
  const [loadingAlbums, setLoadingAlbums] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [busyAction, setBusyAction] = useState<
    "favorite" | "move" | "duplicate" | "trash" | null
  >(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    revisionRef.current = initialRevision;
  }, [initialRevision]);

  useEffect(() => {
    if (!menuOpen) return;
    duplicateButtonRef.current?.focus();
    function handlePointerDown(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    }
    function handleKeydown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setMenuOpen(false);
      menuButtonRef.current?.focus();
    }
    document.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeydown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeydown);
    };
  }, [menuOpen]);

  async function patchRiff(body: Record<string, unknown>) {
    const response = await fetch(`/api/riffs/${riffId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, expectedRevision: revisionRef.current }),
    });
    const payload: unknown = await response.json().catch(() => null);
    const record =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : null;
    const rawRiff = response.status === 409 ? record?.current : record?.riff;
    const riff =
      rawRiff && typeof rawRiff === "object" && !Array.isArray(rawRiff)
        ? (rawRiff as Record<string, unknown>)
        : null;
    if (riff && typeof riff.revision === "number" && Number.isInteger(riff.revision)) {
      revisionRef.current = riff.revision;
    }
    if (!response.ok) {
      if (response.status === 409 && riff) {
        if (typeof riff.isFavorite === "boolean") setFavorite(riff.isFavorite);
        if (typeof riff.albumId === "string" || riff.albumId === null) {
          const nextAlbumId = typeof riff.albumId === "string" ? riff.albumId : "";
          setCurrentAlbumId(nextAlbumId);
          setSelectedAlbumId(nextAlbumId);
        }
        const alreadyApplied = Object.entries(body).every(([key, expected]) => {
          if (key === "trashed") return Boolean(riff.deletedAt) === expected;
          return riff[key] === expected;
        });
        if (alreadyApplied) return;
        router.refresh();
        throw new RiffRevisionConflict(
          "다른 창에서 이 리프가 변경됐어요. 최신 내용을 반영했으니 다시 시도해 주세요.",
        );
      }
      throw new Error(responseError(payload));
    }
  }

  async function loadAlbums() {
    if (albumOptions !== null || loadingAlbums) return;
    setLoadingAlbums(true);
    setError(null);
    try {
      const response = await fetch("/api/albums", { cache: "no-store" });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(responseError(payload));
      if (!payload || typeof payload !== "object" || !("albums" in payload)) {
        throw new Error("앨범 목록을 불러오지 못했어요.");
      }
      const rawAlbums = (payload as { albums?: unknown }).albums;
      if (!Array.isArray(rawAlbums)) throw new Error("앨범 목록을 불러오지 못했어요.");
      const albums = rawAlbums.flatMap((album): AlbumOption[] => {
        if (!album || typeof album !== "object") return [];
        const { id, name } = album as { id?: unknown; name?: unknown };
        return typeof id === "string" && typeof name === "string" ? [{ id, name }] : [];
      });
      setAlbumOptions(albums);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "앨범 목록을 불러오지 못했어요.");
    } finally {
      setLoadingAlbums(false);
    }
  }

  function toggleMenu() {
    const nextOpen = !menuOpen;
    setMenuOpen(nextOpen);
    if (nextOpen) {
      setError(null);
      void loadAlbums();
    }
  }

  async function toggleFavorite() {
    if (busyAction) return;
    const nextFavorite = !favorite;
    setFavorite(nextFavorite);
    setBusyAction("favorite");
    setError(null);
    try {
      await patchRiff({ isFavorite: nextFavorite });
      router.refresh();
    } catch (caught) {
      if (!(caught instanceof RiffRevisionConflict)) setFavorite(!nextFavorite);
      setError(caught instanceof Error ? caught.message : responseError(null));
    } finally {
      setBusyAction(null);
    }
  }

  async function moveToTrash() {
    if (busyAction) return;
    setBusyAction("trash");
    setError(null);
    try {
      await patchRiff({ trashed: true });
      setMenuOpen(false);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : responseError(null));
      setBusyAction(null);
    }
  }

  async function moveRiff() {
    if (busyAction || selectedAlbumId === currentAlbumId) return;
    setBusyAction("move");
    setError(null);
    try {
      await patchRiff({ albumId: selectedAlbumId || null });
      setCurrentAlbumId(selectedAlbumId);
      setMenuOpen(false);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : responseError(null));
    } finally {
      setBusyAction(null);
    }
  }

  async function duplicateRiff() {
    if (busyAction) return;
    setBusyAction("duplicate");
    setError(null);
    try {
      const storageKey = `riff-sketchbook:duplicate-request:${riffId}`;
      if (!duplicateRequestIdRef.current) {
        try {
          const stored = window.sessionStorage.getItem(storageKey);
          if (
            stored &&
            /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
              stored,
            )
          ) {
            duplicateRequestIdRef.current = stored;
          } else if (stored) {
            window.sessionStorage.removeItem(storageKey);
          }
        } catch {
          // The in-memory key below still protects retries in this page session.
        }
      }
      const requestId = duplicateRequestIdRef.current ?? crypto.randomUUID();
      duplicateRequestIdRef.current = requestId;
      try {
        window.sessionStorage.setItem(storageKey, requestId);
      } catch {
        // The request keeps the same in-memory key while this component lives.
      }
      const response = await fetch(`/api/riffs/${riffId}/duplicate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        if (response.status === 409) {
          duplicateRequestIdRef.current = null;
          try {
            window.sessionStorage.removeItem(storageKey);
          } catch {
            // The next click will still create a fresh in-memory request key.
          }
        }
        throw new Error(responseError(payload, "리프를 복제하지 못했어요."));
      }
      const duplicatedId =
        payload && typeof payload === "object" && "riff" in payload
          ? (payload as { riff?: { id?: unknown } }).riff?.id
          : null;
      if (typeof duplicatedId !== "string") {
        throw new Error("복제된 리프를 열지 못했어요.");
      }
      duplicateRequestIdRef.current = null;
      try {
        window.sessionStorage.removeItem(storageKey);
      } catch {
        // The server already completed the idempotent operation.
      }
      setMenuOpen(false);
      router.push(`/riffs/${duplicatedId}`);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "리프를 복제하지 못했어요.");
      setBusyAction(null);
      requestAnimationFrame(() => duplicateButtonRef.current?.focus());
    }
  }

  return (
    <div className={styles.riffActions}>
      <button
        className={`${styles.favoriteButton} ${favorite ? styles.favoriteActive : ""}`}
        type="button"
        onClick={toggleFavorite}
        disabled={Boolean(busyAction)}
        aria-label={favorite ? `${title} 즐겨찾기 해제` : `${title} 즐겨찾기 추가`}
        aria-pressed={favorite}
        title={favorite ? "즐겨찾기 해제" : "즐겨찾기 추가"}
      >
        <Star size={15} fill={favorite ? "currentColor" : "none"} aria-hidden="true" />
      </button>

      <div className={`${styles.rowMenu} ${menuOpen ? styles.rowMenuOpen : ""}`} ref={menuRef}>
        <button
          ref={menuButtonRef}
          className={styles.menuButton}
          type="button"
          onClick={toggleMenu}
          aria-label={`${title} 더보기`}
          aria-expanded={menuOpen}
          aria-controls={menuId}
          title="더보기"
        >
          <MoreHorizontal size={18} aria-hidden="true" />
        </button>
        {menuOpen ? (
          <div className={styles.rowMenuPanel} id={menuId} role="group" aria-label={`${title} 작업`}>
            <div className={styles.moveRiffSection}>
              <label htmlFor={moveSelectId}>
                <FolderInput size={14} aria-hidden="true" /> 앨범 이동
              </label>
              {loadingAlbums ? (
                <p className={styles.menuStatus} aria-live="polite">앨범 불러오는 중…</p>
              ) : albumOptions ? (
                <div className={styles.moveRiffControls}>
                  <select
                    id={moveSelectId}
                    value={selectedAlbumId}
                    onChange={(event) => setSelectedAlbumId(event.target.value)}
                    disabled={Boolean(busyAction)}
                  >
                    <option value="">분류되지 않음</option>
                    {albumOptions.map((album) => (
                      <option value={album.id} key={album.id}>{album.name}</option>
                    ))}
                  </select>
                  <button
                    className={styles.moveRiffButton}
                    type="button"
                    onClick={moveRiff}
                    disabled={Boolean(busyAction) || selectedAlbumId === currentAlbumId}
                  >
                    {busyAction === "move" ? "이동 중…" : "이동"}
                  </button>
                </div>
              ) : (
                <button className={styles.retryAlbumsButton} type="button" onClick={loadAlbums}>
                  다시 불러오기
                </button>
              )}
            </div>
            <button
              ref={duplicateButtonRef}
              className={styles.duplicateMenuButton}
              type="button"
              onClick={duplicateRiff}
              disabled={Boolean(busyAction)}
              aria-busy={busyAction === "duplicate"}
              aria-describedby={error ? menuErrorId : undefined}
            >
              <Copy size={15} aria-hidden="true" />
              {busyAction === "duplicate" ? "복제하는 중…" : "리프 복제"}
            </button>
            <button
              className={styles.trashMenuButton}
              type="button"
              onClick={moveToTrash}
              disabled={Boolean(busyAction)}
            >
              <Trash2 size={15} aria-hidden="true" />
              {busyAction === "trash" ? "이동 중…" : "휴지통으로 이동"}
            </button>
            {error ? <p className={styles.menuError} id={menuErrorId} role="alert">{error}</p> : null}
          </div>
        ) : null}
      </div>
      {error && !menuOpen ? <span className={styles.actionError} role="alert">{error}</span> : null}
    </div>
  );
}
