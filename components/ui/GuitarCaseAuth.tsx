"use client";

import Image from "next/image";
import { Eye, EyeOff, Guitar, LockKeyhole, UserRound } from "lucide-react";
import { useState, type FormEventHandler } from "react";
import { DEFAULT_ACCOUNT_USERNAME } from "@/lib/account-defaults";
import styles from "./GuitarCaseAuth.module.css";

export type GuitarCaseAuthProps = {
  mode?: "login" | "setup";
  action?: string;
  defaultUsername?: string;
  error?: string | null;
  guitarImageSrc?: string;
  isBusy?: boolean;
  onSubmit?: FormEventHandler<HTMLFormElement>;
  submitLabel?: string;
};

export function GuitarCaseAuth({
  mode = "login",
  action,
  defaultUsername = DEFAULT_ACCOUNT_USERNAME,
  error,
  guitarImageSrc = "/assets/guitars/olympic-white.avif",
  isBusy = false,
  onSubmit,
  submitLabel,
}: GuitarCaseAuthProps) {
  const [showPassword, setShowPassword] = useState(false);
  const [passwordFocused, setPasswordFocused] = useState(false);
  const isSetup = mode === "setup";

  return (
    <main className={styles.page}>
      <section className={styles.card} aria-labelledby="auth-title">
        <div
          className={`${styles.visual} ${passwordFocused ? styles.caseClosed : ""}`}
          aria-hidden="true"
        >
          <div className={styles.caseScene}>
            <div className={styles.caseBase}>
              <div className={styles.caseLining} />
              <Image
                className={styles.guitar}
                src={guitarImageSrc}
                alt=""
                width={360}
                height={470}
                priority
              />
              <span className={`${styles.latch} ${styles.latchTop}`} />
              <span className={`${styles.latch} ${styles.latchBottom}`} />
            </div>
            <div className={styles.caseLid}>
              <span className={styles.caseSeam} />
              <span className={styles.caseHandle} />
            </div>
          </div>
        </div>

        <div className={styles.formSide}>
          <div className={styles.formInner}>
            <div className={styles.wordmark}>
              <span className={styles.wordmarkIcon} aria-hidden="true">
                <Guitar size={18} strokeWidth={1.8} />
              </span>
              <span>Riff Sketchbook</span>
            </div>

            <div className={styles.headingBlock}>
              <h1 id="auth-title">
                {isSetup ? "첫 스케치북을 열어볼까요?" : "내 앨범과 리프가 기다리고 있어요."}
              </h1>
            </div>

            <form
              className={styles.form}
              action={action}
              method={action ? "post" : undefined}
              onSubmit={onSubmit}
              aria-busy={isBusy}
            >
              <fieldset className={styles.formFields} disabled={isBusy}>
                <label className={styles.field}>
                  <span className="sr-only">사용자 이름</span>
                  <span className={styles.inputRow}>
                    <UserRound
                      className={styles.inputIcon}
                      size={18}
                      aria-hidden="true"
                    />
                    <input
                      name="username"
                      type="text"
                      defaultValue={defaultUsername}
                      autoComplete="username"
                      readOnly={!isSetup}
                      required
                      aria-label="사용자 이름"
                    />
                  </span>
                </label>

                <div className={styles.field}>
                  <label className="sr-only" htmlFor="auth-password">
                    비밀번호
                  </label>
                  <span
                    className={`${styles.inputRow} ${error ? styles.inputError : ""}`}
                  >
                    <LockKeyhole
                      className={styles.inputIcon}
                      size={18}
                      aria-hidden="true"
                    />
                    <input
                      id="auth-password"
                      name="password"
                      type={showPassword ? "text" : "password"}
                      placeholder={isSetup ? "비밀번호 만들기" : "비밀번호"}
                      autoComplete={isSetup ? "new-password" : "current-password"}
                      onFocus={() => setPasswordFocused(true)}
                      onBlur={() => setPasswordFocused(false)}
                      required
                      minLength={8}
                      aria-invalid={Boolean(error)}
                      aria-describedby={error ? "auth-error" : undefined}
                    />
                    <button
                      className={styles.revealButton}
                      type="button"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => setShowPassword((value) => !value)}
                      aria-label={
                        showPassword
                          ? "입력한 비밀번호 숨기기"
                          : "입력한 비밀번호 보기"
                      }
                      aria-pressed={showPassword}
                    >
                      {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                    </button>
                  </span>
                </div>

                <label className={styles.rememberRow}>
                  <input name="remember" type="checkbox" defaultChecked />
                  <span>이 Mac에서 로그인 유지</span>
                </label>
              </fieldset>

              {error ? (
                <p className={styles.error} id="auth-error" role="alert">
                  {error}
                </p>
              ) : null}

              <button className={styles.submit} type="submit" disabled={isBusy}>
                {isBusy ? "여는 중…" : submitLabel ?? (isSetup ? "시작하기" : "스케치북 열기")}
              </button>
            </form>
          </div>
        </div>
      </section>
    </main>
  );
}
