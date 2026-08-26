import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import { compensateAudioWriteFailure } from "@/lib/audio-compensation";
import { requireUser } from "@/lib/auth";
import { duplicateAudioFile } from "@/lib/audio-storage";
import { getRiffById, mapRiff } from "@/lib/data";
import { db, withTransaction } from "@/lib/db";
import { ApiError, apiError, assertSameOrigin } from "@/lib/http";
import { duplicateRiffTitle } from "@/lib/riff-duplicate";
import { riffDuplicateSchema, uuidSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ riffId: string }> };

type SourceRiffRow = {
  album_id: string | null;
  title: string;
  bpm: number;
  musical_key: string;
  tuning: string;
  time_signature: string;
  notes: string;
  tab: string;
};

type SourceTagRow = {
  id: string;
  name: string;
};

type SourceTakeRow = {
  id: string;
  take_no: number;
  name: string;
  storage_path: string;
  original_file_name: string;
  mime_type: string;
  byte_size: string | number;
  duration_ms: number | null;
  trim_start_ms: number;
  trim_end_ms: number | null;
  offset_ms: number;
  is_primary: boolean;
};

type SourceTrackRow = {
  kind: "guitar" | "backing";
  name: string;
  storage_path: string;
  original_file_name: string;
  mime_type: string;
  byte_size: string | number;
  duration_ms: number | null;
  offset_ms: number;
  volume: number;
  pan: number;
  muted: boolean;
  solo: boolean;
  fade_in_ms: number;
  fade_out_ms: number;
};

type SourceYouTubeBackingRow = {
  video_id: string;
  name: string;
  source_start_ms: number;
  volume: number;
  sync_enabled: boolean;
};

type SourceCompRow = {
  take_id: string;
  start_ms: number;
  end_ms: number;
  sort_order: number;
};

type SourceMarkerRow = {
  position_ms: number;
  label: string;
  color: string;
  sort_order: number;
};

type ExistingDuplicateRow = {
  id: string;
  duplicate_source_riff_id: string;
};

async function parseDuplicateRequest(request: Request) {
  const text = await request.text();
  if (!text.trim()) return riffDuplicateSchema.parse({});
  try {
    return riffDuplicateSchema.parse(JSON.parse(text));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ApiError(400, "복제 요청 형식이 올바르지 않아요.");
    }
    throw error;
  }
}

function assertDuplicateRequestSource(
  row: ExistingDuplicateRow,
  sourceRiffId: string,
) {
  if (row.duplicate_source_riff_id !== sourceRiffId) {
    throw new ApiError(409, "이미 다른 리프 복제에 사용된 요청이에요.");
  }
}

function isDuplicateRequestConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; constraint?: unknown };
  return (
    value.code === "23505" &&
    value.constraint === "riff_duplicate_request_id_idx"
  );
}

