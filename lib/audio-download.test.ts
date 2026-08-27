import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// @ts-expect-error Node's type-stripping test runner requires the .ts extension.
import { audioContentDispositionHeader, safeAudioDownloadFileName } from "./audio-download.ts";

test("download names keep the stored source extension and sanitize take labels", () => {
  assert.equal(
    safeAudioDownloadFileName(
      "  Lead / Hook?.wav  ",
      "229d9467-e6a8-41b5-87ea-bfbbc8d256c1.webm",
      "audio/webm",
    ),
    "Lead _ Hook_.webm",
  );
  assert.equal(
    safeAudioDownloadFileName(
      "../내 테이크: 01",
      "912d59be-0496-4fb7-a81e-524c9ea130b7.wav",
      "audio/wav",
    ),
    "_내 테이크_ 01.wav",
  );
  assert.equal(safeAudioDownloadFileName("", "invalid", "audio/mpeg"), "take.mp3");
  const longUnicodeName = safeAudioDownloadFileName(
    `${"기타".repeat(100)}🎸`,
    "229d9467-e6a8-41b5-87ea-bfbbc8d256c1.webm",
    "audio/webm",
  );
  assert.ok(Buffer.byteLength(longUnicodeName, "utf8") <= 185);
  assert.doesNotThrow(() => audioContentDispositionHeader("attachment", longUnicodeName));
});

test("content disposition encodes Unicode without allowing header injection", () => {
  const header = audioContentDispositionHeader(
    "attachment",
    '내 "테이크"\r\nX-Evil: yes.webm',
  );
  assert.match(header, /^attachment; filename="[^"]+"; filename\*=UTF-8''/);
  assert.match(header, /%EB%82%B4/);
  assert.doesNotMatch(header, /[\r\n]/);
  assert.doesNotMatch(header, /X-Evil:/);
});

test("take audio download reuses authenticated no-store range streaming as an attachment", async () => {
  const [route, storage] = await Promise.all([
    readFile(new URL("../app/api/takes/[takeId]/audio/route.ts", import.meta.url), "utf8"),
    readFile(new URL("./audio-storage.ts", import.meta.url), "utf8"),
  ]);
  const authentication = route.indexOf("await requireUser()");
  const lookup = route.indexOf("await db.query");
  assert.ok(authentication >= 0 && lookup > authentication);
  assert.match(route, /searchParams\.get\("download"\) === "1"/);
  assert.match(route, /disposition:\s*downloadRequested \? "attachment" : "inline"/);
  assert.match(storage, /"Cache-Control":\s*"private, no-store"/);
  assert.match(storage, /"Content-Range"/);
  assert.match(storage, /audioContentDispositionHeader\(disposition, fileName\)/);
});
