import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));

function disabledFields(source, busyState) {
  const opening = `<fieldset className={styles.formFields} disabled={${busyState}}>`;
  const start = source.indexOf(opening);
  assert.notEqual(start, -1, `${busyState} must disable its related fieldset`);
  const end = source.indexOf("</fieldset>", start);
  assert.notEqual(end, -1);
  return source.slice(start, end);
}

test("settings inputs cannot change while their submitted snapshot is in flight", async () => {
  const source = await readFile(path.join(directory, "SettingsForm.tsx"), "utf8");
  const profile = disabledFields(source, "profileBusy");
  assert.match(profile, /name="displayName"/);
  assert.match(profile, /name="username"/);

  const password = disabledFields(source, "passwordBusy");
  assert.match(password, /name="currentPassword"/);
  assert.match(password, /name="newPassword"/);
  assert.match(password, /name="confirmPassword"/);

  assert.match(source, /aria-busy=\{profileBusy\}/);
  assert.match(source, /aria-busy=\{passwordBusy\}/);
  assert.match(source, /profileBusy \? "저장 중…"/);
  assert.match(source, /expectedRevision: profileRevision/);
  assert.match(source, /response\.status === 409/);
  assert.match(source, /profileBaselineRef/);
  assert.match(source, /setProfileRevision\(current\.revision\)/);
  assert.match(source, /passwordBusy \? "변경 중…"/);
  assert.match(source, /"password-change:v1"/);
  assert.match(source, /requestId: passwordRequest\.requestId/);
  assert.doesNotMatch(
    source,
    /getOrCreateClientCreateRequest\([\s\S]{0,180}newPassword/,
    "password values must never be persisted as the browser intent key",
  );
});
