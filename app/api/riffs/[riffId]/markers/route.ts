import { createHash, randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import type { PoolClient } from "pg";

import { requireUser } from "@/lib/auth";
import { listRiffMarkers, mapMarker } from "@/lib/data";
import { db, withTransaction } from "@/lib/db";
import { ApiError, apiError, assertSameOrigin } from "@/lib/http";
import { MAX_MARKERS_PER_RIFF } from "@/lib/markers";
import { markerCreateSchema, uuidSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ riffId: string }> };

type CreatedMarkerRow = {
  id: string;
  riff_id: string;
  position_ms: number;
  label: string;
  color: "rose" | "amber" | "lime" | "sky" | "violet" | "slate";
  sort_order: number;
  revision: number;
  client_request_id: string | null;
  client_request_fingerprint: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

const MARKER_ROW_COLUMNS = `
  id, riff_id, position_ms, label, color, sort_order, revision,
  client_request_id, client_request_fingerprint, created_at, updated_at
`;

async function requireActiveRiff(riffId: string) {
  const result = await db.query(
    "SELECT 1 FROM riff WHERE id = $1 AND deleted_at IS NULL",
    [riffId],
  );
  if (!result.rowCount) throw new ApiError(404, "리프를 찾을 수 없어요.");
}

function markerRequestFingerprint(input: {
  positionMs: number;
  label: string;
  color: string;
}): string {
  return createHash("sha256")
    .update(JSON.stringify({
      positionMs: input.positionMs,
      label: input.label,
      color: input.color,
    }))
    .digest("hex");
}

async function findMarkerByRequest(
  client: PoolClient,
  riffId: string,
  requestId: string,
): Promise<CreatedMarkerRow | null> {
  const existing = await client.query<CreatedMarkerRow>(
    `SELECT ${MARKER_ROW_COLUMNS}
       FROM riff_marker
      WHERE riff_id = $1 AND client_request_id = $2`,
    [riffId, requestId],
  );
  return existing.rows[0] ?? null;
}

export async function GET(_request: Request, { params }: Context) {
  try {
    await requireUser();
    const riffId = uuidSchema.parse((await params).riffId);
    await requireActiveRiff(riffId);
    return NextResponse.json(
      { markers: await listRiffMarkers(riffId) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request, { params }: Context) {
  try {
    assertSameOrigin(request);
    await requireUser();
    const riffId = uuidSchema.parse((await params).riffId);
    // requestId is deliberately required. This single-user local app has no
    // external clients to preserve, while an optional key would leave an
    // uncertain marker create unsafe to retry.
    const input = markerCreateSchema.parse(await request.json());
    const requestFingerprint = markerRequestFingerprint(input);

    const creation = await withTransaction(async (client) => {
      const riff = await client.query(
        "SELECT id FROM riff WHERE id = $1 AND deleted_at IS NULL FOR UPDATE",
        [riffId],
      );
      if (!riff.rowCount) throw new ApiError(404, "리프를 찾을 수 없어요.");

      const existing = await findMarkerByRequest(client, riffId, input.requestId);
      if (existing) {
        if (existing.client_request_fingerprint !== requestFingerprint) {
          throw new ApiError(
            409,
            "같은 마커 요청 ID가 다른 위치나 내용에 사용됐어요. 다시 추가해주세요.",
          );
        }
        return { row: existing, created: false } as const;
      }

      const summary = await client.query<{ marker_count: string; next_order: number }>(
        `SELECT count(*) AS marker_count,
                COALESCE(max(sort_order), -1)::integer + 1 AS next_order
           FROM riff_marker
          WHERE riff_id = $1`,
        [riffId],
      );
      const markerCount = Number(summary.rows[0]?.marker_count ?? 0);
      if (markerCount >= MAX_MARKERS_PER_RIFF) {
        throw new ApiError(
          409,
          `리프 하나에는 마커를 ${MAX_MARKERS_PER_RIFF}개까지 추가할 수 있어요.`,
        );
      }

      const inserted = await client.query<CreatedMarkerRow>(
        `INSERT INTO riff_marker
           (id, riff_id, position_ms, label, color, sort_order,
            client_request_id, client_request_fingerprint)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING ${MARKER_ROW_COLUMNS}`,
        [
          randomUUID(),
          riffId,
          input.positionMs,
          input.label,
          input.color,
          summary.rows[0]?.next_order ?? 0,
          input.requestId,
          requestFingerprint,
        ],
      );
      await client.query("UPDATE riff SET updated_at = now() WHERE id = $1", [riffId]);
      return { row: inserted.rows[0]!, created: true } as const;
    });

    return NextResponse.json(
      { marker: mapMarker(creation.row), idempotentReplay: !creation.created },
      {
        status: creation.created ? 201 : 200,
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch (error) {
    return apiError(error);
  }
}
