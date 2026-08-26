import { NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/auth";
import { getRiffById } from "@/lib/data";
import { withTransaction } from "@/lib/db";
import { ApiError, apiError, assertSameOrigin } from "@/lib/http";
import { riffUpdateSchema, uuidSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ riffId: string }> };

const revisionedRiffUpdateSchema = riffUpdateSchema
  .extend({ expectedRevision: z.number().int().min(0) })
  .strict();

export async function GET(_request: Request, { params }: Context) {
  try {
    await requireUser();
    const id = uuidSchema.parse((await params).riffId);
    const riff = await getRiffById(id);
    if (!riff) throw new ApiError(404, "리프를 찾을 수 없어요.");
    return NextResponse.json(
      { riff },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiError(error);
  }
}

export async function PATCH(request: Request, { params }: Context) {
  try {
    assertSameOrigin(request);
    await requireUser();
    const id = uuidSchema.parse((await params).riffId);
    const parsed = revisionedRiffUpdateSchema.parse(await request.json());
    const { expectedRevision, ...input } = parsed;

    const columns: Record<string, string> = {
      albumId: "album_id",
      title: "title",
      bpm: "bpm",
      musicalKey: "musical_key",
      tuning: "tuning",
      timeSignature: "time_signature",
      notes: "notes",
      tab: "tab",
      isFavorite: "is_favorite",
    };
    const values: unknown[] = [];
    const assignments: string[] = [];
    for (const [key, column] of Object.entries(columns)) {
      const value = input[key as keyof typeof input];
      if (value !== undefined) {
        values.push(value);
        assignments.push(`${column} = $${values.length}`);
      }
    }
    if (input.trashed !== undefined) {
      assignments.push(`deleted_at = ${input.trashed ? "now()" : "NULL"}`);
    }
    if (!assignments.length) throw new ApiError(400, "변경할 내용을 입력해주세요.");

    values.push(id);
    const outcome = await withTransaction(async (client) => {
      const locked = await client.query<{
        deleted_at: Date | string | null;
        metadata_revision: number;
      }>(
        "SELECT deleted_at, metadata_revision FROM riff WHERE id = $1 FOR UPDATE",
        [id],
      );
      const existing = locked.rows[0];
      if (!existing) throw new ApiError(404, "리프를 찾을 수 없어요.");
      if (existing.metadata_revision !== expectedRevision) return "conflict" as const;

      if (existing.deleted_at) {
        const restoresOnly =
          input.trashed === false &&
          Object.keys(input).every((key) => key === "trashed");
        if (!restoresOnly) {
          throw new ApiError(
            409,
            "휴지통에 있는 리프는 먼저 복원한 뒤 편집해주세요.",
          );
        }
      }

      if (input.albumId) {
        const album = await client.query("SELECT 1 FROM album WHERE id = $1", [
          input.albumId,
        ]);
        if (!album.rowCount) throw new ApiError(404, "앨범을 찾을 수 없어요.");
      }

      values.push(expectedRevision);
      const updated = await client.query(
        `UPDATE riff
            SET ${assignments.join(", ")},
                metadata_revision = metadata_revision + 1,
                updated_at = now()
          WHERE id = $${values.length - 1}
            AND metadata_revision = $${values.length}
          RETURNING metadata_revision`,
        values,
      );
      return updated.rowCount ? "updated" as const : "conflict" as const;
    });
    const riff = await getRiffById(id, { includeDeleted: true });
    if (outcome === "conflict") {
      if (!riff) throw new ApiError(404, "리프를 찾을 수 없어요.");
      return NextResponse.json(
        {
          error: "다른 창에서 이 리프가 변경됐어요.",
          current: riff,
        },
        { status: 409, headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json({ riff });
  } catch (error) {
    return apiError(error);
  }
}
