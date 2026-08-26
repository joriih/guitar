import { NextResponse } from "next/server";
import { z } from "zod";

import {
  attemptQueuedAudioCleanup,
  enqueueAudioCleanup,
} from "@/lib/audio-cleanup";
import { requireUser } from "@/lib/auth";
import { mapTake } from "@/lib/data";
import { withTransaction } from "@/lib/db";
import { ApiError, apiError, assertSameOrigin } from "@/lib/http";
import { takeUpdateSchema, uuidSchema } from "@/lib/validation";

export const runtime = "nodejs";

type Context = { params: Promise<{ takeId: string }> };

type TakeApiRow = {
  id: string;
  riff_id: string;
  take_no: number;
  name: string;
  duration_ms: number | null;
  trim_start_ms: number;
  trim_end_ms: number | null;
  offset_ms: number;
  mime_type: string;
  byte_size: string | number;
  is_primary: boolean;
  revision: number;
  created_at: Date | string;
};

const revisionedTakeUpdateSchema = takeUpdateSchema
  .extend({ expectedRevision: z.number().int().min(0) })
  .strict();

const revisionedDeleteSchema = z
  .object({ expectedRevision: z.number().int().min(0) })
  .strict();

export async function PATCH(request: Request, { params }: Context) {
  try {
    assertSameOrigin(request);
    await requireUser();
    const takeId = uuidSchema.parse((await params).takeId);
    const parsed = revisionedTakeUpdateSchema.parse(await request.json());
    const { expectedRevision, ...input } = parsed;

    const outcome = await withTransaction(async (client) => {
      const located = await client.query<{ riff_id: string }>(
        "SELECT riff_id FROM take_recording WHERE id = $1",
        [takeId],
      );
      const riffId = located.rows[0]?.riff_id;
      if (!riffId) throw new ApiError(404, "테이크를 찾을 수 없어요.");

      const riff = await client.query(
        `SELECT id FROM riff
          WHERE id = $1 AND deleted_at IS NULL
          FOR UPDATE`,
        [riffId],
      );
      if (!riff.rowCount) throw new ApiError(404, "리프를 찾을 수 없어요.");

      const found = await client.query<TakeApiRow>(
        `SELECT id, riff_id, take_no, name, duration_ms, trim_start_ms,
                trim_end_ms, offset_ms, mime_type, byte_size, is_primary,
                revision, created_at
           FROM take_recording
          WHERE id = $1 AND riff_id = $2
          FOR UPDATE`,
        [takeId, riffId],
      );
      const existing = found.rows[0];
      if (!existing) throw new ApiError(404, "테이크를 찾을 수 없어요.");
      if (existing.revision !== expectedRevision) {
        return { kind: "conflict" as const, current: existing };
      }

      const trimStartMs = input.trimStartMs ?? existing.trim_start_ms;
      const trimEndMs =
        input.trimEndMs === undefined ? existing.trim_end_ms : input.trimEndMs;
      if (trimEndMs !== null && trimEndMs <= trimStartMs) {
        throw new ApiError(400, "끝 지점은 시작 지점보다 뒤여야 해요.");
      }
      if (existing.duration_ms !== null && trimEndMs !== null && trimEndMs > existing.duration_ms) {
        throw new ApiError(400, "끝 지점이 녹음 길이를 벗어났어요.");
      }

      // The database permits only one primary take. The parent riff lock and
      // target revision check above make it safe to clear the previous primary
      // before promoting this row inside the same transaction.
      if (input.isPrimary) {
        await client.query(
          `UPDATE take_recording
              SET is_primary = false, revision = revision + 1
            WHERE riff_id = $1 AND id <> $2 AND is_primary = true`,
          [riffId, takeId],
        );
      }
      const result = await client.query(
        `UPDATE take_recording
            SET is_primary = CASE WHEN $2::boolean THEN true ELSE is_primary END,
                name = COALESCE($3, name),
                trim_start_ms = COALESCE($4, trim_start_ms),
                trim_end_ms = CASE WHEN $5::boolean THEN $6 ELSE trim_end_ms END,
                offset_ms = COALESCE($7, offset_ms),
                revision = revision + 1
          WHERE id = $1 AND revision = $8
          RETURNING id, riff_id, take_no, name, duration_ms, trim_start_ms,
                    trim_end_ms, offset_ms, mime_type,
                    byte_size, is_primary, revision, created_at`,
        [
          takeId,
          Boolean(input.isPrimary),
          input.name ?? null,
          input.trimStartMs ?? null,
          input.trimEndMs !== undefined,
          input.trimEndMs ?? null,
          input.offsetMs ?? null,
          expectedRevision,
        ],
      );
      const updated = result.rows[0];
      if (!updated) return { kind: "conflict" as const, current: existing };
      await client.query("UPDATE riff SET updated_at = now() WHERE id = $1", [
        riffId,
      ]);
      return { kind: "updated" as const, row: updated };
    });

    if (outcome.kind === "conflict") {
      return NextResponse.json(
        {
          error: "다른 창에서 이 테이크가 변경됐어요.",
          current: mapTake(outcome.current),
        },
        { status: 409, headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json({ take: mapTake(outcome.row) });
  } catch (error) {
    return apiError(error);
  }
}

export async function DELETE(request: Request, { params }: Context) {
  try {
    assertSameOrigin(request);
    await requireUser();
    const takeId = uuidSchema.parse((await params).takeId);
    const { expectedRevision } = revisionedDeleteSchema.parse(await request.json());
    const outcome = await withTransaction(async (client) => {
      const located = await client.query<{ riff_id: string }>(
        "SELECT riff_id FROM take_recording WHERE id = $1",
        [takeId],
      );
      const riffId = located.rows[0]?.riff_id;
      if (!riffId) throw new ApiError(404, "테이크를 찾을 수 없어요.");

      const lockedRiff = await client.query(
        `SELECT id FROM riff
          WHERE id = $1 AND deleted_at IS NULL
          FOR UPDATE`,
        [riffId],
      );
      if (!lockedRiff.rowCount) throw new ApiError(404, "테이크를 찾을 수 없어요.");

      const found = await client.query<TakeApiRow & { storage_path: string }>(
        `SELECT id, riff_id, take_no, name, duration_ms, trim_start_ms,
                trim_end_ms, offset_ms, mime_type, byte_size, is_primary,
                revision, created_at, storage_path
           FROM take_recording
          WHERE id = $1
          FOR UPDATE`,
        [takeId],
      );
      const row = found.rows[0];
      if (!row) throw new ApiError(404, "테이크를 찾을 수 없어요.");
      if (row.revision !== expectedRevision) {
        return { kind: "conflict" as const, current: row };
      }

      const compUsage = await client.query<{ segment_count: number }>(
        `SELECT count(*)::integer AS segment_count
           FROM comp_segment
          WHERE take_id = $1`,
        [takeId],
      );
      const segmentCount = compUsage.rows[0]?.segment_count ?? 0;
      if (segmentCount > 0) {
        throw new ApiError(
          409,
          `이 테이크는 Comp 구간 ${segmentCount}개에서 사용 중이에요. Comp에서 먼저 제거한 뒤 삭제해주세요.`,
        );
      }

      const deleted = await client.query(
        "DELETE FROM take_recording WHERE id = $1 AND revision = $2",
        [takeId, expectedRevision],
      );
      if (!deleted.rowCount) return { kind: "conflict" as const, current: row };
      await enqueueAudioCleanup(client, row.storage_path);
      if (row.is_primary) {
        await client.query(
          `UPDATE take_recording
              SET is_primary = true, revision = revision + 1
            WHERE id = (
              SELECT id FROM take_recording
               WHERE riff_id = $1 ORDER BY take_no DESC LIMIT 1
            )`,
          [row.riff_id],
        );
      }
      await client.query("UPDATE riff SET updated_at = now() WHERE id = $1", [
        row.riff_id,
      ]);
      return { kind: "deleted" as const, row };
    });
    if (outcome.kind === "conflict") {
      return NextResponse.json(
        {
          error: "다른 창에서 이 테이크가 변경됐어요.",
          current: mapTake(outcome.current),
        },
        { status: 409, headers: { "Cache-Control": "no-store" } },
      );
    }
    const cleanup = await attemptQueuedAudioCleanup(outcome.row.storage_path);
    return NextResponse.json({
      deleted: true,
      id: takeId,
      cleanupPending: cleanup.cleanupPending,
    });
  } catch (error) {
    return apiError(error);
  }
}
