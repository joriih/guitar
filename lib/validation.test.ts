import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error Node's type-stripping test runner requires the .ts extension.
import { DEFAULT_ACCOUNT_DISPLAY_NAME, DEFAULT_ACCOUNT_USERNAME } from "./account-defaults.ts";
// @ts-expect-error Node's type-stripping test runner requires the .ts extension.
import { accountProfileSchema, passwordChangeRequestSchema, passwordChangeSchema } from "./account-validation.ts";

test("new installations use generic account defaults", () => {
  assert.equal(DEFAULT_ACCOUNT_USERNAME, "guitarist");
  assert.equal(DEFAULT_ACCOUNT_DISPLAY_NAME, "기타리스트");
  assert.equal(
    accountProfileSchema.safeParse({
      username: DEFAULT_ACCOUNT_USERNAME,
      displayName: DEFAULT_ACCOUNT_DISPLAY_NAME,
      expectedRevision: 0,
    }).success,
    true,
  );
});

test("account profile accepts and trims safe Korean identity fields", () => {
  const result = accountProfileSchema.parse({
    username: "  riff_기타  ",
    displayName: "  나의 스케치북  ",
    expectedRevision: 3,
  });
  assert.deepEqual(result, {
    username: "riff_기타",
    displayName: "나의 스케치북",
    expectedRevision: 3,
  });
});

test("account profile rejects unsafe identity characters", () => {
  assert.equal(
    accountProfileSchema.safeParse({
      username: "bad name",
      displayName: "리프",
      expectedRevision: 0,
    }).success,
    false,
  );
  assert.equal(
    accountProfileSchema.safeParse({
      username: "guitarist",
      displayName: "리프\n관리자",
      expectedRevision: 0,
    }).success,
    false,
  );
  assert.equal(
    accountProfileSchema.safeParse({
      username: "guitarist",
      displayName: "리프",
      expectedRevision: -1,
    }).success,
    false,
  );
});

test("password change requires a strong distinct matching password", () => {
  assert.equal(
    passwordChangeSchema.safeParse({
      currentPassword: "old-password-1",
      newPassword: "새로운-password-2026",
      confirmPassword: "새로운-password-2026",
    }).success,
    true,
  );
  assert.equal(
    passwordChangeSchema.safeParse({
      currentPassword: "same-password-1",
      newPassword: "same-password-1",
      confirmPassword: "same-password-1",
    }).success,
    false,
  );
  assert.equal(
    passwordChangeSchema.safeParse({
      currentPassword: "old-password-1",
      newPassword: "letters-only-password",
      confirmPassword: "different-password-2",
    }).success,
    false,
  );
});

test("password change request IDs are optional strict UUIDs", () => {
  const base = {
    currentPassword: "old-password-1",
    newPassword: "새로운-password-2026",
    confirmPassword: "새로운-password-2026",
  };
  assert.equal(passwordChangeRequestSchema.safeParse(base).success, true);
  assert.equal(
    passwordChangeRequestSchema.safeParse({
      ...base,
      requestId: "10000000-0000-4000-8000-000000000001",
    }).success,
    true,
  );
  assert.equal(
    passwordChangeRequestSchema.safeParse({ ...base, requestId: "not-a-uuid" })
      .success,
    false,
  );
  assert.equal(
    passwordChangeRequestSchema.safeParse({ ...base, unexpected: true }).success,
    false,
  );
});
