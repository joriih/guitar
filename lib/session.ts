import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import type { PoolClient } from "pg";

import { isSecureAppRequest } from "@/lib/app-origin";
import { db } from "@/lib/db";

export const SESSION_COOKIE_NAME =
  process.env.SESSION_COOKIE_NAME ?? "riff_session";
const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

export type SessionUser = {
  id: number;
  username: string;
  displayName: string;
  revision: number;
};

export function digestSessionToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

export async function issueSession(
  userId: number,
  client: PoolClient | typeof db = db,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_LIFETIME_MS);
  await client.query(
    `INSERT INTO app_session (token_digest, user_id, expires_at)
     VALUES ($1, $2, $3)`,
    [digestSessionToken(token), userId, expiresAt],
  );
  return { token, expiresAt };
}

export async function replaceAllUserSessions(
  userId: number,
  client: PoolClient,
): Promise<{ token: string; expiresAt: Date }> {
  await client.query("DELETE FROM app_session WHERE user_id = $1", [userId]);
  return issueSession(userId, client);
}

export async function setSessionCookie(
  request: Request,
  token: string,
  expiresAt: Date,
  remember = true,
) {
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "strict",
    // The local and private HTTPS origins use separate host-scoped cookies.
    // Determine Secure from the already-validated request rather than the
    // configured sharing origin so both entry points remain usable.
    secure: isSecureAppRequest(request),
    path: "/",
    expires: remember ? expiresAt : undefined,
  });
}

export async function clearSessionCookie(request: Request) {
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    sameSite: "strict",
    secure: isSecureAppRequest(request),
    path: "/",
    expires: new Date(0),
  });
}

export async function getSessionToken(): Promise<string | null> {
  const cookieStore = await cookies();
  return cookieStore.get(SESSION_COOKIE_NAME)?.value ?? null;
}

export async function getUserForSessionToken(
  token: string | null,
): Promise<SessionUser | null> {
  if (!token) return null;

  const result = await db.query<{
    id: number;
    username: string;
    display_name: string;
    revision: number;
  }>(
    `SELECT u.id, u.username, u.display_name, u.revision
       FROM app_session s
       JOIN app_user u ON u.id = s.user_id
      WHERE s.token_digest = $1
        AND s.expires_at > now()`,
    [digestSessionToken(token)],
  );
  const row = result.rows[0];
  return row
    ? {
        id: row.id,
        username: row.username,
        displayName: row.display_name,
        revision: row.revision,
      }
    : null;
}

export async function destroyCurrentSession(request: Request) {
  const token = await getSessionToken();
  if (token) {
    await db.query("DELETE FROM app_session WHERE token_digest = $1", [
      digestSessionToken(token),
    ]);
  }
  await clearSessionCookie(request);
}
