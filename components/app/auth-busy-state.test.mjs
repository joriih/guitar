import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));

test("authentication keeps every submitted credential control locked until navigation", async () => {
  const [authForm, guitarCase] = await Promise.all([
    readFile(path.join(directory, "AuthForm.tsx"), "utf8"),
    readFile(path.join(directory, "..", "ui", "GuitarCaseAuth.tsx"), "utf8"),
  ]);
  const opening = '<fieldset className={styles.formFields} disabled={isBusy}>';
  const start = guitarCase.indexOf(opening);
  assert.notEqual(start, -1);
  const end = guitarCase.indexOf("</fieldset>", start);
  assert.notEqual(end, -1);
  const fields = guitarCase.slice(start, end);
  assert.match(fields, /name="username"/);
  assert.match(fields, /name="password"/);
  assert.match(fields, /className=\{styles\.revealButton\}/);
  assert.match(fields, /name="remember"/);
  assert.match(guitarCase, /aria-busy=\{isBusy\}/);
  assert.match(guitarCase, /isBusy \? "여는 중…"/);

  assert.equal(
    (authForm.match(/setIsBusy\(false\)/g) ?? []).length,
    1,
    "successful auth must stay locked while replacement navigation completes",
  );
});
