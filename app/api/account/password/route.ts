import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import type { PoolClient } from "pg";

import { AuthenticationError } from "@/lib/auth";
import {
  clearAuthFailures,
  reserveAuthAttempt,
} from "@/lib/auth-rate-limit";
import { db, withTransaction } from "@/lib/db";
import {
  ApiError,
  apiError,
  assertSameOrigin,
  readJsonWithLimit,
} from "@/lib/http";
import { hashPassword, verifyPassword } from "@/lib/password";
import {
  decryptPasswordChangeSessionToken,
  encryptPasswordChangeSessionToken,
} from "@/lib/password-change-replay";
import {
  digestSessionToken,
  getSessionToken,
  getUserForSessionToken,
  replaceAllUserSessions,
  setSessionCookie,
} from "@/lib/session";
import { passwordChangeRequestSchema } from "@/lib/validation";

export const runtime = "nodejs";

type PasswordChangeRequestRow = {
  request_id: string;
  user_id: number;
  payload_hash: string;
  previous_session_digest: Buffer;
  session_token_ciphertext: Buffer;
  session_token_iv: Buffer;
  session_token_tag: Buffer;
  expires_at: Date | string;
  superseded_at: Date | string | null;
};

type PasswordChangeInput = ReturnType<typeof passwordChangeRequestSchema.parse>;

function reservePasswordVerificationAttempt(userId: number) {
  const reservation = reserveAuthAttempt(
    "password-change",
    String(userId),
  );
  if (!reservation.reserved) {
    throw new ApiError(
      429,
      "비밀번호 확인 시도가 많아요. 잠시 후 다시 시도해주세요.",
      {
        "Retry-After": String(reservation.retryAfterSeconds),
        "Cache-Control": "no-store",
      },
    );
  }
}

function passwordChangeIntent(input: PasswordChangeInput): string {
  return input.newPassword;
}

async function findPasswordChangeRequest(
  requestId: string,
  client: PoolClient | typeof db = db,
  forUpdate = false,
): Promise<PasswordChangeRequestRow | null> {
  const result = await client.query<PasswordChangeRequestRow>(
    `SELECT request_id, user_id, payload_hash, previous_session_digest,
            session_token_ciphertext, session_token_iv, session_token_tag,
            expires_at, superseded_at
       FROM password_change_request
      WHERE request_id = $1${forUpdate ? " FOR UPDATE" : ""}`,
    [requestId],
  );
  return result.rows[0] ?? null;
}

function matchesPreviousSession(
  row: PasswordChangeRequestRow,
  sessionToken: string | null,
): boolean {
  if (!sessionToken) return false;
  const presentedDigest = digestSessionToken(sessionToken);
  return (
    row.previous_session_digest.length === presentedDigest.length &&
    timingSafeEqual(row.previous_session_digest, presentedDigest)
  );
}

async function isCurrentSessionForUser(
  row: PasswordChangeRequestRow,
  sessionToken: string | null,
  client: PoolClient | typeof db = db,
): Promise<boolean> {
  if (!sessionToken) return false;
  const result = await client.query(
    `SELECT 1
       FROM app_session
      WHERE token_digest = $1
        AND user_id = $2
        AND expires_at > now()`,
    [digestSessionToken(sessionToken), row.user_id],
  );
  return result.rowCount === 1;
}

async function assertReplayMatches(
  row: PasswordChangeRequestRow,
  input: PasswordChangeInput,
) {
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    throw new ApiError(410, "이 비밀번호 변경 복구 요청이 만료됐어요.");
  }
  if (row.superseded_at) {
    throw new ApiError(410, "이 비밀번호 변경 요청은 더 최신 변경으로 교체됐어요.");
  }
  if (!(await verifyPassword(passwordChangeIntent(input), row.payload_hash))) {
    throw new ApiError(
      409,
      "이 요청은 다른 비밀번호 변경 내용으로 이미 사용됐어요. 처음 전송한 내용을 다시 입력해주세요.",
    );
  }
}

async function recoverReplaySession(
  row: PasswordChangeRequestRow,
  previousSessionToken: string,
  client: PoolClient | typeof db = db,
) {
  let token: string;
  try {
    token = decryptPasswordChangeSessionToken(
      {
        ciphertext: row.session_token_ciphertext,
        iv: row.session_token_iv,
        tag: row.session_token_tag,
      },
      previousSessionToken,
      row.request_id,
    );
  } catch {
    // A corrupt or tampered recovery row must never mint a replacement session.
    throw new ApiError(410, "비밀번호 변경 복구 정보를 사용할 수 없어요.");
  }

  const result = await client.query<{ expires_at: Date | string }>(
    `SELECT expires_at
       FROM app_session
      WHERE token_digest = $1
        AND user_id = $2
        AND expires_at > now()`,
    [digestSessionToken(token), row.user_id],
  );
  const expiresAt = result.rows[0]?.expires_at;
  if (!expiresAt) {
    throw new ApiError(
      410,
      "비밀번호 변경 뒤 발급된 로그인 정보를 더 이상 복구할 수 없어요.",
    );
  }
  return { token, expiresAt: new Date(expiresAt) };
}

