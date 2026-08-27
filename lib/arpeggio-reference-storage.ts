import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";

// @ts-expect-error Node's type-stripping test runner requires the .ts extension.
import { isSafeArpeggioReferenceFileName } from "./arpeggio-reference.ts";

const REFERENCE_DIRECTORY_PARTS = [
  "storage",
  "reference-library",
  "guitar-chords",
  "arpeggios",
] as const;
const MANIFEST_FILE_NAME = "manifest.json";
const EXPECTED_SOURCE = "https://www.guitar-chords.org.uk";
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_MANIFEST_IMAGES = 1_024;
const MAX_IMAGE_BYTES = 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const EXPECTED_IMAGE_URL_PREFIX = `${EXPECTED_SOURCE}/arpeggio-images/`;
const EXPECTED_PAGE_URL_PREFIX = `${EXPECTED_SOURCE}/arpeggios/`;

type DirectoryIdentity = {
  absolutePath: string;
  device: number;
  inode: number;
};

type DirectorySnapshot = {
  directory: string;
  identities: readonly DirectoryIdentity[];
};

export type ArpeggioReferenceManifestEntry = {
  fileName: string;
  byteSize: number;
  sha256: string;
};

export type ArpeggioReferenceImage = {
  bytes: Uint8Array;
  fileName: string;
};

function errorCode(error: unknown): string | null {
  return error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : null;
}

function isCleanAbsence(error: unknown): boolean {
  return new Set(["EACCES", "ELOOP", "ENOENT", "ENOTDIR", "EPERM"]).has(errorCode(error) ?? "");
}

async function captureDirectorySnapshot(rootDirectory: string): Promise<DirectorySnapshot | null> {
  // This directory is mutable user data copied separately by the Mac installer.
  // It must never be bundled into .next by output-file tracing.
  const canonicalRoot = await realpath(
    /* turbopackIgnore: true */ path.resolve(rootDirectory),
  );
  const identities: DirectoryIdentity[] = [];
  let current = canonicalRoot;

  for (const part of REFERENCE_DIRECTORY_PARTS) {
    current = path.join(/* turbopackIgnore: true */ current, part);
    const entry = await lstat(/* turbopackIgnore: true */ current);
    if (!entry.isDirectory() || entry.isSymbolicLink()) return null;
    if (await realpath(/* turbopackIgnore: true */ current) !== current) return null;
    identities.push({ absolutePath: current, device: entry.dev, inode: entry.ino });
  }

  return { directory: current, identities };
}

async function directorySnapshotIsCurrent(snapshot: DirectorySnapshot): Promise<boolean> {
  for (const identity of snapshot.identities) {
    const entry = await lstat(/* turbopackIgnore: true */ identity.absolutePath);
    if (
      !entry.isDirectory()
      || entry.isSymbolicLink()
      || entry.dev !== identity.device
      || entry.ino !== identity.inode
      || await realpath(/* turbopackIgnore: true */ identity.absolutePath) !== identity.absolutePath
    ) {
      return false;
    }
  }
  return true;
}

async function safelyOpenRegularFile(
  absolutePath: string,
  maximumBytes: number,
): Promise<{ handle: FileHandle; device: number; inode: number; byteSize: number } | null> {
  const handle = await open(
    /* turbopackIgnore: true */ absolutePath,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    const entry = await handle.stat();
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size <= 0 || entry.size > maximumBytes) {
      await handle.close();
      return null;
    }
    return {
      handle,
      device: entry.dev,
      inode: entry.ino,
      byteSize: entry.size,
    };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function openedPathIsCurrent(
  absolutePath: string,
  opened: { device: number; inode: number },
): Promise<boolean> {
  const entry = await lstat(/* turbopackIgnore: true */ absolutePath);
  return entry.isFile()
    && !entry.isSymbolicLink()
    && entry.dev === opened.device
    && entry.ino === opened.inode;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseArpeggioReferenceManifest(
  source: string,
): ReadonlyMap<string, ArpeggioReferenceManifestEntry> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return null;
  }
  if (
    !isObject(parsed)
    || parsed.source !== EXPECTED_SOURCE
    || parsed.personalReferenceOnly !== true
    || !Array.isArray(parsed.images)
    || parsed.images.length > MAX_MANIFEST_IMAGES
  ) {
    return null;
  }

  const entries = new Map<string, ArpeggioReferenceManifestEntry>();
  for (const value of parsed.images) {
    if (!isObject(value)) return null;
    const { fileName, sourceURL, pageURL, byteSize, sha256 } = value;
    if (
      !isSafeArpeggioReferenceFileName(fileName)
      || sourceURL !== `${EXPECTED_IMAGE_URL_PREFIX}${fileName}`
      || typeof pageURL !== "string"
      || !pageURL.startsWith(EXPECTED_PAGE_URL_PREFIX)
      || !Number.isSafeInteger(byteSize)
      || (byteSize as number) <= 0
      || (byteSize as number) > MAX_IMAGE_BYTES
      || typeof sha256 !== "string"
      || !SHA256_PATTERN.test(sha256)
      || entries.has(fileName)
    ) {
      return null;
    }
    entries.set(fileName, { fileName, byteSize: byteSize as number, sha256 });
  }
  return entries;
}

/**
 * Reads only a manifest-authorized, unchanged PNG from the private reference
 * directory. Unsafe paths and an absent library intentionally look identical.
 */
export async function readArpeggioReferenceImage(
  fileName: string,
  rootDirectory = process.cwd(),
): Promise<ArpeggioReferenceImage | null> {
  if (!isSafeArpeggioReferenceFileName(fileName) || path.basename(fileName) !== fileName) {
    return null;
  }

  let manifestFile: Awaited<ReturnType<typeof safelyOpenRegularFile>> = null;
  let imageFile: Awaited<ReturnType<typeof safelyOpenRegularFile>> = null;
  try {
    const snapshot = await captureDirectorySnapshot(rootDirectory);
    if (!snapshot) return null;

    const manifestPath = path.join(
      /* turbopackIgnore: true */ snapshot.directory,
      MANIFEST_FILE_NAME,
    );
    manifestFile = await safelyOpenRegularFile(manifestPath, MAX_MANIFEST_BYTES);
    if (!manifestFile) return null;
    const manifestBytes = await manifestFile.handle.readFile();
    const manifest = parseArpeggioReferenceManifest(manifestBytes.toString("utf8"));
    const expectedImage = manifest?.get(fileName);
    if (!expectedImage) return null;
    if (!await openedPathIsCurrent(manifestPath, manifestFile)) return null;

    const imagePath = path.join(
      /* turbopackIgnore: true */ snapshot.directory,
      fileName,
    );
    imageFile = await safelyOpenRegularFile(imagePath, MAX_IMAGE_BYTES);
    if (!imageFile || imageFile.byteSize !== expectedImage.byteSize) return null;
    const imageBytes = await imageFile.handle.readFile();
    if (
      imageBytes.length !== expectedImage.byteSize
      || !imageBytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
      || createHash("sha256").update(imageBytes).digest("hex") !== expectedImage.sha256
      || !await openedPathIsCurrent(imagePath, imageFile)
      || !await directorySnapshotIsCurrent(snapshot)
    ) {
      return null;
    }

    return { bytes: new Uint8Array(imageBytes), fileName };
  } catch (error) {
    if (isCleanAbsence(error)) return null;
    throw error;
  } finally {
    await Promise.all([
      manifestFile?.handle.close().catch(() => undefined),
      imageFile?.handle.close().catch(() => undefined),
    ]);
  }
}
