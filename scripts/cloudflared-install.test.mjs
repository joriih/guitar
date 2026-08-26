import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import test from "node:test";

import {
  assertSupportedCloudflaredPlatform,
  CLOUDFLARED_DARWIN_ARM64_ARCHIVE_SHA256,
  CLOUDFLARED_DARWIN_ARM64_SHA256,
  CLOUDFLARED_DARWIN_ARM64_URL,
  CLOUDFLARED_VERSION,
  extractVerifiedCloudflaredArchive,
  sha256,
} from "./cloudflared-install-core.mjs";

function tarArchive(name, contents) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000700\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(`${contents.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  header.write("ustar\0", 257, 6, "ascii");
  const checksum = header.reduce((sum, value) => sum + value, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  const padding = Buffer.alloc((512 - (contents.length % 512)) % 512);
  return gzipSync(Buffer.concat([header, contents, padding, Buffer.alloc(1024)]));
}

test("the installer pins the official Apple Silicon release and both digests", () => {
  assert.equal(CLOUDFLARED_VERSION, "2026.8.2");
  assert.equal(
    CLOUDFLARED_DARWIN_ARM64_URL,
    "https://github.com/cloudflare/cloudflared/releases/download/2026.8.2/cloudflared-darwin-arm64.tgz",
  );
  assert.match(CLOUDFLARED_DARWIN_ARM64_ARCHIVE_SHA256, /^[a-f0-9]{64}$/);
  assert.match(CLOUDFLARED_DARWIN_ARM64_SHA256, /^[a-f0-9]{64}$/);
  assert.notEqual(
    CLOUDFLARED_DARWIN_ARM64_ARCHIVE_SHA256,
    CLOUDFLARED_DARWIN_ARM64_SHA256,
  );
});

test("the installer verifies the archive and extracted executable", () => {
  const binary = Buffer.from("isolated verified cloudflared fixture\n");
  const archive = tarArchive("cloudflared", binary);
  assert.deepEqual(
    extractVerifiedCloudflaredArchive(archive, {
      expectedArchiveDigest: sha256(archive),
      expectedBinaryDigest: sha256(binary),
    }),
    binary,
  );

  const corrupted = Buffer.from(archive);
  corrupted[corrupted.length - 1] ^= 1;
  assert.throws(
    () =>
      extractVerifiedCloudflaredArchive(corrupted, {
        expectedArchiveDigest: sha256(archive),
        expectedBinaryDigest: sha256(binary),
      }),
    /무결성/,
  );

  const unexpected = tarArchive("not-cloudflared", binary);
  assert.throws(
    () =>
      extractVerifiedCloudflaredArchive(unexpected, {
        expectedArchiveDigest: sha256(unexpected),
        expectedBinaryDigest: sha256(binary),
      }),
    /예상하지 않은/,
  );
});

test("the pinned sharing binary is Apple Silicon macOS only", () => {
  assert.doesNotThrow(() => assertSupportedCloudflaredPlatform("darwin", "arm64"));
  assert.throws(
    () => assertSupportedCloudflaredPlatform("linux", "arm64"),
    /Apple Silicon/,
  );
  assert.throws(
    () => assertSupportedCloudflaredPlatform("darwin", "x64"),
    /Apple Silicon/,
  );
});
