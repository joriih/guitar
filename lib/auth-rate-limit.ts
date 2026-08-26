export type AuthRateLimitScope = "login" | "setup" | "password-change";

export type AuthRateLimitPolicy = {
  maxAttempts: number;
  windowMs: number;
};

export type AuthRateLimitStatus = {
  limited: boolean;
  remaining: number;
  retryAfterSeconds: number;
};

export type AuthRateLimitReservation = AuthRateLimitStatus & {
  reserved: boolean;
};

export const AUTH_RATE_LIMIT_POLICIES: Record<
  AuthRateLimitScope,
  AuthRateLimitPolicy
> = {
  login: { maxAttempts: 8, windowMs: 10 * 60 * 1_000 },
  setup: { maxAttempts: 5, windowMs: 60 * 1_000 },
  "password-change": { maxAttempts: 5, windowMs: 10 * 60 * 1_000 },
};

declare global {
  var __riffSketchbookAuthAttempts: Map<string, number[]> | undefined;
}

const attemptBuckets =
  globalThis.__riffSketchbookAuthAttempts ?? new Map<string, number[]>();

globalThis.__riffSketchbookAuthAttempts = attemptBuckets;

function bucketKey(scope: AuthRateLimitScope, identity: string): string {
  return `${scope}:${identity}`;
}

function currentAttempts(
  scope: AuthRateLimitScope,
  identity: string,
  now: number,
): number[] {
  const key = bucketKey(scope, identity);
  const policy = AUTH_RATE_LIMIT_POLICIES[scope];
  const cutoff = now - policy.windowMs;
  const attempts = (attemptBuckets.get(key) ?? []).filter(
    (timestamp) => timestamp > cutoff,
  );

  if (attempts.length) attemptBuckets.set(key, attempts);
  else attemptBuckets.delete(key);
  return attempts;
}

export function checkAuthRateLimit(
  scope: AuthRateLimitScope,
  identity: string,
  now = Date.now(),
): AuthRateLimitStatus {
  const policy = AUTH_RATE_LIMIT_POLICIES[scope];
  const attempts = currentAttempts(scope, identity, now);
  const limited = attempts.length >= policy.maxAttempts;
  const retryAfterMs = limited
    ? Math.max(1, attempts[0]! + policy.windowMs - now)
    : 0;

  return {
    limited,
    remaining: Math.max(0, policy.maxAttempts - attempts.length),
    retryAfterSeconds: limited ? Math.max(1, Math.ceil(retryAfterMs / 1_000)) : 0,
  };
}

export function recordAuthFailure(
  scope: AuthRateLimitScope,
  identity: string,
  now = Date.now(),
): AuthRateLimitStatus {
  const key = bucketKey(scope, identity);
  const attempts = currentAttempts(scope, identity, now);
  attempts.push(now);
  attemptBuckets.set(key, attempts);
  return checkAuthRateLimit(scope, identity, now);
}

export function reserveAuthAttempt(
  scope: AuthRateLimitScope,
  identity: string,
  now = Date.now(),
): AuthRateLimitReservation {
  const status = checkAuthRateLimit(scope, identity, now);
  if (status.limited) return { ...status, reserved: false };
  recordAuthFailure(scope, identity, now);
  return {
    ...status,
    reserved: true,
    remaining: Math.max(0, status.remaining - 1),
  };
}

export function clearAuthFailures(
  scope: AuthRateLimitScope,
  identity: string,
): void {
  attemptBuckets.delete(bucketKey(scope, identity));
}

export function clearAllAuthFailuresForTests(): void {
  attemptBuckets.clear();
}
