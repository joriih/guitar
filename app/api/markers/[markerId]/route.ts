import { NextResponse } from "next/server";

import { requireUser } from "@/lib/auth";
import { mapMarker } from "@/lib/data";
import { withTransaction } from "@/lib/db";
import { ApiError, apiError, assertSameOrigin } from "@/lib/http";
import {
  markerDeleteSchema,
  markerUpdateSchema,
  uuidSchema,
} from "@/lib/validation";

export const runtime = "nodejs";

type Context = { params: Promise<{ markerId: string }> };

export async function PATCH(request: Request, { params }: Context) {
  try {
    assertSameOrigin(request);
    await requireUser();
    const markerId = uuidSchema.parse((await params).markerId);
    const input = markerUpdateSchema.parse(await request.json());
    const columns: Record<"positionMs" | "label" | "color", string> = {
      positionMs: "position_ms",
      label: "label",
      color: "color",
    };
    const values: unknown[] = [];
    const assignments: string[] = [];
    for (const [key, column] of Object.entries(columns)) {
      const value = input[key as keyof typeof columns];
      if (value !== undefined) {
        values.push(value);
        assignments.push(`${column} = $${values.length}`);
      }
    }
    values.push(markerId, input.revision);
    const markerIdParameter = values.length - 1;
    const revisionParameter = values.length;

    const marker = await withTransaction(async (client) => {
      const located = await client.query<{ riff_id: string }>(
        "SELECT riff_id FROM riff_marker WHERE id = $1",
        [markerId],
      );
      const riffId = located.rows[0]?.riff_id;
      if (!riffId) throw new ApiError(404, "마커를 찾을 수 없어요.");

      const riff = await client.query(
        `SELECT id FROM riff
          WHERE id = $1 AND deleted_at IS NULL
          FOR UPDATE`,
        [riffId],
      );
      if (!riff.rowCount) throw new ApiError(404, "리프를 찾을 수 없어요.");

      const updated = await client.query(
        `UPDATE riff_marker AS marker
            SET ${assignments.join(", ")},
                revision = marker.revision + 1,
                updated_at = now()
          WHERE marker.id = $${markerIdParameter}
            AND marker.revision = $${revisionParameter}
          RETURNING marker.id, marker.riff_id, marker.position_ms, marker.label,
                    marker.color, marker.sort_order, marker.revision,
                    marker.client_request_id,
                    marker.created_at, marker.updated_at`,
        values,
      );
      const row = updated.rows[0];
      if (!row) {
        const current = await client.query(
          `SELECT marker.revision
             FROM riff_marker AS marker
            WHERE marker.id = $1`,
          [markerId],
        );
        if (!current.rowCount) throw new ApiError(404, "마커를 찾을 수 없어요.");
        throw new ApiError(409, "다른 화면에서 마커가 변경됐어요. 최신 내용을 불러와 다시 저장해주세요.");
      }
      await client.query("UPDATE riff SET updated_at = now() WHERE id = $1", [
        row.riff_id,
      ]);
      return mapMarker(row);
    });

    return NextResponse.json({ marker });
  } catch (error) {
    return apiError(error);
  }
}

export async function DELETE(request: Request, { params }: Context) {
  try {
    assertSameOrigin(request);
    await requireUser();
    const markerId = uuidSchema.parse((await params).markerId);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new ApiError(400, "삭제할 마커의 버전 정보가 필요해요.");
    }
    const input = markerDeleteSchema.parse(body);

    await withTransaction(async (client) => {
      const located = await client.query<{ riff_id: string }>(
        "SELECT riff_id FROM riff_marker WHERE id = $1",
        [markerId],
      );
      const riffId = located.rows[0]?.riff_id;
      if (!riffId) throw new ApiError(404, "마커를 찾을 수 없어요.");

      const riff = await client.query(
        `SELECT id FROM riff
          WHERE id = $1 AND deleted_at IS NULL
          FOR UPDATE`,
        [riffId],
      );
      if (!riff.rowCount) throw new ApiError(404, "리프를 찾을 수 없어요.");

      const deleted = await client.query<{ riff_id: string }>(
        `DELETE FROM riff_marker AS marker
              WHERE marker.id = $1
                AND marker.revision = $2
          RETURNING marker.riff_id`,
        [markerId, input.revision],
      );
      const row = deleted.rows[0];
      if (!row) {
        const current = await client.query(
          "SELECT revision FROM riff_marker WHERE id = $1",
          [markerId],
        );
        if (!current.rowCount) throw new ApiError(404, "마커를 찾을 수 없어요.");
        throw new ApiError(
          409,
          "다른 화면에서 마커가 변경됐어요. 최신 내용을 불러와 다시 삭제해주세요.",
        );
      }
      await client.query("UPDATE riff SET updated_at = now() WHERE id = $1", [
        row.riff_id,
      ]);
    });

    return NextResponse.json({ deleted: true, id: markerId });
  } catch (error) {
    return apiError(error);
  }
}
