export type ClientCreateOperation = "album-create" | "riff-create" | "password-change";

type ClientStringStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type ClientCreateRequest = {
  operation: ClientCreateOperation;
  intent: string;
  requestId: string;
  storageKey: string;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function storageKey(operation: ClientCreateOperation): string {
  return `riff-sketchbook:create-request:${operation}`;
}

function parseStoredRequest(
  raw: string | null,
): { intent: string; requestId: string } | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const value = parsed as Record<string, unknown>;
    if (
      typeof value.intent !== "string" ||
      typeof value.requestId !== "string" ||
      !UUID_PATTERN.test(value.requestId)
    ) {
      return null;
    }
    return { intent: value.intent, requestId: value.requestId };
  } catch {
    return null;
  }
}

export function createClientOperationId(): string {
  const webCrypto = globalThis.crypto;
  if (typeof webCrypto?.randomUUID === "function") return webCrypto.randomUUID();

  const bytes = new Uint8Array(16);
  if (typeof webCrypto?.getRandomValues === "function") {
    webCrypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
    .slice(6, 8)
    .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

export function getOrCreateClientCreateRequest(
  storage: ClientStringStorage | null,
  operation: ClientCreateOperation,
  intent: string,
  createId: () => string = createClientOperationId,
): ClientCreateRequest {
  const key = storageKey(operation);
  if (storage) {
    try {
      const stored = parseStoredRequest(storage.getItem(key));
      if (stored?.intent === intent) {
        return { operation, intent, requestId: stored.requestId, storageKey: key };
      }
    } catch {
      // The in-memory caller fallback still keeps the active request stable.
    }
  }

  const request = { operation, intent, requestId: createId(), storageKey: key };
  if (storage) {
    try {
      storage.setItem(
        key,
        JSON.stringify({ intent: request.intent, requestId: request.requestId }),
      );
    } catch {
      // Session storage is best-effort; the active request still has its ID.
    }
  }
  return request;
}

export function completeClientCreateRequest(
  storage: ClientStringStorage | null,
  request: ClientCreateRequest,
): void {
  if (!storage) return;
  try {
    const stored = parseStoredRequest(storage.getItem(request.storageKey));
    if (
      stored?.requestId === request.requestId &&
      stored.intent === request.intent
    ) {
      storage.removeItem(request.storageKey);
    }
  } catch {
    // The committed server operation does not depend on browser cleanup.
  }
}

export function browserSessionStorage(): ClientStringStorage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}
