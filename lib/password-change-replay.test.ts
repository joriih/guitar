import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error Node's type-stripping test runner requires the .ts extension.
import { decryptPasswordChangeSessionToken, encryptPasswordChangeSessionToken } from "./password-change-replay.ts";

test("password response-loss recovery encrypts one stable session for exact replay", () => {
  const sessionToken = "new-session-token-that-must-not-be-stored-in-plaintext";
  const previousSessionToken = "old-http-only-session-token";
  const requestId = "10000000-0000-4000-8000-000000000001";
  const encrypted = encryptPasswordChangeSessionToken(
    sessionToken,
    previousSessionToken,
    requestId,
  );
  assert.equal(encrypted.iv.length, 12);
  assert.equal(encrypted.tag.length, 16);
  assert.equal(encrypted.ciphertext.includes(Buffer.from(sessionToken)), false);
  assert.equal(
    decryptPasswordChangeSessionToken(
      encrypted,
      previousSessionToken,
      requestId,
    ),
    sessionToken,
  );
  assert.throws(() =>
    decryptPasswordChangeSessionToken(
      encrypted,
      "different-old-session-token",
      requestId,
    ),
  );
  assert.throws(() =>
    decryptPasswordChangeSessionToken(
      encrypted,
      previousSessionToken,
      "20000000-0000-4000-8000-000000000002",
    ),
  );
});
