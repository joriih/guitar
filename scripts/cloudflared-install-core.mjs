import { createHash } from "node:crypto";
import path from "node:path";
import { gunzipSync } from "node:zlib";

export const CLOUDFLARED_VERSION = "2026.8.2";
export const CLOUDFLARED_RELATIVE_PATH = path.join(
  ".local-tools",
  "cloudflared",
);
export const CLOUDFLARED_DARWIN_ARM64_URL =
  `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-darwin-arm64.tgz`;

// GitHub's release-asset digest covers the downloaded gzip archive. The
// release notes publish the second digest for the extracted executable.
export const CLOUDFLARED_DARWIN_ARM64_ARCHIVE_SHA256 =
  "9042c2c5d8b2de78e60f313d5fb31b6c5c1cebde787a3caf1f2c9588084ac442";
export const CLOUDFLARED_DARWIN_ARM64_SHA256 =
  "b61054d3d6326ea558cb49826eebf5676e0d0a36d51b546975096ca3e0e3c89d";

const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAX_BINARY_BYTES = 64 * 1024 * 1024;
const TAR_BLOCK_BYTES = 512;

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function assertSupportedCloudflaredPlatform(
  platform = process.platform,
  architecture = process.arch,
) {
  if (platform !== "darwin" || architecture !== "arm64") {
    throw new Error(
      `이 공유 기능의 cloudflared ${CLOUDFLARED_VERSION}은 Apple Silicon Mac용이에요.`,
    );
  }
}

function tarString(block, offset, length) {
  const field = block.subarray(offset, offset + length);
  const zero = field.indexOf(0);
  return field.subarray(0, zero === -1 ? field.length : zero).toString("utf8");
}

function tarSize(block) {
  const value = tarString(block, 124, 12).trim();
  if (!/^[0-7]+$/.test(value)) {
    throw new Error("Cloudflare 공유 도구 압축 파일 구조가 올바르지 않아요.");
  }
  const size = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_BINARY_BYTES) {
    throw new Error("Cloudflare 공유 도구 크기가 올바르지 않아요.");
  }
  return size;
}

function isZeroBlock(block) {
  return block.every((value) => value === 0);
}

export function extractVerifiedCloudflaredArchive(
  archiveValue,
  {
    expectedArchiveDigest = CLOUDFLARED_DARWIN_ARM64_ARCHIVE_SHA256,
    expectedBinaryDigest = CLOUDFLARED_DARWIN_ARM64_SHA256,
  } = {},
) {
  const archive = Buffer.from(archiveValue);
  if (archive.length < 1 || archive.length > MAX_ARCHIVE_BYTES) {
    throw new Error("Cloudflare 공유 도구 다운로드 크기가 올바르지 않아요.");
  }
  if (sha256(archive) !== expectedArchiveDigest) {
    throw new Error("Cloudflare 공유 도구 다운로드의 무결성 검사에 실패했어요.");
  }

  let tar;
  try {
    tar = gunzipSync(archive, { maxOutputLength: MAX_BINARY_BYTES + 2 * 1024 * 1024 });
  } catch {
    throw new Error("Cloudflare 공유 도구 압축을 안전하게 풀지 못했어요.");
  }

  let binary = null;
  let foundEnd = false;
  for (let offset = 0; offset + TAR_BLOCK_BYTES <= tar.length; ) {
    const header = tar.subarray(offset, offset + TAR_BLOCK_BYTES);
    if (isZeroBlock(header)) {
      foundEnd = true;
      break;
    }

    const name = tarString(header, 0, 100);
    const type = String.fromCharCode(header[156] || 48);
    const size = tarSize(header);
    const contentStart = offset + TAR_BLOCK_BYTES;
    const contentEnd = contentStart + size;
    if (contentEnd > tar.length) {
      throw new Error("Cloudflare 공유 도구 압축 파일이 잘렸어요.");
    }
    if (name !== "cloudflared" || type !== "0" || binary !== null) {
      throw new Error("Cloudflare 공유 도구 압축 파일에 예상하지 않은 항목이 있어요.");
    }
    binary = Buffer.from(tar.subarray(contentStart, contentEnd));
    offset = contentStart + Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
  }

  if (!foundEnd || binary === null) {
    throw new Error("Cloudflare 공유 도구 압축 파일 구조가 올바르지 않아요.");
  }
  if (sha256(binary) !== expectedBinaryDigest) {
    throw new Error("Cloudflare 공유 도구 실행 파일의 무결성 검사에 실패했어요.");
  }
  return binary;
}
