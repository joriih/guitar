"use client";

import { Menu, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type MouseEvent, type ReactNode } from "react";

import styles from "./AppShell.module.css";

export function MobileNavigationMenu({ children }: { children: ReactNode }) {
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const firstTarget = panelRef.current?.querySelector<HTMLElement>("a, button");
    firstTarget?.focus();

    function handleKeydown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
        return;
      }
      if (event.key !== "Tab") return;
      const targets = Array.from(
        panelRef.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
      if (!targets.length) return;
      const first = targets[0];
      const last = targets[targets.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", handleKeydown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeydown);
    };
  }, [open]);

  function closeAfterNavigation(event: MouseEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest("a[href]")) setOpen(false);
  }

  return (
    <div className={styles.mobileMenu}>
      <button
        ref={triggerRef}
        className={styles.mobileMenuTrigger}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={open ? "메뉴 닫기" : "메뉴 열기"}
      >
        {open ? <X size={20} aria-hidden="true" /> : <Menu size={20} aria-hidden="true" />}
      </button>
      {open ? (
        <>
          <button
            className={styles.mobileMenuBackdrop}
            type="button"
            onClick={() => setOpen(false)}
            aria-label="메뉴 바깥 영역 닫기"
            tabIndex={-1}
          />
          <div
            className={styles.mobileMenuPanel}
            id={panelId}
            ref={panelRef}
            onClick={closeAfterNavigation}
            role="dialog"
            aria-modal="true"
            aria-label="라이브러리 메뉴"
          >
            {children}
          </div>
        </>
      ) : null}
    </div>
  );
}
