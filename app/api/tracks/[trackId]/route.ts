import { NextResponse } from "next/server";
import { z } from "zod";

import {
  attemptQueuedAudioCleanup,
  enqueueAudioCleanup,
} from "@/lib/audio-cleanup";
import { requireUser } from "@/lib/auth";
import { mapTrack } from "@/lib/data";
import { db, withTransaction } from "@/lib/db";
import { ApiError, apiError, assertSameOrigin } from "@/lib/http";
import { trackUpdateSchema, uuidSchema } from "@/lib/validation";

export const runtime = "nodejs";

type Context = { params: Promise<{ trackId: string }> };

type TrackApiRow = {
  id: string;
  riff_id: string;
  kind: "guitar" | "backing";
  name: string;
  duration_ms: number | null;
  offset_ms: number;
  volume: number;
  pan: number;
  muted: boolean;
  solo: boolean;
  fade_in_ms: number;
  fade_out_ms: number;
  mime_type: string;
  byte_size: string | number;
  revision: number;
  client_request_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

const revisionedTrackUpdateSchema = trackUpdateSchema
  .extend({ expectedRevision: z.number().int().min(0) })
  .strict();

const revisionedDeleteSchema = z
  .object({ expectedRevision: z.number().int().min(0) })
  .strict();

const trackProjection = `track.id, track.riff_id, track.kind, track.name,
  track.duration_ms, track.offset_ms, track.volume, track.pan, track.muted,
  track.solo, track.fade_in_ms, track.fade_out_ms, track.mime_type,
  track.byte_size, track.revision, track.client_request_id,
  track.created_at, track.updated_at`;

export async function GET(_request: Request, { params }: Context) {
  try {
    await requireUser();
    const trackId = uuidSchema.parse((await params).trackId);
    const result = await db.query<TrackApiRow>(
      `SELECT ${trackProjection}
         FROM riff_track track
         JOIN riff ON riff.id = track.riff_id AND riff.deleted_at IS NULL
        WHERE track.id = $1`,
      [trackId],
    );
    const row = result.rows[0];
    if (!row) throw new ApiError(404, "트랙을 찾을 수 없어요.");
    return NextResponse.json(
      { track: mapTrack(row) },
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
    const trackId = uuidSchema.parse((await params).trackId);
    const parsed = revisionedTrackUpdateSchema.parse(await request.json());
    const { expectedRevision, ...input } = parsed;
    const columns: Record<string, string> = {
      name: "name",
      offsetMs: "offset_ms",
      volume: "volume",
      pan: "pan",
      muted: "muted",
      solo: "solo",
      fadeInMs: "fade_in_ms",
      fadeOutMs: "fade_out_ms",
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
    values.push(trackId);
    const outcome = await withTransaction(async (client) => {
      const located = await client.query<{ riff_id: string }>(
        "SELECT riff_id FROM riff_track WHERE id = $1",
        [trackId],
      );
      const riffId = located.rows[0]?.riff_id;
      if (!riffId) throw new ApiError(404, "트랙을 찾을 수 없어요.");

      const riff = await client.query(
        `SELECT id FROM riff
          WHERE id = $1 AND deleted_at IS NULL
          FOR UPDATE`,
        [riffId],
      );
      if (!riff.rowCount) throw new ApiError(404, "리프를 찾을 수 없어요.");

      const result = await client.query(
        `UPDATE riff_track
            SET ${assignments.join(", ")},
                revision = revision + 1,
                updated_at = now()
          WHERE id = $${values.length}
            AND riff_id = $${values.length + 1}
            AND revision = $${values.length + 2}
          RETURNING id, riff_id, kind, name, duration_ms, offset_ms, volume, pan,
                    muted, solo, fade_in_ms, fade_out_ms, mime_type, byte_size,
                    revision, client_request_id, created_at, updated_at`,
        [...values, riffId, expectedRevision],
      );
      const updated = result.rows[0];
      if (!updated) {
        const current = await client.query<TrackApiRow>(
          `SELECT ${trackProjection}
             FROM riff_track track
            WHERE track.id = $1 AND track.riff_id = $2`,
          [trackId, riffId],
        );
        if (!current.rows[0]) throw new ApiError(404, "트랙을 찾을 수 없어요.");
        return { kind: "conflict" as const, current: current.rows[0] };
      }
      await client.query("UPDATE riff SET updated_at = now() WHERE id = $1", [
        updated.riff_id,
      ]);
      return { kind: "updated" as const, row: updated };
    });
    if (outcome.kind === "conflict") {
      return NextResponse.json(
        {
          error: "다른 창에서 이 트랙이 변경됐어요.",
          current: mapTrack(outcome.current),
        },
        { status: 409, headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json({ track: mapTrack(outcome.row) });
  } catch (error) {
    return apiError(error);
  }
}

export async function DELETE(request: Request, { params }: Context) {
  try {
    assertSameOrigin(request);
    await requireUser();
    const trackId = uuidSchema.parse((await params).trackId);
    const { expectedRevision } = revisionedDeleteSchema.parse(await request.json());
    const outcome = await withTransaction(async (client) => {
      const located = await client.query<{ riff_id: string }>(
        "SELECT riff_id FROM riff_track WHERE id = $1",
        [trackId],
      );
      const riffId = located.rows[0]?.riff_id;
      if (!riffId) throw new ApiError(404, "트랙을 찾을 수 없어요.");

      const riff = await client.query(
        `SELECT id FROM riff
          WHERE id = $1 AND deleted_at IS NULL
          FOR UPDATE`,
        [riffId],
      );
      if (!riff.rowCount) throw new ApiError(404, "리프를 찾을 수 없어요.");

      const result = await client.query<TrackApiRow & { storage_path: string }>(
        `DELETE FROM riff_track
          WHERE id = $1 AND riff_id = $2 AND revision = $3
          RETURNING id, riff_id, kind, name, duration_ms, offset_ms, volume, pan,
                    muted, solo, fade_in_ms, fade_out_ms, mime_type, byte_size,
                    revision, client_request_id, created_at, updated_at, storage_path`,
        [trackId, riffId, expectedRevision],
      );
      const deleted = result.rows[0];
      if (!deleted) {
        const current = await client.query<TrackApiRow>(
          `SELECT ${trackProjection}
             FROM riff_track track
            WHERE track.id = $1 AND track.riff_id = $2`,
          [trackId, riffId],
        );
        if (!current.rows[0]) throw new ApiError(404, "트랙을 찾을 수 없어요.");
        return { kind: "conflict" as const, current: current.rows[0] };
      }
      await enqueueAudioCleanup(client, deleted.storage_path);
      await client.query("UPDATE riff SET updated_at = now() WHERE id = $1", [
        deleted.riff_id,
      ]);
      return { kind: "deleted" as const, row: deleted };
    });
    if (outcome.kind === "conflict") {
      return NextResponse.json(
        {
          error: "다른 창에서 이 트랙이 변경됐어요.",
          current: mapTrack(outcome.current),
        },
        { status: 409, headers: { "Cache-Control": "no-store" } },
      );
    }
    const cleanup = await attemptQueuedAudioCleanup(outcome.row.storage_path);
    return NextResponse.json({
      deleted: true,
      id: trackId,
      cleanupPending: cleanup.cleanupPending,
    });
  } catch (error) {
    return apiError(error);
  }
}
