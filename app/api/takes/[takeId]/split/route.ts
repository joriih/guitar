import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";

import { compensateAudioWriteFailure } from "@/lib/audio-compensation";
import { requireUser } from "@/lib/auth";
import { duplicateAudioFile } from "@/lib/audio-storage";
import { mapTake } from "@/lib/data";
import { withTransaction } from "@/lib/db";
import { ApiError, apiError, assertSameOrigin } from "@/lib/http";
import { uuidSchema } from "@/lib/validation";

export const runtime = "nodejs";

type Context = { params: Promise<{ takeId: string }> };

const splitTakeSchema = z
  .object({
    splitMs: z.number().int().positive().max(86_400_000),
    expectedRevision: z.number().int().min(0),
  })
  .strict();

type TakeRow = {
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
};

type SourceRow = TakeRow & {
  storage_path: string;
  original_file_name: string;
};

export async function POST(request: Request, { params }: Context) {
  let duplicatePath: string | null = null;

  try {
    assertSameOrigin(request);
    await requireUser();
    const takeId = uuidSchema.parse((await params).takeId);
    const { splitMs, expectedRevision } = splitTakeSchema.parse(await request.json());

    const rows = await withTransaction(async (client) => {
      const located = await client.query<{ riff_id: string }>(
        "SELECT riff_id FROM take_recording WHERE id = $1",
        [takeId],
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

      const sourceResult = await client.query<SourceRow>(
        `SELECT id, riff_id, take_no, name, storage_path, original_file_name,
                mime_type, byte_size, duration_ms, trim_start_ms, trim_end_ms,
                offset_ms, is_primary, revision, created_at
           FROM take_recording
          WHERE id = $1 AND riff_id = $2
          FOR UPDATE`,
        [takeId, riffId],
      );
      const source = sourceResult.rows[0];
      if (!source) throw new ApiError(404, "테이크를 찾을 수 없어요.");
      if (source.revision !== expectedRevision) {
        throw new ApiError(
          409,
          "다른 화면에서 테이크가 변경됐어요. 최신 내용을 불러와 다시 나눠주세요.",
        );
      }

      if (source.duration_ms === null) {
        throw new ApiError(
          400,
          "녹음 길이를 확인할 수 없어 테이크를 나눌 수 없어요.",
        );
      }

      const effectiveEndMs = source.trim_end_ms ?? source.duration_ms;
      if (
        splitMs <= source.trim_start_ms ||
        splitMs >= effectiveEndMs ||
        splitMs >= source.duration_ms
      ) {
        throw new ApiError(
          400,
          "나눌 위치는 현재 테이크의 시작과 끝 사이여야 해요.",
        );
      }

      const copiedStoragePath = await duplicateAudioFile(source.storage_path);
      duplicatePath = copiedStoragePath;

      const counter = await client.query<{ next_no: number }>(
        `SELECT COALESCE(max(take_no), 0)::integer + 1 AS next_no
           FROM take_recording
          WHERE riff_id = $1`,
        [source.riff_id],
      );
      const takeNo = counter.rows[0]?.next_no ?? 1;
      const copiedId = randomUUID();
      const copiedName = `${source.name.slice(0, 118).trimEnd()} B`;

      const originalResult = await client.query<TakeRow>(
        `UPDATE take_recording
            SET trim_end_ms = $2,
                revision = revision + 1
          WHERE id = $1 AND revision = $3
          RETURNING id, riff_id, take_no, name, duration_ms, trim_start_ms,
                    trim_end_ms, offset_ms, mime_type, byte_size, is_primary,
                    revision, created_at`,
        [takeId, splitMs, expectedRevision],
      );
      if (!originalResult.rowCount) {
        throw new ApiError(
          409,
          "다른 화면에서 테이크가 변경됐어요. 최신 내용을 불러와 다시 나눠주세요.",
        );
      }
      const copiedResult = await client.query<TakeRow>(
        `INSERT INTO take_recording
           (id, riff_id, take_no, name, storage_path, original_file_name,
            mime_type, byte_size, duration_ms, trim_start_ms, trim_end_ms,
            offset_ms, is_primary)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, false)
         RETURNING id, riff_id, take_no, name, duration_ms, trim_start_ms,
                   trim_end_ms, offset_ms, mime_type, byte_size, is_primary,
                   revision, created_at`,
        [
          copiedId,
          source.riff_id,
          takeNo,
          copiedName,
          copiedStoragePath,
          source.original_file_name,
          source.mime_type,
          source.byte_size,
          source.duration_ms,
          splitMs,
          effectiveEndMs,
          source.offset_ms + (splitMs - source.trim_start_ms),
        ],
      );

      await client.query("UPDATE riff SET updated_at = now() WHERE id = $1", [
        source.riff_id,
      ]);

      return [originalResult.rows[0]!, copiedResult.rows[0]!];
    });

    duplicatePath = null;
    return NextResponse.json(
      { takes: rows.map((row) => mapTake(row)) },
      { status: 201 },
    );
  } catch (error) {
    const failure = duplicatePath
      ? await compensateAudioWriteFailure(error, [duplicatePath])
      : error;
    return apiError(failure);
  }
}
