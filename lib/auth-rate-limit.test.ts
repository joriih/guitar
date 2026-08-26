import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error Node's type-stripping test runner requires the .ts extension.
import { AUTH_RATE_LIMIT_POLICIES, checkAuthRateLimit, clearAllAuthFailuresForTests, clearAuthFailures, recordAuthFailure, reserveAuthAttempt } from "./auth-rate-limit.ts";

test.beforeEach(() => clearAllAuthFailuresForTests());

test("login limiter blocks only after the configured failed attempts", () => {
  const now = 1_000_000;
  const policy = AUTH_RATE_LIMIT_POLICIES.login;

  for (let index = 0; index < policy.maxAttempts; index += 1) {
    assert.equal(checkAuthRateLimit("login", "sole-account", now).limited, false);
    recordAuthFailure("login", "sole-account", now + index);
  }

  const blocked = checkAuthRateLimit(
    "login",
    "sole-account",
    now + policy.maxAttempts,
  );
  assert.equal(blocked.limited, true);
  assert.equal(blocked.remaining, 0);
  assert.ok(blocked.retryAfterSeconds > 0);
});

test("attempt window expires and successful authentication can clear failures", () => {
  const now = 2_000_000;
  const policy = AUTH_RATE_LIMIT_POLICIES["password-change"];
  for (let index = 0; index < policy.maxAttempts; index += 1) {
    recordAuthFailure("password-change", "1", now);
  }
  assert.equal(checkAuthRateLimit("password-change", "1", now).limited, true);

  clearAuthFailures("password-change", "1");
  assert.equal(checkAuthRateLimit("password-change", "1", now).limited, false);

  for (let index = 0; index < policy.maxAttempts; index += 1) {
    recordAuthFailure("password-change", "1", now);
  }
  assert.equal(
    checkAuthRateLimit("password-change", "1", now + policy.windowMs).limited,
    false,
  );
});

test("rate-limit scopes and identities do not share buckets", () => {
  const now = 3_000_000;
  for (let index = 0; index < AUTH_RATE_LIMIT_POLICIES.setup.maxAttempts; index += 1) {
    recordAuthFailure("setup", "sole-account", now);
  }

  assert.equal(checkAuthRateLimit("setup", "sole-account", now).limited, true);
  assert.equal(checkAuthRateLimit("login", "sole-account", now).limited, false);
  assert.equal(checkAuthRateLimit("setup", "another-account", now).limited, false);
});

test("password replay verification allows five reservations then blocks before work", () => {
  const now = 4_000_000;
  const identity = "replay-user-1";
  const policy = AUTH_RATE_LIMIT_POLICIES["password-change"];

  for (let index = 0; index < policy.maxAttempts; index += 1) {
    const reservation = reserveAuthAttempt(
      "password-change",
      identity,
      now + index,
    );
    assert.equal(reservation.reserved, true);
    assert.equal(reservation.limited, false);
  }

  const blocked = reserveAuthAttempt(
    "password-change",
    identity,
    now + policy.maxAttempts,
  );
  assert.equal(blocked.reserved, false);
  assert.equal(blocked.limited, true);
  assert.ok(blocked.retryAfterSeconds > 0);
});
