import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error Node's type-stripping test runner requires the .ts extension.
import { parseYouTubeUrl, parseYouTubeVideoId } from "./youtube-url.ts";

const VIDEO_ID = "dQw4w9WgXcQ";

test("parses supported YouTube watch, share, Shorts, and embed links", () => {
  const inputs = [
    `https://www.youtube.com/watch?v=${VIDEO_ID}`,
    `youtube.com/watch?v=${VIDEO_ID}&feature=share`,
    `https://youtu.be/${VIDEO_ID}?si=example`,
    `https://youtube.com/shorts/${VIDEO_ID}`,
    `https://www.youtube.com/embed/${VIDEO_ID}`,
  ];

  for (const input of inputs) {
    assert.equal(parseYouTubeVideoId(input), VIDEO_ID, input);
  }
});

test("supports official mobile, music, privacy, and live URL shapes", () => {
  const inputs = [
    `https://m.youtube.com/watch?v=${VIDEO_ID}`,
    `https://music.youtube.com/watch?v=${VIDEO_ID}`,
    `https://www.youtube-nocookie.com/embed/${VIDEO_ID}`,
    `https://www.youtube.com/live/${VIDEO_ID}`,
  ];

  for (const input of inputs) {
    assert.equal(parseYouTubeVideoId(input), VIDEO_ID, input);
  }
});

test("accepts a raw 11-character YouTube video ID", () => {
  assert.deepEqual(parseYouTubeUrl(VIDEO_ID), {
    videoId: VIDEO_ID,
    startSeconds: 0,
    canonicalUrl: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
  });
});

test("normalizes canonical links and common timestamp formats", () => {
  assert.deepEqual(
    parseYouTubeUrl(`https://youtu.be/${VIDEO_ID}?t=1m32s`),
    {
      videoId: VIDEO_ID,
      startSeconds: 92,
      canonicalUrl: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
    },
  );
  assert.equal(
    parseYouTubeUrl(`https://youtube.com/watch?v=${VIDEO_ID}&start=125`)
      ?.startSeconds,
    125,
  );
  assert.equal(
    parseYouTubeUrl(`https://youtube.com/watch?v=${VIDEO_ID}#t=1:02:03`)
      ?.startSeconds,
    3_723,
  );
});

test("rejects malformed, unsupported, and spoofed URLs", () => {
  const inputs = [
    "",
    "not a url",
    `https://example.com/watch?v=${VIDEO_ID}`,
    `https://youtube.com.evil.example/watch?v=${VIDEO_ID}`,
    `https://youtube.com/watch?v=too-short`,
    "https://youtube.com/watch?list=playlist-only",
    `javascript:https://youtube.com/watch?v=${VIDEO_ID}`,
    `https://user:password@youtube.com/watch?v=${VIDEO_ID}`,
    `https://youtu.be/${VIDEO_ID}/unexpected`,
  ];

  for (const input of inputs) {
    assert.equal(parseYouTubeUrl(input), null, input);
  }
});
