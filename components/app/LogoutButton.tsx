"use client";

import { LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";

type LogoutButtonProps = {
  className?: string;
  errorClassName?: string;
};

export function LogoutButton({ className, errorClassName }: LogoutButtonProps) {
  const router = useRouter();
  const errorId = useId();
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function logout() {
    if (isBusy) return;
    setIsBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      if (!response.ok) throw new Error("로그아웃하지 못했어요.");
      router.replace("/login");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "로그아웃하지 못했어요.");
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <>
      <button
        className={className}
        type="button"
        onClick={logout}
        disabled={isBusy}
        aria-label={isBusy ? "로그아웃 중" : "로그아웃"}
        aria-describedby={error ? errorId : undefined}
        title="로그아웃"
      >
        <LogOut size={17} aria-hidden="true" />
      </button>
      {error ? (
        <span className={errorClassName} id={errorId} role="alert">
          {error}
        </span>
      ) : null}
    </>
  );
}
