import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {
  assertSupportedCloudflaredPlatform,
  CLOUDFLARED_DARWIN_ARM64_URL,
  CLOUDFLARED_RELATIVE_PATH,
  CLOUDFLARED_VERSION,
  extractVerifiedCloudflaredArchive,
} from "./cloudflared-install-core.mjs";
import { assertBundledCloudflared } from "./cloudflare-quick-share-core.mjs";

const PROJECT_ROOT = path.resolve(process.cwd());
const MAX_DOWNLOAD_BYTES = 32 * 1024 * 1024;

async function downloadPinnedArchive() {
  const response = await fetch(CLOUDFLARED_DARWIN_ARM64_URL, {
    headers: { "User-Agent": "riff-sketchbook-cloudflared-installer" },
    redirect: "follow",
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok || !response.body) {
    throw new Error(
      `Cloudflare 공유 도구를 다운로드하지 못했어요 (${response.status}).`,
    );
  }

  const declaredSize = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_DOWNLOAD_BYTES) {
    throw new Error("Cloudflare 공유 도구 다운로드가 예상보다 커요.");
  }

  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    totalBytes += bytes.length;
    if (totalBytes > MAX_DOWNLOAD_BYTES) {
      throw new Error("Cloudflare 공유 도구 다운로드가 예상보다 커요.");
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, totalBytes);
}

async function ensurePrivateToolsDirectory(toolsDirectory) {
  await mkdir(toolsDirectory, { recursive: true, mode: 0o700 });
  const directoryStat = await lstat(toolsDirectory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error("공유 도구 폴더가 안전한 로컬 폴더가 아니에요.");
  }
  await chmod(toolsDirectory, 0o700);
}

async function install() {
  assertSupportedCloudflaredPlatform();
  const target = path.join(PROJECT_ROOT, CLOUDFLARED_RELATIVE_PATH);
  const toolsDirectory = path.dirname(target);
  await ensurePrivateToolsDirectory(toolsDirectory);

  const existing = await lstat(target).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
    throw new Error("공유 도구 설치 위치가 안전한 일반 파일이 아니에요.");
  }

  console.log(`cloudflared ${CLOUDFLARED_VERSION}을 공식 GitHub 릴리스에서 받고 있어요…`);
  const archive = await downloadPinnedArchive();
  const binary = extractVerifiedCloudflaredArchive(archive);
  const staged = `${target}.install-${randomUUID()}`;
  try {
    await writeFile(staged, binary, { flag: "wx", mode: 0o700 });
    await chmod(staged, 0o700);
    await rename(staged, target);
    await chmod(target, 0o700);
    await assertBundledCloudflared(PROJECT_ROOT);
  } finally {
    await rm(staged, { force: true });
  }

  console.log(`검증된 cloudflared ${CLOUDFLARED_VERSION} 설치가 끝났어요.`);
  console.log("Share Riff Sketchbook.command를 열어 임시 공유를 시작할 수 있어요.");
}

try {
  await install();
} catch (error) {
  console.error(
    error instanceof Error
      ? error.message
      : "Cloudflare 공유 도구를 설치하지 못했어요.",
  );
  process.exitCode = 1;
}
