import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import { requireUser } from "@/lib/auth";
import { getAlbumById, listAlbums, mapAlbum } from "@/lib/data";
import { withTransaction } from "@/lib/db";
import { ApiError, apiError, assertSameOrigin } from "@/lib/http";
import {
  claimLibraryCreateRequest,
  libraryCreatePayloadDigest,
} from "@/lib/library-create-idempotency";
import { albumCreateSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireUser();
    return NextResponse.json(
      { albums: await listAlbums() },
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
    const parsed = albumCreateSchema.parse(await request.json());
    const { requestId, ...input } = parsed;
    const proposedAlbumId = randomUUID();
    const payloadSha256 = requestId
      ? libraryCreatePayloadDigest("album_create", input)
      : null;
    const outcome = await withTransaction(async (client) => {
      if (requestId && payloadSha256) {
        const claim = await claimLibraryCreateRequest(client, {
          operation: "album_create",
          requestId,
          payloadSha256,
          proposedResourceId: proposedAlbumId,
        });
        if (claim.kind === "conflict") {
          throw new ApiError(409, "이미 다른 앨범 생성에 사용된 요청이에요.");
        }
        if (claim.kind === "replay") {
          return { albumId: claim.resourceId, album: null, replay: true } as const;
        }
      }

      const result = await client.query(
        `INSERT INTO album (id, name, description, color, cover_asset, sort_order)
         VALUES ($1, $2, $3, $4, $5, COALESCE((SELECT max(sort_order) + 1 FROM album), 0))
         RETURNING id, name, description, color, cover_asset, 0 AS riff_count,
                   revision, created_at, updated_at`,
        [
          proposedAlbumId,
          input.name,
          input.description,
          input.color,
          input.coverAsset,
        ],
      );
      return {
        albumId: proposedAlbumId,
        album: mapAlbum(result.rows[0]),
        replay: false,
      } as const;
    });
    const album = outcome.album ?? (await getAlbumById(outcome.albumId));
    if (!album) {
      throw new ApiError(409, "이미 처리된 앨범 생성 결과를 찾을 수 없어요.");
    }
    return NextResponse.json(
      { album, idempotentReplay: outcome.replay },
      {
        status: outcome.replay ? 200 : 201,
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch (error) {
    return apiError(error);
  }
}
