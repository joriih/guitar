import { createClientRecordingId } from "./utils";

const DATABASE_NAME = "riff-sketchbook-recording-recovery";
const DATABASE_VERSION = 1;
const STORE_NAME = "recordings";
const RIFF_INDEX = "by-riff";

const operationQueues = new Map<string, Promise<void>>();
let persistenceRequest: Promise<boolean> | null = null;

export type StoredPendingRecording = {
  id: string;
  riffId: string;
  blob: Blob;
  durationMs: number;
  mimeType: string;
  offsetMs: number;
  createdAt: number;
};

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("이 브라우저에서는 녹음 복구 저장소를 사용할 수 없어요."));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      const store = database.objectStoreNames.contains(STORE_NAME)
        ? request.transaction?.objectStore(STORE_NAME)
        : database.createObjectStore(STORE_NAME, { keyPath: "id" });
      if (store && !store.indexNames.contains(RIFF_INDEX)) {
        store.createIndex(RIFF_INDEX, "riffId", { unique: false });
      }
    };
    request.onerror = () => {
      settled = true;
      reject(request.error ?? new Error("녹음 복구 저장소를 열지 못했어요."));
    };
    request.onblocked = () => {
      settled = true;
      reject(new Error("다른 탭에서 녹음 복구 저장소를 사용 중이에요."));
    };
    request.onsuccess = () => {
      const database = request.result;
      if (settled) {
        database.close();
        return;
      }
      settled = true;
      database.onversionchange = () => database.close();
      resolve(database);
    };
  });
}

function transactionFinished(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("녹음 복구 저장에 실패했어요."));
    transaction.onabort = () => reject(transaction.error ?? new Error("녹음 복구 저장이 취소됐어요."));
  });
}

export function createPendingRecordingId(): string {
  return createClientRecordingId();
}

function serializeOperation(id: string, operation: () => Promise<void>): Promise<void> {
  const previous = operationQueues.get(id) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  operationQueues.set(id, current);
  return current.finally(() => {
    if (operationQueues.get(id) === current) operationQueues.delete(id);
  });
}

/**
 * Asks the browser not to evict unfinished recordings under storage pressure.
 * Browsers generally resolve this without a prompt, and unsupported browsers
 * simply return false.
 */
export function requestPersistentRecordingStorage(): Promise<boolean> {
  if (persistenceRequest) return persistenceRequest;
  persistenceRequest = (async () => {
    if (typeof navigator === "undefined" || !navigator.storage?.persist) return false;
    try {
      if (await navigator.storage.persisted?.()) return true;
      return await navigator.storage.persist();
    } catch {
      return false;
    }
  })();
  return persistenceRequest;
}

export function recoveryStorageErrorMessage(error: unknown): string {
  const name =
    typeof error === "object" && error !== null && "name" in error
      ? String((error as { name?: unknown }).name ?? "")
      : "";
  if (name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED") {
    return "브라우저 저장 공간이 부족해 자동 복구본을 남기지 못했어요. 녹음을 끝낸 뒤 파일을 바로 내려받아 주세요.";
  }
  if (name === "SecurityError") {
    return "브라우저의 비공개 모드나 저장소 설정 때문에 자동 복구본을 남기지 못했어요.";
  }
  return "브라우저 복구 저장소를 사용할 수 없어요. 이 탭을 닫기 전에 녹음을 내려받아 주세요.";
}

async function savePendingRecordingNow(recording: StoredPendingRecording): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const existingRequest = store.get(recording.id);
    existingRequest.onsuccess = () => {
      const existing = existingRequest.result as StoredPendingRecording | undefined;
      // An unmount snapshot and MediaRecorder's final event can race. Never let
      // the earlier, shorter snapshot overwrite the completed recording.
      if (!existing || recording.blob.size >= existing.blob.size) {
        store.put(recording);
      }
    };
    await transactionFinished(transaction);
  } finally {
    database.close();
  }
}

export function savePendingRecording(recording: StoredPendingRecording): Promise<void> {
  return serializeOperation(recording.id, () => savePendingRecordingNow(recording));
}

export async function listPendingRecordings(riffId: string): Promise<StoredPendingRecording[]> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const request = transaction
      .objectStore(STORE_NAME)
      .index(RIFF_INDEX)
      .getAll(IDBKeyRange.only(riffId));
    const rows = await new Promise<StoredPendingRecording[]>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result as StoredPendingRecording[]);
      request.onerror = () => reject(request.error ?? new Error("복구할 녹음을 읽지 못했어요."));
    });
    await transactionFinished(transaction);
    return rows.sort((a, b) => a.createdAt - b.createdAt);
  } finally {
    database.close();
  }
}

async function deletePendingRecordingNow(id: string): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(id);
    await transactionFinished(transaction);
  } finally {
    database.close();
  }
}

export function deletePendingRecording(id: string): Promise<void> {
  return serializeOperation(id, () => deletePendingRecordingNow(id));
}
