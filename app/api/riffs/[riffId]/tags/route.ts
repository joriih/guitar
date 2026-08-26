import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import { requireUser } from "@/lib/auth";
import { getRiffTags, mapTag } from "@/lib/data";
import { db, withTransaction } from "@/lib/db";
import { ApiError, apiError, assertSameOrigin } from "@/lib/http";
import { MAX_TAGS_PER_RIFF, normalizeTagName } from "@/lib/tags";
import { tagCreateSchema, uuidSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ riffId: string }> };

async function requireActiveRiff(riffId: string) {
  const result = await db.query(
    "SELECT 1 FROM riff WHERE id = $1 AND deleted_at IS NULL",
    [riffId],
  );
  if (!result.rowCount) throw new ApiError(404, "리프를 찾을 수 없어요.");
}

export async function GET(_request: Request, { params }: Context) {
  try {
    await requireUser();
    const riffId = uuidSchema.parse((await params).riffId);
    await requireActiveRiff(riffId);
    return NextResponse.json(
      { tags: await getRiffTags(riffId) },
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
    const input = tagCreateSchema.parse(await request.json());
    const normalizedName = normalizeTagName(input.name);

    const result = await withTransaction(async (client) => {
      const riff = await client.query(
        "SELECT id FROM riff WHERE id = $1 AND deleted_at IS NULL FOR UPDATE",
        [riffId],
      );
      if (!riff.rowCount) throw new ApiError(404, "리프를 찾을 수 없어요.");

      const existing = await client.query<{ id: string; name: string }>(
        `SELECT tag.id, tag.name
           FROM riff_tag
           JOIN tag ON tag.id = riff_tag.tag_id
          WHERE riff_tag.riff_id = $1 AND tag.normalized_name = $2`,
        [riffId, normalizedName],
      );
      if (existing.rows[0]) {
        return { tag: mapTag(existing.rows[0]), created: false };
      }

      const count = await client.query<{ count: string }>(
        "SELECT count(*) FROM riff_tag WHERE riff_id = $1",
        [riffId],
      );
      if (Number(count.rows[0]?.count ?? 0) >= MAX_TAGS_PER_RIFF) {
        throw new ApiError(
          409,
          `리프 하나에는 태그를 ${MAX_TAGS_PER_RIFF}개까지 추가할 수 있어요.`,
        );
      }

      const tag = await client.query<{ id: string; name: string }>(
        `INSERT INTO tag (id, name, normalized_name)
         VALUES ($1, $2, $3)
         ON CONFLICT (normalized_name) DO UPDATE
           SET normalized_name = EXCLUDED.normalized_name
         RETURNING id, name`,
        [randomUUID(), input.name, normalizedName],
      );
      const tagRow = tag.rows[0];
      if (!tagRow) throw new ApiError(500, "태그를 추가하지 못했어요.");

      await client.query(
        "INSERT INTO riff_tag (riff_id, tag_id) VALUES ($1, $2)",
        [riffId, tagRow.id],
      );
      await client.query("UPDATE riff SET updated_at = now() WHERE id = $1", [riffId]);
      return { tag: mapTag(tagRow), created: true };
    });

    return NextResponse.json(
      { ...result, tags: await getRiffTags(riffId) },
      { status: result.created ? 201 : 200 },
    );
  } catch (error) {
    return apiError(error);
  }
}
