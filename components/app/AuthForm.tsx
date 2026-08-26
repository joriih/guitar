"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { GuitarCaseAuth } from "@/components/ui/GuitarCaseAuth";
import {
  DEFAULT_ACCOUNT_DISPLAY_NAME,
  DEFAULT_ACCOUNT_USERNAME,
} from "@/lib/account-defaults";

type AuthFormProps = {
  mode: "login" | "setup";
  defaultUsername?: string;
};

function getErrorMessage(payload: unknown): string {
  if (payload && typeof payload === "object") {
    const value = payload as Record<string, unknown>;
    if (typeof value.message === "string") return value.message;
    if (typeof value.error === "string") return value.error;
  }
  return "잠시 문제가 생겼어요. 다시 시도해주세요.";
}

export function AuthForm({
  mode,
  defaultUsername = DEFAULT_ACCOUNT_USERNAME,
}: AuthFormProps) {
  const router = useRouter();
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isBusy) return;

    const form = new FormData(event.currentTarget);
    const username = String(form.get("username") ?? defaultUsername).trim();
    const password = String(form.get("password") ?? "");
    const remember = form.get("remember") === "on";
    const body =
      mode === "setup"
        ? {
            username,
            displayName: DEFAULT_ACCOUNT_DISPLAY_NAME,
            password,
            remember,
          }
        : { password, remember };

    setIsBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(getErrorMessage(payload));

      router.replace("/");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : getErrorMessage(null));
      setIsBusy(false);
    }
  }

  return (
    <GuitarCaseAuth
      mode={mode}
      defaultUsername={defaultUsername}
      error={error}
      isBusy={isBusy}
      onSubmit={handleSubmit}
    />
  );
}
