import { createHash } from "node:crypto";
import type { PoolClient } from "pg";

export type LibraryCreateOperation = "album_create" | "riff_create";

type ExistingCreateRequest = {
  payload_sha256: string;
  resource_id: string;
};

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalValue(item)]),
  );
}

export function libraryCreatePayloadDigest(
  operation: LibraryCreateOperation,
  payload: unknown,
): string {
  return createHash("sha256")
    .update(JSON.stringify([operation, canonicalValue(payload)]))
    .digest("hex");
}

export async function claimLibraryCreateRequest(
  client: PoolClient,
  input: {
    operation: LibraryCreateOperation;
    requestId: string;
    payloadSha256: string;
    proposedResourceId: string;
  },
): Promise<
  | { kind: "claimed"; resourceId: string }
  | { kind: "replay"; resourceId: string }
  | { kind: "conflict" }
> {
  const claimed = await client.query<{ resource_id: string }>(
    `INSERT INTO library_create_request
       (operation, request_id, payload_sha256, resource_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (operation, request_id) DO NOTHING
     RETURNING resource_id`,
    [
      input.operation,
      input.requestId,
      input.payloadSha256,
      input.proposedResourceId,
    ],
  );
  if (claimed.rows[0]) {
    return { kind: "claimed", resourceId: claimed.rows[0].resource_id };
  }

  const replay = await client.query<ExistingCreateRequest>(
    `SELECT payload_sha256, resource_id
       FROM library_create_request
      WHERE operation = $1 AND request_id = $2`,
    [input.operation, input.requestId],
  );
  const existing = replay.rows[0];
  if (!existing) {
    throw new Error("생성 요청 키를 확인하지 못했어요.");
  }
  if (existing.payload_sha256 !== input.payloadSha256) {
    return { kind: "conflict" };
  }
  return { kind: "replay", resourceId: existing.resource_id };
}