export async function POST(request: Request, { params }: Context) {
  const copiedAudioPaths: string[] = [];

  try {
    assertSameOrigin(request);
    await requireUser();
    const sourceRiffId = uuidSchema.parse((await params).riffId);
    const { requestId } = await parseDuplicateRequest(request);

    if (requestId) {
      const replay = await db.query<ExistingDuplicateRow>(
        `SELECT id, duplicate_source_riff_id
           FROM riff
          WHERE duplicate_request_id = $1`,
        [requestId],
      );
      const existing = replay.rows[0];
      if (existing) {
        assertDuplicateRequestSource(existing, sourceRiffId);
        const riff = await getRiffById(existing.id, { includeDeleted: true });
        if (!riff) throw new ApiError(404, "복제된 리프를 찾을 수 없어요.");
        return NextResponse.json(
          { riff, idempotentReplay: true },
          { headers: { "Cache-Control": "no-store" } },
        );
      }
    }

    const outcome = await withTransaction(async (client) => {
      // Every child mutation updates this parent row before commit. Holding it
      // keeps the metadata, child rows, and source files stable while copied.
      const sourceResult = await client.query<SourceRiffRow>(
        `SELECT album_id, title, bpm, musical_key, tuning, time_signature, notes, tab
           FROM riff
          WHERE id = $1 AND deleted_at IS NULL
          FOR UPDATE`,
        [sourceRiffId],
      );
      const source = sourceResult.rows[0];
      if (!source) throw new ApiError(404, "리프를 찾을 수 없어요.");

      if (requestId) {
        const replay = await client.query<ExistingDuplicateRow>(
          `SELECT id, duplicate_source_riff_id
             FROM riff
            WHERE duplicate_request_id = $1`,
          [requestId],
        );
        const existing = replay.rows[0];
        if (existing) {
          assertDuplicateRequestSource(existing, sourceRiffId);
          return { riffId: existing.id, riff: null, idempotentReplay: true } as const;
        }
      }

      const tags = await client.query<SourceTagRow>(
        `SELECT tag.id, tag.name
           FROM riff_tag
           JOIN tag ON tag.id = riff_tag.tag_id
          WHERE riff_tag.riff_id = $1
          ORDER BY tag.normalized_name`,
        [sourceRiffId],
      );
      const takes = await client.query<SourceTakeRow>(
        `SELECT id, take_no, name, storage_path, original_file_name, mime_type,
                byte_size, duration_ms, trim_start_ms, trim_end_ms, offset_ms,
                is_primary
           FROM take_recording
          WHERE riff_id = $1
          ORDER BY take_no`,
        [sourceRiffId],
      );
      const tracks = await client.query<SourceTrackRow>(
        `SELECT kind, name, storage_path, original_file_name, mime_type,
                byte_size, duration_ms, offset_ms, volume, pan, muted, solo,
                fade_in_ms, fade_out_ms
           FROM riff_track
          WHERE riff_id = $1
          ORDER BY created_at, id`,
        [sourceRiffId],
      );
      const youtubeBacking = await client.query<SourceYouTubeBackingRow>(
        `SELECT video_id, name, source_start_ms, volume, sync_enabled
           FROM riff_youtube_backing
          WHERE riff_id = $1`,
        [sourceRiffId],
      );
      const comp = await client.query<SourceCompRow>(
        `SELECT take_id, start_ms, end_ms, sort_order
           FROM comp_segment
          WHERE riff_id = $1
          ORDER BY sort_order`,
        [sourceRiffId],
      );
      const markers = await client.query<SourceMarkerRow>(
        `SELECT position_ms, label, color, sort_order
           FROM riff_marker
          WHERE riff_id = $1
          ORDER BY sort_order`,
        [sourceRiffId],
      );

      // Claim the operation key before copying files. Concurrent reuse for a
      // different source fails at the unique index without creating any audio.
      const riffId = randomUUID();
      const title = duplicateRiffTitle(source.title);
      const inserted = await client.query(
        `INSERT INTO riff
           (id, album_id, title, bpm, musical_key, tuning, time_signature,
            notes, tab, is_favorite, deleted_at, duplicate_request_id,
            duplicate_source_riff_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, false, NULL, $10, $11)
         RETURNING id, album_id, title, bpm, musical_key, tuning, time_signature,
                   notes, tab, is_favorite, deleted_at,
                   metadata_revision, created_at, updated_at`,
        [
          riffId,
          source.album_id,
          title,
          source.bpm,
          source.musical_key,
          source.tuning,
          source.time_signature,
          source.notes,
          source.tab,
          requestId ?? null,
          requestId ? sourceRiffId : null,
        ],
      );

      const takeCopies = [];
      for (const take of takes.rows) {
        const storagePath = await duplicateAudioFile(take.storage_path);
        copiedAudioPaths.push(storagePath);
        takeCopies.push({ source: take, id: randomUUID(), storagePath });
      }

      const trackCopies = [];
      for (const track of tracks.rows) {
        const storagePath = await duplicateAudioFile(track.storage_path);
        copiedAudioPaths.push(storagePath);
        trackCopies.push({ source: track, id: randomUUID(), storagePath });
      }

      await client.query(
        `INSERT INTO riff_tag (riff_id, tag_id)
         SELECT $1, tag_id FROM riff_tag WHERE riff_id = $2`,
        [riffId, sourceRiffId],
      );

      const takeIdMap = new Map<string, string>();
      let primaryTakeId: string | null = null;
      for (const take of takeCopies) {
        takeIdMap.set(take.source.id, take.id);
        if (take.source.is_primary) primaryTakeId = take.id;
        await client.query(
          `INSERT INTO take_recording
             (id, riff_id, take_no, name, storage_path, original_file_name,
              mime_type, byte_size, duration_ms, trim_start_ms, trim_end_ms,
              offset_ms, is_primary)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [
            take.id,
            riffId,
            take.source.take_no,
            take.source.name,
            take.storagePath,
            take.source.original_file_name,
            take.source.mime_type,
            take.source.byte_size,
            take.source.duration_ms,
            take.source.trim_start_ms,
            take.source.trim_end_ms,
            take.source.offset_ms,
            take.source.is_primary,
          ],
        );
      }

      for (const track of trackCopies) {
        await client.query(
          `INSERT INTO riff_track
             (id, riff_id, kind, name, storage_path, original_file_name,
              mime_type, byte_size, duration_ms, offset_ms, volume, pan,
              muted, solo, fade_in_ms, fade_out_ms)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                   $13, $14, $15, $16)`,
          [
            track.id,
            riffId,
            track.source.kind,
            track.source.name,
            track.storagePath,
            track.source.original_file_name,
            track.source.mime_type,
            track.source.byte_size,
            track.source.duration_ms,
            track.source.offset_ms,
            track.source.volume,
            track.source.pan,
            track.source.muted,
            track.source.solo,
            track.source.fade_in_ms,
            track.source.fade_out_ms,
          ],
        );
      }

      const youtubeSource = youtubeBacking.rows[0];
      if (youtubeSource) {
        await client.query(
          `INSERT INTO riff_youtube_backing
             (id, riff_id, video_id, name, source_start_ms, volume,
              sync_enabled)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            randomUUID(),
            riffId,
            youtubeSource.video_id,
            youtubeSource.name,
            youtubeSource.source_start_ms,
            youtubeSource.volume,
            youtubeSource.sync_enabled,
          ],
        );
      }

      for (const segment of comp.rows) {
        const takeId = takeIdMap.get(segment.take_id);
        if (!takeId) throw new Error("Comp에 연결된 원본 테이크를 찾을 수 없어요.");
        await client.query(
          `INSERT INTO comp_segment
             (id, riff_id, take_id, start_ms, end_ms, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            randomUUID(),
            riffId,
            takeId,
            segment.start_ms,
            segment.end_ms,
            segment.sort_order,
          ],
        );
      }

      for (const marker of markers.rows) {
        await client.query(
          `INSERT INTO riff_marker
             (id, riff_id, position_ms, label, color, sort_order, revision)
           VALUES ($1, $2, $3, $4, $5, $6, 0)`,
          [
            randomUUID(),
            riffId,
            marker.position_ms,
            marker.label,
            marker.color,
            marker.sort_order,
          ],
        );
      }

      return {
        riffId,
        riff: mapRiff({
          ...inserted.rows[0],
          tags: tags.rows,
          take_count: takeCopies.length,
          primary_take_id: primaryTakeId,
        }),
        idempotentReplay: false,
      } as const;
    });

    copiedAudioPaths.length = 0;
    const riff =
      outcome.riff ??
      (await getRiffById(outcome.riffId, { includeDeleted: true }));
    if (!riff) throw new ApiError(404, "복제된 리프를 찾을 수 없어요.");
    return NextResponse.json(
      { riff, idempotentReplay: outcome.idempotentReplay },
      {
        status: outcome.idempotentReplay ? 200 : 201,
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch (error) {
    const operationError = isDuplicateRequestConflict(error)
      ? new ApiError(409, "이미 다른 리프 복제에 사용된 요청이에요.")
      : error;
    const failure = await compensateAudioWriteFailure(
      operationError,
      copiedAudioPaths.reverse(),
    );
    return apiError(failure);
  }
}
