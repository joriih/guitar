import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

// @ts-expect-error Node's type-stripping test runner requires the .ts extension.
import { ALBUM_COVERS, ALBUM_COVER_PATHS, DEFAULT_ALBUM_COVER, isAllowedAlbumCover } from "./album-covers.ts";

test("the local guitar cover catalog is the single complete allow-list", async () => {
  assert.ok(ALBUM_COVERS.length >= 12, "the picker should offer a real range of covers");
  assert.deepEqual(
    ALBUM_COVER_PATHS,
    ALBUM_COVERS.map(({ src }) => src),
  );
  assert.equal(new Set(ALBUM_COVER_PATHS).size, ALBUM_COVER_PATHS.length);
  assert.equal(DEFAULT_ALBUM_COVER, ALBUM_COVERS[0].src);
  for (const cover of ALBUM_COVERS) {
    assert.equal(isAllowedAlbumCover(cover.src), true);
    assert.equal(cover.label, cover.label.trim());
    assert.ok(cover.label.length > 0);
    assert.match(cover.src, /^\/assets\/guitars\/[a-z0-9-]+\.(?:avif|webp)$/);

    const asset = await stat(
      fileURLToPath(new URL(`../public${cover.src}`, import.meta.url)),
    );
    assert.equal(asset.isFile(), true, `${cover.src} must be a real file`);
  }
});

test("remote, traversal, blank, and non-string cover values are rejected", () => {
  for (const value of [
    "https://untrusted.invalid/guitar.jpg",
    "/assets/guitars/../private.png",
    "",
    null,
    undefined,
    1,
  ]) {
    assert.equal(isAllowedAlbumCover(value), false);
  }
});
