import path from "node:path";

const RESTORABLE_AUDIO_PATH_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.(?:webm|ogg|wav|aiff|mp3|m4a|aac|flac|opus)$/i;

export function isRestorableAudioStoragePath(value) {
  return (
    typeof value === "string" &&
    path.basename(value) === value &&
    RESTORABLE_AUDIO_PATH_PATTERN.test(value)
  );
}

export function assertRestoredCounts(actual, expected) {
  for (const key of Object.keys(expected)) {
    if (Number(actual?.[key]) !== Number(expected[key])) {
      throw new Error(`복원 후 ${key} 개수가 백업 정보와 일치하지 않아요.`);
    }
  }
}

function storageKey(item) {
  return `${item.kind}\u0000${item.name ?? item.storage_path}\u0000${String(
    item.bytes ?? item.byte_size,
  )}`;
}

export function assertStorageExact(actualRows, expectedFiles) {
  const expected = new Set();
  for (const item of expectedFiles) {
    const storagePath = item.name ?? item.storage_path;
    const byteSize = Number(item.bytes ?? item.byte_size);
    if (
      !isRestorableAudioStoragePath(storagePath) ||
      (item.kind !== "take" && item.kind !== "track") ||
      !Number.isSafeInteger(byteSize) ||
      byteSize <= 0
    ) {
      throw new Error("manifest에 안전하지 않은 오디오 정보가 있어요.");
    }
    const key = storageKey({
      kind: item.kind,
      name: storagePath,
      bytes: byteSize,
    });
    if (expected.has(key)) {
      throw new Error(`manifest에 중복 오디오 정보가 있어요: ${storagePath}`);
    }
    expected.add(key);
  }
  const actual = new Set();
  for (const row of actualRows) {
    const storagePath = String(row.storage_path);
    const byteSize = Number(row.byte_size);
    if (
      !isRestorableAudioStoragePath(storagePath) ||
      (row.kind !== "take" && row.kind !== "track") ||
      !Number.isSafeInteger(byteSize) ||
      byteSize <= 0
    ) {
      throw new Error("복원된 데이터베이스에 안전하지 않은 오디오 정보가 있어요.");
    }
    const key = storageKey({ kind: row.kind, name: storagePath, bytes: byteSize });
    if (actual.has(key)) {
      throw new Error(`복원된 데이터베이스에 중복 오디오 정보가 있어요: ${storagePath}`);
    }
    actual.add(key);
  }
  if (actual.size !== expected.size) {
    throw new Error("복원된 데이터베이스와 manifest의 오디오 파일 수가 달라요.");
  }
  for (const key of expected) {
    if (!actual.has(key)) {
      throw new Error("복원된 데이터베이스와 manifest의 오디오 정보가 일치하지 않아요.");
    }
  }
}

export function databaseStateMatchesManifest(actual, expectedCounts, expectedFiles) {
  try {
    assertRestoredCounts(actual.counts, expectedCounts);
    assertStorageExact(actual.storage, expectedFiles);
    return true;
  } catch {
    return false;
  }
}
