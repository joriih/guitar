"use client";

import { CheckCircle2, KeyRound, LoaderCircle, ShieldCheck, UserRound } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";

import {
  browserSessionStorage,
  completeClientCreateRequest,
  getOrCreateClientCreateRequest,
  type ClientCreateRequest,
} from "@/lib/client-create-request";

import styles from "./SettingsPage.module.css";

type SettingsFormProps = {
  initialUser: {
    username: string;
    displayName: string;
    revision: number;
  };
};

type Feedback = { kind: "success" | "error"; message: string } | null;
type ProfileSnapshot = SettingsFormProps["initialUser"];

function profileSnapshot(payload: unknown, key: "user" | "current"): ProfileSnapshot | null {
  if (!payload || typeof payload !== "object") return null;
  const candidate = (payload as Record<string, unknown>)[key];
  if (!candidate || typeof candidate !== "object") return null;
  const value = candidate as Record<string, unknown>;
  return typeof value.username === "string" &&
    typeof value.displayName === "string" &&
    typeof value.revision === "number" &&
    Number.isInteger(value.revision) &&
    value.revision >= 0
    ? {
        username: value.username,
        displayName: value.displayName,
        revision: value.revision,
      }
    : null;
}

function responseMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== "object") return fallback;
  const value = payload as Record<string, unknown>;
  if (Array.isArray(value.issues)) {
    const firstIssue = value.issues.find(
      (issue) =>
        issue &&
        typeof issue === "object" &&
        typeof (issue as { message?: unknown }).message === "string",
    ) as { message?: string } | undefined;
    if (firstIssue?.message) return firstIssue.message;
  }
  return typeof value.error === "string" ? value.error : fallback;
}

function FeedbackMessage({ feedback, id }: { feedback: Feedback; id: string }) {
  if (!feedback) return null;
  return (
    <p
      className={feedback.kind === "error" ? styles.errorMessage : styles.successMessage}
      id={id}
      role={feedback.kind === "error" ? "alert" : "status"}
    >
      {feedback.kind === "success" ? <CheckCircle2 size={15} aria-hidden="true" /> : null}
      <span>{feedback.message}</span>
    </p>
  );
}

