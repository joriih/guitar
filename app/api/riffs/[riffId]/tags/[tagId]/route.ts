import { NextResponse } from "next/server";

import { requireUser } from "@/lib/auth";
import { getRiffTags } from "@/lib/data";
import { withTransaction } from "@/lib/db";
import { ApiError, apiError, assertSameOrigin } from "@/lib/http";
import { uuidSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ riffId: string; tagId: string }> };

export async function DELETE(request: Request, { params }: Context) {
  try {
    assertSameOrigin(request);
    await requireUser();
    const rawParams = await params;
    const riffId = uuidSchema.parse(rawParams.riffId);
    const tagId = uuidSchema.parse(rawParams.tagId);

    await withTransaction(async (client) => {
      const riff = await client.query(
        "SELECT id FROM riff WHERE id = $1 AND deleted_at IS NULL FOR UPDATE",
        [riffId],
      );
      if (!riff.rowCount) throw new ApiError(404, "리프를 찾을 수 없어요.");

      const removed = await client.query(
        "DELETE FROM riff_tag WHERE riff_id = $1 AND tag_id = $2 RETURNING tag_id",
        [riffId, tagId],
      );
      if (!removed.rowCount) throw new ApiError(404, "이 리프에 연결된 태그가 아니에요.");

      await client.query("UPDATE riff SET updated_at = now() WHERE id = $1", [riffId]);
      await client.query(
        `DELETE FROM tag
          WHERE id = $1
            AND NOT EXISTS (SELECT 1 FROM riff_tag WHERE tag_id = $1)`,
        [tagId],
      );
    });

    return NextResponse.json({ tags: await getRiffTags(riffId) });
  } catch (error) {
    return apiError(error);
  }
}
