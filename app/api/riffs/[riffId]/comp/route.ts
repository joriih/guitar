import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import { requireUser } from "@/lib/auth";
import { mapCompSegment } from "@/lib/data";
import { withTransaction } from "@/lib/db";
import { ApiError, apiError, assertSameOrigin } from "@/lib/http";
import { compPutSchema, uuidSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ riffId: string }> };

export async function GET(_request: Request, { params }: Context) {
  try {
    await requireUser();
    const riffId = uuidSchema.parse((await params).riffId);
    const comp = await withTransaction(async (client) => {
      const riff = await client.query<{ comp_revision: number }>(
        `SELECT comp_revision
           FROM riff
          WHERE id = $1 AND deleted_at IS NULL
          FOR SHARE`,
        [riffId],
      );
      const row = riff.rows[0];
      if (!row) throw new ApiError(404, "리프를 찾을 수 없어요.");
      const segments = await client.query(
        `SELECT id, riff_id, take_id, start_ms, end_ms, sort_order
           FROM comp_segment
          WHERE riff_id = $1
          ORDER BY sort_order`,
        [riffId],
      );
      return {
        revision: row.comp_revision,
        segments: segments.rows.map(mapCompSegment),
      };
    });
    return NextResponse.json(
      comp,
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiError(error);
  }
}

export async function PUT(request: Request, { params }: Context) {
  try {
    assertSameOrigin(request);
    await requireUser();
    const riffId = uuidSchema.parse((await params).riffId);
    const input = compPutSchema.parse(await request.json());

    const result = await withTransaction(async (client) => {
      const riff = await client.query<{ comp_revision: number }>(
        `SELECT comp_revision FROM riff
          WHERE id = $1 AND deleted_at IS NULL
          FOR UPDATE`,
        [riffId],
      );
      const locked = riff.rows[0];
      if (!locked) throw new ApiError(404, "리프를 찾을 수 없어요.");
      if (locked.comp_revision !== input.expectedRevision) {
        throw new ApiError(
          409,
          "다른 화면에서 Comp 구성이 변경됐어요. 최신 구성을 확인해주세요.",
        );
      }

      const takeIds = [...new Set(input.segments.map((segment) => segment.takeId))];
      if (takeIds.length) {
        const takes = await client.query<{ id: string; duration_ms: number | null }>(
          `SELECT id, duration_ms FROM take_recording
            WHERE riff_id = $1 AND id = ANY($2::uuid[])`,
          [riffId, takeIds],
        );
        const found = new Map(takes.rows.map((row) => [row.id, row.duration_ms]));
        if (takeIds.some((id) => !found.has(id))) {
          throw new ApiError(400, "이 리프에 속하지 않은 테이크가 포함되어 있어요.");
        }
        if (
          input.segments.some((segment) => {
            const durationMs = found.get(segment.takeId);
            return durationMs !== null && durationMs !== undefined && segment.endMs > durationMs;
          })
        ) {
          throw new ApiError(400, "Comp 구간이 테이크의 녹음 길이를 벗어났어요.");
        }
      }

      await client.query("DELETE FROM comp_segment WHERE riff_id = $1", [riffId]);
      const inserted = [];
      for (const [index, segment] of input.segments.entries()) {
        const result = await client.query(
          `INSERT INTO comp_segment
             (id, riff_id, take_id, start_ms, end_ms, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, riff_id, take_id, start_ms, end_ms, sort_order`,
          [
            randomUUID(),
            riffId,
            segment.takeId,
            segment.startMs,
            segment.endMs,
            index,
          ],
        );
        inserted.push(mapCompSegment(result.rows[0]));
      }
      const revision = await client.query<{ comp_revision: number }>(
        `UPDATE riff
            SET comp_revision = comp_revision + 1,
                updated_at = now()
          WHERE id = $1
          RETURNING comp_revision`,
        [riffId],
      );
      return {
        segments: inserted,
        revision: revision.rows[0]!.comp_revision,
      };
    });
    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return apiError(error);
  }
}