export function SettingsForm({ initialUser }: SettingsFormProps) {
  const router = useRouter();
  const passwordRequestRef = useRef<ClientCreateRequest | null>(null);
  const profileBaselineRef = useRef<ProfileSnapshot>(initialUser);
  const [username, setUsername] = useState(initialUser.username);
  const [displayName, setDisplayName] = useState(initialUser.displayName);
  const [profileRevision, setProfileRevision] = useState(initialUser.revision);
  const [profileBusy, setProfileBusy] = useState(false);
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [profileFeedback, setProfileFeedback] = useState<Feedback>(null);
  const [passwordFeedback, setPasswordFeedback] = useState<Feedback>(null);

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (profileBusy) return;
    setProfileBusy(true);
    setProfileFeedback(null);
    try {
      const response = await fetch("/api/account/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ username, displayName, expectedRevision: profileRevision }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (response.status === 409) {
        const current = profileSnapshot(payload, "current");
        if (current) {
          const baseline = profileBaselineRef.current;
          setUsername((value) => value === baseline.username ? current.username : value);
          setDisplayName((value) =>
            value === baseline.displayName ? current.displayName : value,
          );
          setProfileRevision(current.revision);
          profileBaselineRef.current = current;
          setProfileFeedback({
            kind: "error",
            message:
              "다른 창의 변경을 반영했어요. 현재 입력을 확인한 뒤 다시 저장해주세요.",
          });
          return;
        }
      }
      if (!response.ok) {
        throw new Error(responseMessage(payload, "사용자 정보를 저장하지 못했어요."));
      }
      const saved = profileSnapshot(payload, "user");
      if (!saved) throw new Error("저장된 사용자 정보를 확인하지 못했어요.");
      setUsername(saved.username);
      setDisplayName(saved.displayName);
      setProfileRevision(saved.revision);
      profileBaselineRef.current = saved;
      setProfileFeedback({ kind: "success", message: "사용자 정보를 저장했어요." });
      router.refresh();
    } catch (error) {
      setProfileFeedback({
        kind: "error",
        message: error instanceof Error ? error.message : "사용자 정보를 저장하지 못했어요.",
      });
    } finally {
      setProfileBusy(false);
    }
  }

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (passwordBusy) return;
    const form = event.currentTarget;
    const formData = new FormData(form);
    const input = {
      currentPassword: String(formData.get("currentPassword") ?? ""),
      newPassword: String(formData.get("newPassword") ?? ""),
      confirmPassword: String(formData.get("confirmPassword") ?? ""),
    };
    const storage = browserSessionStorage();
    const passwordRequest =
      passwordRequestRef.current ??
      getOrCreateClientCreateRequest(
        storage,
        "password-change",
        "password-change:v1",
      );
    passwordRequestRef.current = passwordRequest;
    setPasswordBusy(true);
    setPasswordFeedback(null);
    try {
      const response = await fetch("/api/account/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          ...input,
          requestId: passwordRequest.requestId,
        }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        if (response.status === 410) {
          completeClientCreateRequest(storage, passwordRequest);
          passwordRequestRef.current = null;
        }
        throw new Error(responseMessage(payload, "비밀번호를 변경하지 못했어요."));
      }
      completeClientCreateRequest(storage, passwordRequest);
      passwordRequestRef.current = null;
      form.reset();
      setPasswordFeedback({
        kind: "success",
        message: "비밀번호를 바꾸고 다른 로그인 세션을 모두 종료했어요.",
      });
      router.refresh();
    } catch (error) {
      setPasswordFeedback({
        kind: "error",
        message: error instanceof Error ? error.message : "비밀번호를 변경하지 못했어요.",
      });
    } finally {
      setPasswordBusy(false);
    }
  }

  return (
    <div className={styles.cards}>
      <section className={styles.card} aria-labelledby="profile-settings-title">
        <div className={styles.cardHeading}>
          <span className={styles.cardIcon} aria-hidden="true">
            <UserRound size={19} />
          </span>
          <div>
            <h2 id="profile-settings-title">사용자 정보</h2>
            <p>사이드바와 스케치북에 표시할 이름을 정해요.</p>
          </div>
        </div>

        <form className={styles.form} onSubmit={saveProfile} aria-busy={profileBusy}>
          <fieldset className={styles.formFields} disabled={profileBusy}>
            <div className={styles.twoColumns}>
              <label className={styles.field}>
                <span>표시 이름</span>
                <input
                  name="displayName"
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  autoComplete="name"
                  maxLength={40}
                  required
                  aria-describedby={
                    profileFeedback ? "profile-feedback" : undefined
                  }
                />
              </label>
              <div className={styles.field}>
                <label htmlFor="settings-username">사용자 이름</label>
                <div className={styles.usernameInput}>
                  <span aria-hidden="true">@</span>
                  <input
                    id="settings-username"
                    name="username"
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                    autoComplete="username"
                    maxLength={40}
                    required
                    spellCheck={false}
                    aria-describedby="username-hint"
                  />
                </div>
                <small id="username-hint">
                  글자·숫자와 . _ - 를 사용할 수 있어요.
                </small>
              </div>
            </div>
          </fieldset>
          <div className={styles.formFooter}>
            <FeedbackMessage feedback={profileFeedback} id="profile-feedback" />
            <button className={styles.primaryButton} type="submit" disabled={profileBusy}>
              {profileBusy ? <LoaderCircle className={styles.spin} size={16} aria-hidden="true" /> : null}
              {profileBusy ? "저장 중…" : "정보 저장"}
            </button>
          </div>
        </form>
      </section>

      <section className={styles.card} aria-labelledby="password-settings-title">
        <div className={styles.cardHeading}>
          <span className={`${styles.cardIcon} ${styles.securityIcon}`} aria-hidden="true">
            <KeyRound size={19} />
          </span>
          <div>
            <h2 id="password-settings-title">비밀번호 변경</h2>
            <p>현재 비밀번호를 확인한 뒤 새 비밀번호로 교체해요.</p>
          </div>
        </div>

        <form className={styles.form} onSubmit={changePassword} aria-busy={passwordBusy}>
          <fieldset className={styles.formFields} disabled={passwordBusy}>
            <label className={styles.field}>
              <span>현재 비밀번호</span>
              <input
                name="currentPassword"
                type="password"
                autoComplete="current-password"
                maxLength={128}
                required
              />
            </label>
            <div className={styles.twoColumns}>
              <label className={styles.field}>
                <span>새 비밀번호</span>
                <input
                  name="newPassword"
                  type="password"
                  autoComplete="new-password"
                  minLength={12}
                  maxLength={128}
                  required
                  aria-describedby="password-hint"
                />
              </label>
              <label className={styles.field}>
                <span>새 비밀번호 확인</span>
                <input
                  name="confirmPassword"
                  type="password"
                  autoComplete="new-password"
                  minLength={12}
                  maxLength={128}
                  required
                  aria-describedby="password-hint"
                />
              </label>
            </div>
            <div className={styles.securityNote} id="password-hint">
              <ShieldCheck size={17} aria-hidden="true" />
              <span>
                12자 이상, 글자와 숫자를 함께 사용해주세요. 변경 후 이 브라우저만
                로그인 상태로 남아요.
              </span>
            </div>
          </fieldset>
          <div className={styles.formFooter}>
            <FeedbackMessage feedback={passwordFeedback} id="password-feedback" />
            <button className={styles.primaryButton} type="submit" disabled={passwordBusy}>
              {passwordBusy ? <LoaderCircle className={styles.spin} size={16} aria-hidden="true" /> : null}
              {passwordBusy ? "변경 중…" : "비밀번호 변경"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
