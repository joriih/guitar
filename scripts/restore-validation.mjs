import path from "node:path";

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
  const expected = new Set(expectedFiles.map(storageKey));
  const actual = new Set();
  for (const row of actualRows) {
    const storagePath = String(row.storage_path);
    const byteSize = Number(row.byte_size);
    if (
      path.basename(storagePath) !== storagePath ||
      (row.kind !== "take" && row.kind !== "track") ||
      !Number.isSafeInteger(byteSize) ||
      byteSize < 0
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

