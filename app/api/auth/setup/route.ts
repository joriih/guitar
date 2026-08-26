import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import {
  checkAuthRateLimit,
  clearAuthFailures,
  recordAuthFailure,
} from "@/lib/auth-rate-limit";
import { isLoopbackAppOrigin } from "@/lib/app-origin";
import { db, withTransaction } from "@/lib/db";
import { ApiError, apiError, assertSameOrigin } from "@/lib/http";
import { hashPassword } from "@/lib/password";
import { issueSession, setSessionCookie } from "@/lib/session";
import { setupSchema } from "@/lib/validation";

export const runtime = "nodejs";

const SETUP_RATE_LIMIT_KEY = "sole-account";

function enforceSetupRateLimit() {
  const status = checkAuthRateLimit("setup", SETUP_RATE_LIMIT_KEY);
  if (status.limited) {
    throw new ApiError(429, "설정 시도가 많아요. 잠시 후 다시 시도해주세요.", {
      "Retry-After": String(status.retryAfterSeconds),
      "Cache-Control": "no-store",
    });
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    if (!isLoopbackAppOrigin(request.headers.get("origin"))) {
      throw new ApiError(403, "첫 설정은 이 Mac에서 직접 완료해주세요.");
    }
    const input = setupSchema.parse(await request.json());
    const existingUser = await db.query("SELECT 1 FROM app_user LIMIT 1");
    if (existingUser.rowCount) {
      throw new ApiError(409, "이미 첫 설정이 끝났어요. 로그인해주세요.");
    }
    enforceSetupRateLimit();
    recordAuthFailure("setup", SETUP_RATE_LIMIT_KEY);
    const passwordHash = await hashPassword(input.password);
    const albumId = randomUUID();
    const riffId = randomUUID();

    const session = await withTransaction(async (client) => {
      await client.query("LOCK TABLE app_user IN EXCLUSIVE MODE");
      const existing = await client.query("SELECT 1 FROM app_user LIMIT 1");
      if (existing.rowCount) {
        throw new ApiError(409, "이미 첫 설정이 끝났어요. 로그인해주세요.");
      }

      await client.query(
        `INSERT INTO app_user (id, username, display_name, password_hash)
         VALUES (1, $1, $2, $3)`,
        [input.username, input.displayName, passwordHash],
      );
      await client.query(
        `INSERT INTO album (id, name, description, color, sort_order)
         VALUES ($1, '첫 번째 앨범', '막 떠오른 리프를 모으는 곳', '#D9D2C3', 0)`,
        [albumId],
      );
      await client.query(
        `INSERT INTO riff (id, album_id, title)
         VALUES ($1, $2, '새 리프')`,
        [riffId, albumId],
      );
      return issueSession(1, client);
    });

    await setSessionCookie(
      request,
      session.token,
      session.expiresAt,
      input.remember,
    );
    clearAuthFailures("setup", SETUP_RATE_LIMIT_KEY);
    return NextResponse.json(
      {
        configured: true,
        authenticated: true,
        user: {
          id: 1,
          username: input.username,
          displayName: input.displayName,
        },
        seeded: { albumId, riffId },
      },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiError(error);
  }
}
