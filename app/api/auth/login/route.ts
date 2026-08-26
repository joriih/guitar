import { NextResponse } from "next/server";

import {
  checkAuthRateLimit,
  clearAuthFailures,
  recordAuthFailure,
} from "@/lib/auth-rate-limit";
import { withTransaction } from "@/lib/db";
import { ApiError, apiError, assertSameOrigin } from "@/lib/http";
import { verifyPassword } from "@/lib/password";
import { issueSession, setSessionCookie } from "@/lib/session";
import { loginSchema } from "@/lib/validation";

export const runtime = "nodejs";

const LOGIN_RATE_LIMIT_KEY = "sole-account";

function enforceLoginRateLimit() {
  const status = checkAuthRateLimit("login", LOGIN_RATE_LIMIT_KEY);
  if (status.limited) {
    throw new ApiError(429, "로그인 시도가 많아요. 잠시 후 다시 시도해주세요.", {
      "Retry-After": String(status.retryAfterSeconds),
      "Cache-Control": "no-store",
    });
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const input = loginSchema.parse(await request.json());
    const { user, session } = await withTransaction(async (client) => {
      const result = await client.query<{
        id: number;
        username: string;
        display_name: string;
        password_hash: string;
      }>(
        `SELECT id, username, display_name, password_hash
           FROM app_user WHERE id = 1 FOR UPDATE`,
      );
      const user = result.rows[0];
      if (!user) throw new ApiError(409, "먼저 첫 설정을 완료해주세요.");

      // The row lock serializes this check/reservation so a burst of concurrent
      // requests cannot all begin an expensive password verification at once.
      enforceLoginRateLimit();
      recordAuthFailure("login", LOGIN_RATE_LIMIT_KEY);
      const valid = await verifyPassword(input.password, user.password_hash);
      if (!valid) {
        throw new ApiError(401, "비밀번호가 맞지 않아요.");
      }

      await client.query("DELETE FROM app_session WHERE expires_at <= now()");
      return { user, session: await issueSession(user.id, client) };
    });

    await setSessionCookie(
      request,
      session.token,
      session.expiresAt,
      input.remember,
    );
    clearAuthFailures("login", LOGIN_RATE_LIMIT_KEY);
    return NextResponse.json(
      {
        authenticated: true,
        user: {
          id: user.id,
          username: user.username,
          displayName: user.display_name,
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiError(error);
  }
}
