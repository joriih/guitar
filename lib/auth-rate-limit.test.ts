import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error Node's type-stripping test runner requires the .ts extension.
import { AUTH_RATE_LIMIT_POLICIES, checkAuthRateLimit, clearAllAuthFailuresForTests, clearAuthFailures, recordAuthFailure, reserveAuthAttempt } from "./auth-rate-limit.ts";
// @ts-expect-error Node's type-stripping test runner requires the .ts extension.
import { AUTH_JSON_BODY_LIMIT_BYTES, readJsonWithLimit, RequestBodyError } from "./request-json.ts";

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

function requestBodyError(status: number) {
  return (error: unknown) =>
    error instanceof RequestBodyError && error.status === status;
}

test("auth JSON accepts a small application/json body", async () => {
  const request = new Request("http://127.0.0.1:43117/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ password: "correct horse battery staple" }),
  });
  assert.deepEqual(await readJsonWithLimit(request), {
    password: "correct horse battery staple",
  });
});

test("auth JSON rejects a declared oversize body before reading it", async () => {
  const request = new Request("http://127.0.0.1:43117/api/auth/login", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(AUTH_JSON_BODY_LIMIT_BYTES + 1),
    },
    body: "{}",
  });
  const body = request.body;
  assert.ok(body);
  const originalGetReader = body.getReader.bind(body);
  let readerRequested = false;
  Object.defineProperty(body, "getReader", {
    value() {
      readerRequested = true;
      return originalGetReader();
    },
  });

  await assert.rejects(readJsonWithLimit(request), requestBodyError(413));
  assert.equal(readerRequested, false);
});

test("auth JSON cancels a chunked body once its streamed bytes exceed 4 KiB", async () => {
  let chunksSent = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (chunksSent === 3) {
        controller.close();
        return;
      }
      chunksSent += 1;
      controller.enqueue(new Uint8Array(2 * 1024));
    },
    cancel() {
      cancelled = true;
    },
  });
  const request = new Request("http://127.0.0.1:43117/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });

  await assert.rejects(readJsonWithLimit(request), requestBodyError(413));
  assert.equal(cancelled, true);
});

test("auth JSON rejects non-JSON media types", async () => {
  const request = new Request("http://127.0.0.1:43117/api/auth/login", {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "{}",
  });
  await assert.rejects(readJsonWithLimit(request), requestBodyError(415));
});
