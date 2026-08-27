import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_APP_ORIGIN,
  allowedAppOrigins,
  isAllowedAppOrigin,
  isLoopbackAppOrigin,
  isSecureAppRequest,
  normalizeAppOrigin,
} from "./app-origin.mjs";

const REMOTE_ORIGIN = "https://quiet-riff-bridge.trycloudflare.com";

test("local access remains the fail-closed default", () => {
  assert.deepEqual(allowedAppOrigins(undefined, undefined), [DEFAULT_APP_ORIGIN]);
  assert.equal(isAllowedAppOrigin(DEFAULT_APP_ORIGIN, undefined, undefined), true);
  assert.equal(isAllowedAppOrigin("http://localhost:3000", undefined, undefined), false);
  assert.equal(isAllowedAppOrigin(null, undefined, undefined), false);
});

test("loopback APP_ORIGIN supports isolated local ports without remote mode", () => {
  const isolatedOrigin = "http://127.0.0.1:43117";
  assert.deepEqual(allowedAppOrigins(isolatedOrigin, undefined), [isolatedOrigin]);
  assert.equal(isAllowedAppOrigin(isolatedOrigin, isolatedOrigin, undefined), true);
  assert.equal(
    isAllowedAppOrigin(DEFAULT_APP_ORIGIN, isolatedOrigin, undefined),
    false,
  );
  assert.equal(isLoopbackAppOrigin("http://localhost:3000"), true);
  assert.equal(isLoopbackAppOrigin("http://[::1]:3000"), true);
});

test("remote access requires both its explicit switch and an external HTTPS origin", () => {
  assert.throws(
    () => allowedAppOrigins(REMOTE_ORIGIN, undefined),
    /RIFF_REMOTE_ACCESS=1/,
  );
  assert.throws(
    () => allowedAppOrigins(undefined, "1"),
    /requires an exact HTTPS APP_ORIGIN/,
  );
  assert.throws(
    () => allowedAppOrigins(DEFAULT_APP_ORIGIN, "1"),
    /non-loopback HTTPS APP_ORIGIN/,
  );
  assert.throws(
    () => allowedAppOrigins(REMOTE_ORIGIN, "yes"),
    /either 0 or 1/,
  );
  assert.deepEqual(allowedAppOrigins(REMOTE_ORIGIN, "1"), [
    DEFAULT_APP_ORIGIN,
    REMOTE_ORIGIN,
  ]);
});

test("configured origins must be canonical origins and external origins must use HTTPS", () => {
  for (const origin of [
    "http://quiet-riff-bridge.trycloudflare.com",
    "https://quiet-riff-bridge.trycloudflare.com/",
    "https://quiet-riff-bridge.trycloudflare.com/path",
    "https://quiet-riff-bridge.trycloudflare.com?query=yes",
    "https://quiet-riff-bridge.trycloudflare.com#fragment",
    "https://user:password@quiet-riff-bridge.trycloudflare.com",
    " https://quiet-riff-bridge.trycloudflare.com",
    "*.example.test",
    "null",
  ]) {
    assert.throws(() => normalizeAppOrigin(origin), origin);
  }
  assert.equal(normalizeAppOrigin(REMOTE_ORIGIN), REMOTE_ORIGIN);
});

test("origin checks use exact scheme, host, and port equality", () => {
  for (const origin of [
    "http://quiet-riff-bridge.trycloudflare.com",
    "https://quiet-riff-bridge.trycloudflare.com:444",
    "https://quiet-riff-bridge.trycloudflare.com.evil.invalid",
    "https://evil-quiet-riff-bridge.trycloudflare.com",
    "https://trycloudflare.com",
  ]) {
    assert.equal(isAllowedAppOrigin(origin, REMOTE_ORIGIN, "1"), false, origin);
  }
  assert.equal(isAllowedAppOrigin(REMOTE_ORIGIN, REMOTE_ORIGIN, "1"), true);
  assert.equal(isAllowedAppOrigin(DEFAULT_APP_ORIGIN, REMOTE_ORIGIN, "1"), true);
});

test("Secure-cookie policy follows only an allowed HTTPS browser Origin", () => {
  const remoteRequest = new Request(`${DEFAULT_APP_ORIGIN}/api/auth/login`, {
    method: "POST",
    headers: {
      origin: REMOTE_ORIGIN,
      "x-forwarded-proto": "http",
    },
  });
  assert.equal(isSecureAppRequest(remoteRequest, REMOTE_ORIGIN, "1"), true);

  const localRequest = new Request(`${DEFAULT_APP_ORIGIN}/api/auth/login`, {
    method: "POST",
    headers: { origin: DEFAULT_APP_ORIGIN, "x-forwarded-proto": "https" },
  });
  assert.equal(isSecureAppRequest(localRequest, REMOTE_ORIGIN, "1"), false);

  const untrustedRequest = new Request(`${DEFAULT_APP_ORIGIN}/api/auth/login`, {
    method: "POST",
    headers: {
      origin: "https://attacker.invalid",
      "x-forwarded-proto": "https",
    },
  });
  assert.equal(isSecureAppRequest(untrustedRequest, REMOTE_ORIGIN, "1"), false);

  const missingOriginRequest = new Request(`${DEFAULT_APP_ORIGIN}/api/auth/login`, {
    method: "POST",
    headers: { "x-forwarded-proto": "https" },
  });
  assert.equal(isSecureAppRequest(missingOriginRequest, REMOTE_ORIGIN, "1"), false);
});
