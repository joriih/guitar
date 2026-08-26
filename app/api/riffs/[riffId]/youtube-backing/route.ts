import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import { requireUser } from "@/lib/auth";
import {
  getYouTubeBacking,
  mapYouTubeBacking,
  type YouTubeBackingRow,
} from "@/lib/data";
import { db, withTransaction } from "@/lib/db";
import { ApiError, apiError, assertSameOrigin } from "@/lib/http";
import {
  uuidSchema,
  youtubeBackingDeleteSchema,
  youtubeBackingPutSchema,
} from "@/lib/validation";
import { parseYouTubeVideoId } from "@/lib/youtube-backing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ riffId: string }> };

const ROW_COLUMNS = `
  id, riff_id, video_id, name, source_start_ms, volume,
  sync_enabled, revision, created_at, updated_at
`;

async function requireActiveRiff(riffId: string) {
  const result = await db.query(
    "SELECT 1 FROM riff WHERE id = $1 AND deleted_at IS NULL",
    [riffId],
  );
  if (!result.rowCount) throw new ApiError(404, "리프를 찾을 수 없어요.");
}

function sameBackingContent(
  row: YouTubeBackingRow,
  input: {
    videoId: string;
    name: string;
    sourceStartMs: number;
    volume: number;
    syncEnabled: boolean;
  },
) {
  return row.video_id === input.videoId &&
    row.name === input.name &&
    row.source_start_ms === input.sourceStartMs &&
    Math.abs(Number(row.volume) - input.volume) < 0.000_001 &&
    row.sync_enabled === input.syncEnabled;
}

export async function GET(_request: Request, { params }: Context) {
  try {
    await requireUser();
    const riffId = uuidSchema.parse((await params).riffId);
    await requireActiveRiff(riffId);
    return NextResponse.json(
      { youtubeBacking: await getYouTubeBacking(riffId) },
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
    const input = youtubeBackingPutSchema.parse(await request.json());
    const videoId = parseYouTubeVideoId(input.url);
    if (!videoId) throw new ApiError(400, "올바른 YouTube 영상 링크를 입력해주세요.");
    const desired = {
      videoId,
      name: input.name,
      sourceStartMs: input.sourceStartMs,
      volume: input.volume,
      syncEnabled: input.syncEnabled,
    };

    const result = await withTransaction(async (client) => {
      const riff = await client.query(
        `SELECT id FROM riff
          WHERE id = $1 AND deleted_at IS NULL
          FOR UPDATE`,
        [riffId],
      );
      if (!riff.rowCount) throw new ApiError(404, "리프를 찾을 수 없어요.");

      const existingResult = await client.query<YouTubeBackingRow>(
        `SELECT ${ROW_COLUMNS}
           FROM riff_youtube_backing
          WHERE riff_id = $1
          FOR UPDATE`,
        [riffId],
      );
      const existing = existingResult.rows[0] ?? null;

      // A PUT whose response was lost is safe to retry with its original
      // expected revision when the authoritative resource already matches.
      if (existing && sameBackingContent(existing, desired)) {
        return { kind: "saved", row: existing, created: false } as const;
      }
      if (
        (existing && input.expectedRevision === null) ||
        (existing && existing.revision !== input.expectedRevision) ||
        (!existing && input.expectedRevision !== null)
      ) {
        return { kind: "conflict", row: existing } as const;
      }

      let row: YouTubeBackingRow;
      let created = false;
      if (!existing) {
        const inserted = await client.query<YouTubeBackingRow>(
          `INSERT INTO riff_youtube_backing
             (id, riff_id, video_id, name, source_start_ms, volume,
              sync_enabled)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING ${ROW_COLUMNS}`,
          [
            randomUUID(),
            riffId,
            videoId,
            input.name,
            input.sourceStartMs,
            input.volume,
            input.syncEnabled,
          ],
        );
        row = inserted.rows[0]!;
        created = true;
      } else {
        const updated = await client.query<YouTubeBackingRow>(
          `UPDATE riff_youtube_backing
              SET video_id = $2,
                  name = $3,
                  source_start_ms = $4,
                  volume = $5,
                  sync_enabled = $6,
                  revision = revision + 1,
                  updated_at = now()
            WHERE id = $1
            RETURNING ${ROW_COLUMNS}`,
          [
            existing.id,
            videoId,
            input.name,
            input.sourceStartMs,
            input.volume,
            input.syncEnabled,
          ],
        );
        row = updated.rows[0]!;
      }
      await client.query("UPDATE riff SET updated_at = now() WHERE id = $1", [riffId]);
      return { kind: "saved", row, created } as const;
    });

    if (result.kind === "conflict") {
      return NextResponse.json(
        {
          error: "다른 화면에서 YouTube 참고 트랙이 변경됐어요.",
          current: result.row ? mapYouTubeBacking(result.row) : null,
        },
        { status: 409, headers: { "Cache-Control": "no-store" } },
      );
    }

    return NextResponse.json(
      { youtubeBacking: mapYouTubeBacking(result.row) },
      {
        status: result.created ? 201 : 200,
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch (error) {
    return apiError(error);
  }
}

export async function DELETE(request: Request, { params }: Context) {
  try {
    assertSameOrigin(request);
    await requireUser();
    const riffId = uuidSchema.parse((await params).riffId);
    const input = youtubeBackingDeleteSchema.parse(await request.json());

    const result = await withTransaction(async (client) => {
      const riff = await client.query(
        `SELECT id FROM riff
          WHERE id = $1 AND deleted_at IS NULL
          FOR UPDATE`,
        [riffId],
      );
      if (!riff.rowCount) throw new ApiError(404, "리프를 찾을 수 없어요.");
      const existingResult = await client.query<YouTubeBackingRow>(
        `SELECT ${ROW_COLUMNS}
           FROM riff_youtube_backing
          WHERE riff_id = $1
          FOR UPDATE`,
        [riffId],
      );
      const existing = existingResult.rows[0] ?? null;
      if (!existing) return { kind: "deleted", alreadyDeleted: true } as const;
      if (existing.revision !== input.expectedRevision) {
        return { kind: "conflict", row: existing } as const;
      }
      await client.query("DELETE FROM riff_youtube_backing WHERE id = $1", [existing.id]);
      await client.query("UPDATE riff SET updated_at = now() WHERE id = $1", [riffId]);
      return { kind: "deleted", alreadyDeleted: false } as const;
    });

    if (result.kind === "conflict") {
      return NextResponse.json(
        {
          error: "다른 화면에서 YouTube 참고 트랙이 변경됐어요.",
          current: mapYouTubeBacking(result.row),
        },
        { status: 409, headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json(
      { deleted: true, alreadyDeleted: result.alreadyDeleted },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiError(error);
  }
}
