import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const JOURNAL_NAME = ".restore-journal.json";
const RESTORE_ARTIFACT_PATTERNS = [
  /^\.restore-journal\..+\.tmp$/,
  /^\.restore-incoming-.+$/,
  /^\.restore-work-.+$/,
  /^\.restore-previous-.+$/,
  /^\.restore-failed-.+$/,
];

function storageDirectory(root) {
  return path.join(path.resolve(root ?? process.cwd()), "storage");
}

function journalPath(root) {
  return path.join(storageDirectory(root), JOURNAL_NAME);
}

async function lstatOrNull(filePath) {
  return lstat(filePath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
}

async function syncDirectory(directoryPath) {
  const handle = await open(directoryPath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensurePrivateStorage(root) {
  const directoryPath = storageDirectory(root);
  await mkdir(directoryPath, { recursive: true, mode: DIRECTORY_MODE });
  const directoryStat = await lstat(directoryPath);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error("storage 경로가 안전한 로컬 폴더가 아니에요.");
  }
  await chmod(directoryPath, DIRECTORY_MODE);
  return directoryPath;
}

function assertJournalValue(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("복원 저널 내용이 올바르지 않아요.");
  }
}

export async function listIncompleteRestoreArtifacts(root) {
  const directoryPath = storageDirectory(root);
  const directoryStat = await lstatOrNull(directoryPath);
  if (!directoryStat) return [];
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error("storage 경로가 안전한 로컬 폴더가 아니에요.");
  }

  const entries = await readdir(directoryPath, { withFileTypes: true });
  return entries
    .map((entry) => entry.name)
    .filter(
      (name) =>
        name === JOURNAL_NAME ||
        RESTORE_ARTIFACT_PATTERNS.some((pattern) => pattern.test(name)),
    )
    .sort((left, right) => left.localeCompare(right));
}

export async function assertNoIncompleteRestoreState(root) {
  const artifacts = await listIncompleteRestoreArtifacts(root);
  if (!artifacts.length) return;
  throw new Error(
    [
      "완전히 끝나지 않은 복원 흔적이 있어 안전을 위해 작업을 시작하지 않았어요.",
      `storage 폴더의 다음 항목을 삭제하거나 옮기지 말고 복구 안내를 확인해주세요: ${artifacts.join(", ")}`,
    ].join("\n"),
  );
}

export async function writeRestoreJournal(value, { root, initial = false } = {}) {
  assertJournalValue(value);
  const directoryPath = await ensurePrivateStorage(root);
  const destination = journalPath(root);
  const existing = await lstatOrNull(destination);
  if (initial && existing) {
    throw new Error("미완료 복원 저널이 이미 있어 새 복원을 시작하지 않았어요.");
  }
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
    throw new Error("복원 저널 경로가 안전한 일반 파일이 아니에요.");
  }
  if (!initial && !existing) {
    throw new Error("업데이트할 복원 저널을 찾을 수 없어요.");
  }

  const temporaryPath = path.join(
    directoryPath,
    `.restore-journal.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await open(temporaryPath, "wx", FILE_MODE);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await chmod(temporaryPath, FILE_MODE);
    await rename(temporaryPath, destination);
    await syncDirectory(directoryPath);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export async function clearRestoreJournal({ root } = {}) {
  const destination = journalPath(root);
  const existing = await lstatOrNull(destination);
  if (!existing) return;
  if (!existing.isFile() || existing.isSymbolicLink()) {
    throw new Error("복원 저널 경로가 안전한 일반 파일이 아니에요.");
  }
  await unlink(destination);
  await syncDirectory(storageDirectory(root));
}

export const RESTORE_JOURNAL_NAME = JOURNAL_NAME;
