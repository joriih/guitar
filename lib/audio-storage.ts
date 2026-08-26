import { createReadStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir, unlink, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";

import { ApiError } from "@/lib/http";
import { preflightAudioFile } from "@/lib/audio-file-format";
import { isValidAudioStoragePath } from "@/lib/audio-storage-path";

export { normalizeMimeType } from "@/lib/audio-file-format";

const ISOLATED_NAMESPACE_PATTERN =
  /^riff_sketchbook_e2e_[1-9][0-9]*_[a-f0-9]{10}$/;

function isolatedStorageNamespace(): string | null {
  const namespace = process.env.AUDIO_STORAGE_NAMESPACE;
  if (!namespace) return null;
  if (!ISOLATED_NAMESPACE_PATTERN.test(namespace)) {
    throw new Error("Invalid isolated audio storage namespace.");
  }
  return namespace;
}

function storageDirectory(): string {
  const namespace = isolatedStorageNamespace();
  if (namespace) {
    return path.join(process.cwd(), "storage", "e2e", namespace);
  }
  return path.join(process.cwd(), "storage", "audio");
}

async function safeStorageDirectoryExists(): Promise<boolean> {
  const namespace = isolatedStorageNamespace();
  const directories = [path.join(process.cwd(), "storage")];
  if (namespace) directories.push(path.join(process.cwd(), "storage", "e2e"));
  directories.push(storageDirectory());

  for (const directory of directories) {
    const directoryStat = await lstat(directory).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (!directoryStat) return false;
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      const unsafeError = new Error("Audio cleanup storage directory is unsafe.");
      Object.assign(unsafeError, { code: "UNSAFE_STORAGE_DIRECTORY" });
      throw unsafeError;
    }
  }
  return true;
}

async function ensureStorageDirectory() {
  const directory = storageDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

export function sanitizeOriginalName(value: string): string {
  const base = path.basename(value).replace(/[^\p{L}\p{N}._ -]/gu, "_").trim();
  return (base || "recording").slice(0, 255);
}

export async function saveAudioFile(file: File): Promise<{
  storagePath: string;
  originalFileName: string;
  mimeType: string;
  byteSize: number;
}> {
  const preflight = preflightAudioFile(file);
  if (!preflight.ok) throw new ApiError(preflight.status, preflight.message);
  const { extension, mimeType } = preflight.format;

  const storagePath = `${randomUUID()}.${extension}`;
  await ensureStorageDirectory();
  await writeFile(
    resolveAudioPath(storagePath),
    Buffer.from(await file.arrayBuffer()),
    { flag: "wx", mode: 0o600 },
  );

  return {
    storagePath,
    originalFileName: sanitizeOriginalName(file.name),
    mimeType,
    byteSize: file.size,
  };
}

export function resolveAudioPath(storagePath: string): string {
  if (!isValidAudioStoragePath(storagePath)) {
    throw new ApiError(404, "녹음 파일을 찾을 수 없어요.");
  }

  const namespace = isolatedStorageNamespace();
  if (namespace) {
    // Keeping the static storage/e2e prefix in this expression prevents the
    // server-file tracer from treating a runtime audio filename as project-wide access.
    return path.join(process.cwd(), "storage", "e2e", namespace, storagePath);
  }
  return path.join(process.cwd(), "storage", "audio", storagePath);
}

export async function removeAudioFile(storagePath: string): Promise<void> {
  const absolutePath = resolveAudioPath(storagePath);
  if (!(await safeStorageDirectoryExists())) return;

  const fileStat = await lstat(absolutePath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (!fileStat) return;
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
    const unsafeError = new Error("Audio cleanup target is not a safe regular file.");
    Object.assign(unsafeError, { code: "UNSAFE_AUDIO_TARGET" });
    throw unsafeError;
  }

  try {
    // unlink never follows a final-component symlink. The lstat above also
    // refuses existing links so queued cleanup cannot touch a link target.
    await unlink(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function duplicateAudioFile(storagePath: string): Promise<string> {
  const sourcePath = resolveAudioPath(storagePath);
  const extension = path.extname(storagePath);
  const duplicatePath = `${randomUUID()}${extension}`;
  const destinationPath = resolveAudioPath(duplicatePath);
  await ensureStorageDirectory();
  let copied = false;
  try {
    await copyFile(sourcePath, destinationPath, fsConstants.COPYFILE_EXCL);
    copied = true;
    await chmod(destinationPath, 0o600);
  } catch (error) {
    if (!copied) throw error;
    try {
      await unlink(destinationPath);
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new AggregateError(
          [error, cleanupError],
          "Could not clean up an incomplete audio duplicate.",
        );
      }
    }
    throw error;
  }
  return duplicatePath;
}

export function audioStreamResponse(options: {
  request: Request;
  absolutePath: string;
  mimeType: string;
  byteSize: number;
  fileName: string;
}): Response {
  const { request, absolutePath, mimeType, byteSize, fileName } = options;
  const range = request.headers.get("range");
  const baseHeaders = new Headers({
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
    "Content-Type": mimeType,
    "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    "X-Content-Type-Options": "nosniff",
  });
  const rangeNotSatisfiable = () => {
    const headers = new Headers(baseHeaders);
    headers.set("Content-Range", `bytes */${byteSize}`);
    return new Response(null, { status: 416, headers });
  };

  if (!range) {
    baseHeaders.set("Content-Length", String(byteSize));
    const stream = createReadStream(absolutePath);
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: 200,
      headers: baseHeaders,
    });
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!match || (!match[1] && !match[2])) {
    return rangeNotSatisfiable();
  }

  let start: number;
  let end: number;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return rangeNotSatisfiable();
    }
    start = Math.max(0, byteSize - suffixLength);
    end = byteSize - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : byteSize - 1;
  }

  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= byteSize ||
    end < start
  ) {
    return rangeNotSatisfiable();
  }
  end = Math.min(end, byteSize - 1);

  baseHeaders.set("Content-Length", String(end - start + 1));
  baseHeaders.set("Content-Range", `bytes ${start}-${end}/${byteSize}`);
  const stream = createReadStream(absolutePath, { start, end });
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    status: 206,
    headers: baseHeaders,
  });
}
