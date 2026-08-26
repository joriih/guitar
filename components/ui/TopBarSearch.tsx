"use client";

import { Search } from "lucide-react";
import { useEffect, useId, useRef } from "react";

import styles from "./AppShell.module.css";

type TopBarSearchProps = {
  action: string;
  defaultValue?: string;
  placeholder: string;
};

export function TopBarSearch({ action, defaultValue, placeholder }: TopBarSearchProps) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    }
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, []);

  return (
    <form className={styles.search} action={action} method="get" role="search">
      <button className={styles.searchSubmit} type="submit" aria-label="검색">
        <Search size={18} strokeWidth={1.8} aria-hidden="true" />
      </button>
      <label className="sr-only" htmlFor={inputId}>라이브러리 검색</label>
      <input
        id={inputId}
        ref={inputRef}
        name="q"
        type="search"
        defaultValue={defaultValue}
        placeholder={placeholder}
        enterKeyHint="search"
      />
      <kbd aria-hidden="true">⌘ K</kbd>
    </form>
  );
}
