import { getSessionToken, getUserForSessionToken, type SessionUser } from "@/lib/session";

export class AuthenticationError extends Error {
  constructor() {
    super("로그인이 필요해요.");
    this.name = "AuthenticationError";
  }
}

export async function getCurrentUser(): Promise<SessionUser | null> {
  return getUserForSessionToken(await getSessionToken());
}

export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) throw new AuthenticationError();
  return user;
}
