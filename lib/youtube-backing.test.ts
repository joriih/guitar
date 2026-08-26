import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error Node's type-stripping test runner requires the .ts extension.
import { canonicalYouTubeUrl, parseYouTubeVideoId } from "./youtube-backing.ts";

const videoId = "dQw4w9WgXcQ";

test("YouTube parser accepts supported public URL shapes", () => {
  for (const input of [
    videoId,
    `https://www.youtube.com/watch?v=${videoId}&t=12`,
    `https://youtu.be/${videoId}?si=example`,
    `https://www.youtube.com/shorts/${videoId}`,
    `https://www.youtube.com/embed/${videoId}`,
    `https://www.youtube.com/live/${videoId}`,
    `https://www.youtube-nocookie.com/embed/${videoId}`,
    `https://music.youtube.com/watch?v=${videoId}`,
  ]) {
    assert.equal(parseYouTubeVideoId(input), videoId, input);
  }
});

test("YouTube parser rejects lookalikes and malformed IDs", () => {
  for (const input of [
    "",
    "not-video",
    "https://example.com/watch?v=dQw4w9WgXcQ",
    "https://youtube.com.example.test/watch?v=dQw4w9WgXcQ",
    "javascript:alert(1)",
    "https://youtu.be/too-short",
  ]) {
    assert.equal(parseYouTubeVideoId(input), null, input);
  }
});

test("canonical URL is generated only for a valid video ID", () => {
  assert.equal(
    canonicalYouTubeUrl(videoId),
    `https://www.youtube.com/watch?v=${videoId}`,
  );
  assert.throws(() => canonicalYouTubeUrl("bad"));
});