function successResponse(replay: boolean) {
  return NextResponse.json(
    { changed: true, authenticated: true, idempotentReplay: replay },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const input = passwordChangeRequestSchema.parse(
      await readJsonWithLimit(request),
    );
    const sessionToken = await getSessionToken();
    const user = await getUserForSessionToken(sessionToken);

    if (input.requestId) {
      const existing = await findPasswordChangeRequest(input.requestId);
      if (existing) {
        const previousSessionReplay = matchesPreviousSession(
          existing,
          sessionToken,
        );
        if (
          !previousSessionReplay &&
          !(await isCurrentSessionForUser(existing, sessionToken))
        ) {
          throw new AuthenticationError();
        }
        reservePasswordVerificationAttempt(existing.user_id);
        await assertReplayMatches(existing, input);
        if (previousSessionReplay) {
          if (!sessionToken) throw new AuthenticationError();
          const replaySession = await recoverReplaySession(
            existing,
            sessionToken,
          );
          await setSessionCookie(
            request,
            replaySession.token,
            replaySession.expiresAt,
            true,
          );
        }
        clearAuthFailures("password-change", String(existing.user_id));
        clearAuthFailures("login", "sole-account");
        return successResponse(true);
      }
    }

    if (!user || !sessionToken) throw new AuthenticationError();
    // This reservation also covers a mapping that appears while the fresh
    // request waits on the account row lock; the inner replay must not count twice.
    reservePasswordVerificationAttempt(user.id);

    const passwordHash = await hashPassword(input.newPassword);
    const requestPayloadHash = input.requestId ? passwordHash : null;
    const previousSessionDigest = input.requestId
      ? digestSessionToken(sessionToken)
      : null;

    const outcome = await withTransaction(async (client) => {
      const result = await client.query<{ password_hash: string }>(
        "SELECT password_hash FROM app_user WHERE id = $1 FOR UPDATE",
        [user.id],
      );
      const account = result.rows[0];
      if (!account) throw new ApiError(404, "사용자 정보를 찾을 수 없어요.");

      if (input.requestId) {
        const concurrentReplay = await findPasswordChangeRequest(
          input.requestId,
          client,
          true,
        );
        if (concurrentReplay) {
          if (!matchesPreviousSession(concurrentReplay, sessionToken)) {
            throw new AuthenticationError();
          }
          await assertReplayMatches(concurrentReplay, input);
          return {
            replay: true,
            session: await recoverReplaySession(
              concurrentReplay,
              sessionToken,
              client,
            ),
          } as const;
        }
      }

      if (!(await verifyPassword(input.currentPassword, account.password_hash))) {
        throw new ApiError(401, "현재 비밀번호가 맞지 않아요.");
      }

      await client.query(
        `UPDATE password_change_request
            SET superseded_at = now()
          WHERE user_id = $1 AND superseded_at IS NULL`,
        [user.id],
      );
      await client.query(
        `DELETE FROM password_change_request
          WHERE user_id = $1
            AND (
              expires_at < now() - interval '1 day'
              OR superseded_at < now() - interval '1 day'
            )`,
        [user.id],
      );
      await client.query(
        `UPDATE app_user
            SET password_hash = $2, updated_at = now()
          WHERE id = $1`,
        [user.id, passwordHash],
      );
      const replacementSession = await replaceAllUserSessions(user.id, client);
      if (
        input.requestId &&
        requestPayloadHash &&
        previousSessionDigest
      ) {
        const encryptedSession = encryptPasswordChangeSessionToken(
          replacementSession.token,
          sessionToken,
          input.requestId,
        );
        await client.query(
          `INSERT INTO password_change_request
             (request_id, user_id, payload_hash, previous_session_digest,
              session_token_ciphertext, session_token_iv, session_token_tag)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            input.requestId,
            user.id,
            requestPayloadHash,
            previousSessionDigest,
            encryptedSession.ciphertext,
            encryptedSession.iv,
            encryptedSession.tag,
          ],
        );
      }
      return {
        replay: false,
        session: replacementSession,
      } as const;
    });

    await setSessionCookie(
      request,
      outcome.session.token,
      outcome.session.expiresAt,
      true,
    );
    clearAuthFailures("password-change", String(user.id));
    clearAuthFailures("login", "sole-account");
    return successResponse(outcome.replay);
  } catch (error) {
    return apiError(error);
  }
}
