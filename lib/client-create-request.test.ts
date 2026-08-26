import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error Node's type-stripping test runner requires the .ts extension.
import { completeClientCreateRequest, getOrCreateClientCreateRequest } from "./client-create-request.ts";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

test("create request IDs survive response-loss retries for the same form intent", () => {
  const storage = memoryStorage();
  const firstId = "10000000-0000-4000-8000-000000000001";
  const first = getOrCreateClientCreateRequest(
    storage,
    "album-create",
    '{"name":"Night Drive"}',
    () => firstId,
  );
  const retry = getOrCreateClientCreateRequest(
    storage,
    "album-create",
    first.intent,
    () => {
      throw new Error("the stored request ID must be reused");
    },
  );
  assert.equal(retry.requestId, firstId);
});

test("changed intents rotate keys and completion cannot erase a racing intent", () => {
  const storage = memoryStorage();
  const first = getOrCreateClientCreateRequest(
    storage,
    "riff-create",
    '{"title":"A"}',
    () => "10000000-0000-4000-8000-000000000001",
  );
  const second = getOrCreateClientCreateRequest(
    storage,
    "riff-create",
    '{"title":"B"}',
    () => "20000000-0000-4000-8000-000000000002",
  );
  assert.notEqual(second.requestId, first.requestId);

  completeClientCreateRequest(storage, first);
  assert.ok(storage.values.has(second.storageKey));
  completeClientCreateRequest(storage, second);
  assert.equal(storage.values.has(second.storageKey), false);
});

test("operation namespaces never share a stored request ID", () => {
  const storage = memoryStorage();
  const album = getOrCreateClientCreateRequest(
    storage,
    "album-create",
    "same",
    () => "10000000-0000-4000-8000-000000000001",
  );
  const riff = getOrCreateClientCreateRequest(
    storage,
    "riff-create",
    "same",
    () => "20000000-0000-4000-8000-000000000002",
  );
  assert.notEqual(album.storageKey, riff.storageKey);
  assert.notEqual(album.requestId, riff.requestId);
});
