"use client";

import { Hash, Plus, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import { MAX_TAG_NAME_LENGTH, MAX_TAGS_PER_RIFF } from "@/lib/tags";
import type { Tag } from "@/types/domain";

import styles from "./RiffTagEditor.module.css";

type RiffTagEditorProps = {
  riffId: string;
  initialTags: Tag[];
  className?: string;
};

function responseError(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object") {
    const value = payload as { error?: unknown; message?: unknown };
    if (typeof value.error === "string") return value.error;
    if (typeof value.message === "string") return value.message;
  }
  return fallback;
}

function parseTags(payload: unknown): Tag[] | null {
  if (!payload || typeof payload !== "object" || !("tags" in payload)) return null;
  const rawTags = (payload as { tags?: unknown }).tags;
  if (!Array.isArray(rawTags)) return null;
  return rawTags.flatMap((tag): Tag[] => {
    if (!tag || typeof tag !== "object") return [];
    const { id, name } = tag as { id?: unknown; name?: unknown };
    return typeof id === "string" && typeof name === "string" ? [{ id, name }] : [];
  });
}

export function RiffTagEditor({ riffId, initialTags, className }: RiffTagEditorProps) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const suggestionsId = useId();
  const [tags, setTags] = useState(initialTags);
  const [suggestions, setSuggestions] = useState<Tag[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<"add" | string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/tags", {
      cache: "no-store",
      credentials: "include",
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload: unknown = await response.json().catch(() => null);
        if (!response.ok) throw new Error(responseError(payload, "태그 목록을 불러오지 못했어요."));
        const nextTags = parseTags(payload);
        if (nextTags) setSuggestions(nextTags);
      })
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        // Suggestions are optional; adding and removing tags remain available.
      });
    return () => controller.abort();
  }, []);

  async function addTag(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !draft.trim() || tags.length >= MAX_TAGS_PER_RIFF) return;
    setBusy("add");
    setError(null);
    try {
      const response = await fetch(`/api/riffs/${encodeURIComponent(riffId)}/tags`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: draft }),
        credentials: "include",
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(responseError(payload, "태그를 추가하지 못했어요."));
      const nextTags = parseTags(payload);
      if (!nextTags) throw new Error("태그를 추가했지만 목록을 갱신하지 못했어요.");
      setTags(nextTags);
      setSuggestions((current) => {
        const added = nextTags.find((tag) => !current.some((item) => item.id === tag.id));
        return added ? [...current, added] : current;
      });
      setDraft("");
      router.refresh();
      inputRef.current?.focus();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "태그를 추가하지 못했어요.");
    } finally {
      setBusy(null);
    }
  }

  async function removeTag(tag: Tag) {
    if (busy) return;
    setBusy(tag.id);
    setError(null);
    try {
      const response = await fetch(
        `/api/riffs/${encodeURIComponent(riffId)}/tags/${encodeURIComponent(tag.id)}`,
        { method: "DELETE", credentials: "include" },
      );
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(responseError(payload, "태그를 제거하지 못했어요."));
      const nextTags = parseTags(payload);
      if (!nextTags) throw new Error("태그를 제거했지만 목록을 갱신하지 못했어요.");
      setTags(nextTags);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "태그를 제거하지 못했어요.");
    } finally {
      setBusy(null);
    }
  }

  const currentTagNames = new Set(tags.map((tag) => tag.name.toLocaleLowerCase("ko-KR")));
  const availableSuggestions = suggestions.filter(
    (tag) => !currentTagNames.has(tag.name.toLocaleLowerCase("ko-KR")),
  );
  const atLimit = tags.length >= MAX_TAGS_PER_RIFF;

  return (
    <section className={`${styles.editor} ${className ?? ""}`} aria-labelledby={hintId}>
      <div className={styles.heading}>
        <span className={styles.label} id={hintId}>
          <Hash size={14} aria-hidden="true" /> 태그
        </span>
        <span className={styles.count}>{tags.length}/{MAX_TAGS_PER_RIFF}</span>
      </div>

      <div className={styles.content}>
        {tags.length ? (
          <ul className={styles.tags} aria-label="이 리프의 태그">
            {tags.map((tag) => (
              <li key={tag.id}>
                <span>#{tag.name}</span>
                <button
                  type="button"
                  onClick={() => void removeTag(tag)}
                  disabled={Boolean(busy)}
                  aria-label={`${tag.name} 태그 제거`}
                  title="태그 제거"
                >
                  <X size={12} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.empty}>아직 태그가 없어요.</p>
        )}

        <form className={styles.form} onSubmit={addTag} aria-busy={busy === "add"}>
          <label className={styles.srOnly} htmlFor={`${hintId}-input`}>태그 추가</label>
          <input
            ref={inputRef}
            id={`${hintId}-input`}
            list={availableSuggestions.length ? suggestionsId : undefined}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            maxLength={MAX_TAG_NAME_LENGTH + 1}
            placeholder={atLimit ? "태그를 모두 사용했어요" : "태그 추가"}
            autoComplete="off"
            disabled={Boolean(busy) || atLimit}
          />
          {availableSuggestions.length ? (
            <datalist id={suggestionsId}>
              {availableSuggestions.map((tag) => <option value={tag.name} key={tag.id} />)}
            </datalist>
          ) : null}
          <button type="submit" disabled={Boolean(busy) || atLimit || !draft.trim()}>
            <Plus size={14} aria-hidden="true" />
            <span>{busy === "add" ? "추가 중…" : "추가"}</span>
          </button>
        </form>
      </div>

      {error ? <p className={styles.error} role="alert">{error}</p> : null}
    </section>
  );
}
