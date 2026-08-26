import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import { compensateAudioWriteFailure } from "@/lib/audio-compensation";
import { requireUser } from "@/lib/auth";
import { duplicateAudioFile } from "@/lib/audio-storage";
import { mapTake } from "@/lib/data";
import { db, withTransaction } from "@/lib/db";
import { ApiError, apiError, assertSameOrigin } from "@/lib/http";
import { takeDuplicateSchema, uuidSchema } from "@/lib/validation";

export const runtime = "nodejs";

type Context = { params: Promise<{ takeId: string }> };

type DuplicateTakeRow = {
  id: string;
  riff_id: string;
  take_no: number;
  name: string;
  duration_ms: number | null;
  trim_start_ms: number;
  trim_end_ms: number | null;
  offset_ms: number;
  mime_type: string;
  byte_size: string | number;
  is_primary: boolean;
  revision: number;
  created_at: Date | string;
  duplicate_source_take_id: string;
};

const duplicateProjection = `id, riff_id, take_no, name, duration_ms,
  trim_start_ms, trim_end_ms, offset_ms, mime_type, byte_size, is_primary,
  revision, created_at, duplicate_source_take_id`;

async function parseDuplicateRequest(request: Request) {
  const text = await request.text();
  try {
    return takeDuplicateSchema.parse(text.trim() ? JSON.parse(text) : {});
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ApiError(400, "테이크 복제 요청 형식이 올바르지 않아요.");
    }
    throw error;
  }
}

function assertDuplicateRequestSource(
  row: DuplicateTakeRow,
  sourceTakeId: string,
): void {
  if (row.duplicate_source_take_id !== sourceTakeId) {
    throw new ApiError(409, "이미 다른 테이크 복제에 사용된 요청이에요.");
  }
}

function isDuplicateRequestConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; constraint?: unknown };
  return (
    value.code === "23505" &&
    value.constraint === "take_recording_duplicate_request_id_idx"
  );
}

function duplicateTakeName(name: string): string {
  const suffix = " 복사본";
  return `${Array.from(name).slice(0, 120 - Array.from(suffix).length).join("")}${suffix}`;
}

export async function POST(request: Request, { params }: Context) {
  let duplicatePath: string | null = null;
  let requestId: string | null = null;
  let sourceTakeId: string | null = null;
  try {
    assertSameOrigin(request);
    await requireUser();
    sourceTakeId = uuidSchema.parse((await params).takeId);
    requestId = (await parseDuplicateRequest(request)).requestId;

    const replay = await db.query<DuplicateTakeRow>(
      `SELECT ${duplicateProjection}
         FROM take_recording
        WHERE duplicate_request_id = $1
          AND EXISTS (
            SELECT 1
              FROM riff
             WHERE riff.id = take_recording.riff_id
               AND riff.deleted_at IS NULL
          )`,
      [requestId],
    );
    if (replay.rows[0]) {
      assertDuplicateRequestSource(replay.rows[0], sourceTakeId);
      return NextResponse.json(
        { take: mapTake(replay.rows[0]), idempotentReplay: true },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    const outcome = await withTransaction(async (client) => {
      const located = await client.query<{ riff_id: string }>(
        "SELECT riff_id FROM take_recording WHERE id = $1",
        [sourceTakeId],
      );
      const riffId = located.rows[0]?.riff_id;
      if (!riffId) throw new ApiError(404, "테이크를 찾을 수 없어요.");

      const riff = await client.query(
        `SELECT id FROM riff
          WHERE id = $1 AND deleted_at IS NULL
          FOR UPDATE`,
        [riffId],
      );
      if (!riff.rowCount) throw new ApiError(404, "리프를 찾을 수 없어요.");

      const existing = await client.query<DuplicateTakeRow>(
        `SELECT ${duplicateProjection}
           FROM take_recording
          WHERE duplicate_request_id = $1`,
        [requestId],
      );
      if (existing.rows[0]) {
        assertDuplicateRequestSource(existing.rows[0], sourceTakeId!);
        return { row: existing.rows[0], created: false } as const;
      }

      const sourceResult = await client.query<{
        riff_id: string;
        name: string;
        storage_path: string;
        original_file_name: string;
        mime_type: string;
        byte_size: string | number;
        duration_ms: number | null;
        trim_start_ms: number;
        trim_end_ms: number | null;
        offset_ms: number;
      }>(
        `SELECT riff_id, name, storage_path, original_file_name, mime_type,
                byte_size, duration_ms, trim_start_ms, trim_end_ms, offset_ms
           FROM take_recording
          WHERE id = $1 AND riff_id = $2
          FOR UPDATE`,
        [sourceTakeId, riffId],
      );
      const source = sourceResult.rows[0];
      if (!source) throw new ApiError(404, "테이크를 찾을 수 없어요.");

      const copiedStoragePath = await duplicateAudioFile(source.storage_path);
      duplicatePath = copiedStoragePath;
      const id = randomUUID();
      const counter = await client.query<{ next_no: number }>(
        `SELECT COALESCE(max(take_no), 0)::integer + 1 AS next_no
           FROM take_recording WHERE riff_id = $1`,
        [riffId],
      );
      const takeNo = counter.rows[0]?.next_no ?? 1;
      const result = await client.query(
        `INSERT INTO take_recording
           (id, riff_id, take_no, name, storage_path, original_file_name,
           mime_type, byte_size, duration_ms, trim_start_ms, trim_end_ms,
            offset_ms, is_primary, duplicate_request_id,
            duplicate_source_take_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                 false, $13, $14)
         RETURNING id, riff_id, take_no, name, duration_ms, trim_start_ms,
                   trim_end_ms, offset_ms, mime_type, byte_size, is_primary,
                   revision, created_at`,
        [
          id,
          riffId,
          takeNo,
          duplicateTakeName(source.name),
          copiedStoragePath,
          source.original_file_name,
          source.mime_type,
          source.byte_size,
          source.duration_ms,
          source.trim_start_ms,
          source.trim_end_ms,
          source.offset_ms,
          requestId,
          sourceTakeId,
        ],
      );
      await client.query("UPDATE riff SET updated_at = now() WHERE id = $1", [
        riffId,
      ]);
      return { row: result.rows[0] as DuplicateTakeRow, created: true } as const;
    });
    duplicatePath = null;
    return NextResponse.json(
      {
        take: mapTake(outcome.row),
        idempotentReplay: !outcome.created,
      },
      {
        status: outcome.created ? 201 : 200,
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch (error) {
    const failure = duplicatePath
      ? await compensateAudioWriteFailure(error, [duplicatePath])
      : error;
    if (
      failure === error &&
      requestId &&
      sourceTakeId &&
      isDuplicateRequestConflict(error)
    ) {
      try {
        const replay = await db.query<DuplicateTakeRow>(
          `SELECT ${duplicateProjection}
             FROM take_recording
            WHERE duplicate_request_id = $1`,
          [requestId],
        );
        if (replay.rows[0]) {
          assertDuplicateRequestSource(replay.rows[0], sourceTakeId);
          return NextResponse.json(
            { take: mapTake(replay.rows[0]), idempotentReplay: true },
            { headers: { "Cache-Control": "no-store" } },
          );
        }
      } catch (replayError) {
        return apiError(replayError);
      }
    }
    return apiError(failure);
  }
}
