import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import { requireUser } from "@/lib/auth";
import { getRiffById, listRiffs, mapRiff } from "@/lib/data";
import { withTransaction } from "@/lib/db";
import { ApiError, apiError, assertSameOrigin } from "@/lib/http";
import {
  claimLibraryCreateRequest,
  libraryCreatePayloadDigest,
} from "@/lib/library-create-idempotency";
import {
  librarySearchSchema,
  riffCreateSchema,
  tagNameSchema,
  uuidSchema,
} from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await requireUser();
    const searchParams = new URL(request.url).searchParams;
    const rawAlbumId = searchParams.get("albumId");
    const rawSearch = searchParams.get("q")?.trim() ?? "";
    const rawTag = searchParams.get("tag")?.trim() ?? "";
    const options = {
      ...(rawAlbumId ? { albumId: uuidSchema.parse(rawAlbumId) } : {}),
      ...(rawSearch ? { search: librarySearchSchema.parse(rawSearch) } : {}),
      ...(rawTag ? { tagName: tagNameSchema.parse(rawTag) } : {}),
    };
    return NextResponse.json(
      { riffs: await listRiffs(options) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    await requireUser();
    const parsed = riffCreateSchema.parse(await request.json());
    const { requestId, ...input } = parsed;
    const proposedRiffId = randomUUID();
    const payloadSha256 = requestId
      ? libraryCreatePayloadDigest("riff_create", input)
      : null;
    const outcome = await withTransaction(async (client) => {
      if (requestId && payloadSha256) {
        const claim = await claimLibraryCreateRequest(client, {
          operation: "riff_create",
          requestId,
          payloadSha256,
          proposedResourceId: proposedRiffId,
        });
        if (claim.kind === "conflict") {
          throw new ApiError(409, "이미 다른 리프 생성에 사용된 요청이에요.");
        }
        if (claim.kind === "replay") {
          return { riffId: claim.resourceId, riff: null, replay: true } as const;
        }
      }

      if (input.albumId) {
        const album = await client.query("SELECT 1 FROM album WHERE id = $1", [
          input.albumId,
        ]);
        if (!album.rowCount) throw new ApiError(404, "앨범을 찾을 수 없어요.");
      }

      const result = await client.query(
        `INSERT INTO riff
           (id, album_id, title, bpm, musical_key, tuning, time_signature, notes, tab)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, album_id, title, bpm, musical_key, tuning, time_signature,
                   notes, tab, '[]'::jsonb AS tags,
                   0 AS take_count, NULL::uuid AS primary_take_id,
                   is_favorite, deleted_at, metadata_revision,
                   created_at, updated_at`,
        [
          proposedRiffId,
          input.albumId,
          input.title,
          input.bpm,
          input.musicalKey,
          input.tuning,
          input.timeSignature,
          input.notes,
          input.tab,
        ],
      );
      return {
        riffId: proposedRiffId,
        riff: mapRiff(result.rows[0]),
        replay: false,
      } as const;
    });
    const riff =
      outcome.riff ??
      (await getRiffById(outcome.riffId, { includeDeleted: true }));
    if (!riff) {
      throw new ApiError(409, "이미 처리된 리프 생성 결과를 찾을 수 없어요.");
    }
    return NextResponse.json(
      { riff, idempotentReplay: outcome.replay },
      {
        status: outcome.replay ? 200 : 201,
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch (error) {
    return apiError(error);
  }
}
