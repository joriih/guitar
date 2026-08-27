import assert from "node:assert/strict";
import { access, lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// @ts-expect-error Node's type-stripping test runner requires the .ts extension.
import { sha256AudioBlob } from "./audio-file-digest.ts";
// @ts-expect-error Node's type-stripping test runner requires the .ts extension.
import { audioContentDispositionHeader, safeAudioDownloadFileName } from "./audio-download.ts";
// @ts-expect-error Node's type-stripping test runner requires the .ts extension.
import { writeExclusiveAudioStream } from "./audio-stream-write.ts";

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
  assert.match(storage, /fsConstants\.O_RDONLY \| fsConstants\.O_NOFOLLOW/);
  assert.match(storage, /const fileStat = await handle\.stat\(\)/);
  assert.match(storage, /handle\.createReadStream\(\{ autoClose: true \}\)/);
  assert.doesNotMatch(route, /stat\(absolutePath\)/);
});

test("large uploads are hashed and written incrementally without leaving partial files", async () => {
  const chunks = [new Uint8Array([97]), new Uint8Array([98, 99])];
  let streamReads = 0;
  const blob = {
    stream: () => new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[streamReads];
        streamReads += 1;
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
    }),
  };
  assert.equal(
    await sha256AudioBlob(blob, "meta\0"),
    "742e691091fd3b701e9152c10734303ec45eb2e89af2be65f72d78d00beae485",
  );
  assert.ok(streamReads > 1, "the digest should consume the stream in chunks");

  const directory = await mkdtemp(path.join(os.tmpdir(), "riff-audio-stream-"));
  const completePath = path.join(directory, "complete.webm");
  const partialPath = path.join(directory, "partial.webm");
  try {
    await writeExclusiveAudioStream(
      completePath,
      new Blob(chunks).stream(),
      3,
    );
    assert.deepEqual(new Uint8Array(await readFile(completePath)), new Uint8Array([97, 98, 99]));
    assert.equal((await lstat(completePath)).mode & 0o777, 0o600);

    await assert.rejects(
      writeExclusiveAudioStream(
        partialPath,
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2]));
            controller.close();
          },
        }),
        3,
      ),
      /declared bytes/,
    );
    await assert.rejects(access(partialPath), /ENOENT/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a close failure rejects a completed write, deletes it, and preserves error order", async () => {
  const closeError = Object.assign(new Error("close failed"), { code: "EIO" });
  const closeEvents: string[] = [];
  await assert.rejects(
    writeExclusiveAudioStream(
      "/isolated/completed.webm",
      new Blob([new Uint8Array([1, 2, 3])]).stream(),
      3,
      {
        openExclusiveFile: async () => ({
          write: async (_buffer, _offset, length) => {
            closeEvents.push("write");
            return { bytesWritten: length };
          },
          close: async () => {
            closeEvents.push("close");
            throw closeError;
          },
        }),
        removeFile: async () => {
          closeEvents.push("remove");
        },
      },
    ),
    (error) => error === closeError,
  );
  assert.deepEqual(closeEvents, ["write", "close", "remove"]);

  const writeError = new Error("write failed");
  const secondCloseError = Object.assign(new Error("close also failed"), { code: "EIO" });
  const combinedEvents: string[] = [];
  await assert.rejects(
    writeExclusiveAudioStream(
      "/isolated/partial.webm",
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1]));
        },
        cancel() {
          combinedEvents.push("cancel");
        },
      }),
      1,
      {
        openExclusiveFile: async () => ({
          write: async () => {
            combinedEvents.push("write");
            throw writeError;
          },
          close: async () => {
            combinedEvents.push("close");
            throw secondCloseError;
          },
        }),
        removeFile: async () => {
          combinedEvents.push("remove");
        },
      },
    ),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [writeError, secondCloseError]);
      return true;
    },
  );
  assert.deepEqual(combinedEvents, ["write", "cancel", "close", "remove"]);
});

test("track uploads finish disk I/O before taking the mutation transaction lock", async () => {
  const [route, storage] = await Promise.all([
    readFile(new URL("../app/api/riffs/[riffId]/tracks/route.ts", import.meta.url), "utf8"),
    readFile(new URL("./audio-storage.ts", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(route, /audio\.arrayBuffer\(\)/);
  assert.doesNotMatch(storage, /file\.arrayBuffer\(\)/);
  assert.match(route, /savedFileRef\.current = await saveAudioFile\(audio\)/);
  assert.match(
    route,
    /savedFileRef\.current = await saveAudioFile\(audio\)[\s\S]*?const upload = await withTransaction/,
  );
  assert.match(route, /if \(!upload\.created\)\s*\{\s*await removeAudioFile/);
  assert.match(storage, /writeExclusiveAudioStream\([\s\S]*?file\.stream\(\)/);
});
