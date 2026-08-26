import { NextResponse } from "next/server";

import { requireUser } from "@/lib/auth";
import { getAlbumById, mapAlbum } from "@/lib/data";
import { db } from "@/lib/db";
import { ApiError, apiError, assertSameOrigin } from "@/lib/http";
import { revisionedAlbumUpdateSchema, uuidSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ albumId: string }> };

export async function GET(_request: Request, { params }: Context) {
  try {
    await requireUser();
    const id = uuidSchema.parse((await params).albumId);
    const album = await getAlbumById(id);
    if (!album) throw new ApiError(404, "앨범을 찾을 수 없어요.");
    return NextResponse.json(
      { album },
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
    const id = uuidSchema.parse((await params).albumId);
    const parsed = revisionedAlbumUpdateSchema.parse(await request.json());
    const { expectedRevision, ...input } = parsed;

    const columns: Record<keyof typeof input, string> = {
      name: "name",
      description: "description",
      color: "color",
      coverAsset: "cover_asset",
    };
    const values: unknown[] = [];
    const assignments: string[] = [];
    for (const [key, column] of Object.entries(columns)) {
      const value = input[key as keyof typeof input];
      if (value === undefined) continue;
      values.push(value);
      assignments.push(`${column} = $${values.length}`);
    }

    values.push(id);
    const idParameter = values.length;
    values.push(expectedRevision);
    const revisionParameter = values.length;
    const updated = await db.query(
      `WITH updated AS (
         UPDATE album
            SET ${assignments.join(", ")},
                revision = revision + 1,
                updated_at = now()
          WHERE id = $${idParameter}
            AND revision = $${revisionParameter}
          RETURNING id, name, description, color, cover_asset,
                    revision, created_at, updated_at
       )
       SELECT updated.*,
              (SELECT count(*)
                 FROM riff
                WHERE album_id = updated.id AND deleted_at IS NULL) AS riff_count
         FROM updated`,
      values,
    );
    if (!updated.rowCount) {
      const current = await getAlbumById(id);
      if (!current) throw new ApiError(404, "앨범을 찾을 수 없어요.");
      return NextResponse.json(
        {
          error: "다른 창에서 이 앨범이 변경됐어요.",
          current,
        },
        { status: 409, headers: { "Cache-Control": "no-store" } },
      );
    }

    return NextResponse.json(
      { album: mapAlbum(updated.rows[0]) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiError(error);
  }
}
