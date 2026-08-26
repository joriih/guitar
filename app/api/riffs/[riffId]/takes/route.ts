import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import type { PoolClient } from "pg";

import { compensateAudioWriteFailure } from "@/lib/audio-compensation";
import { requireUser } from "@/lib/auth";
import { removeAudioFile, saveAudioFile } from "@/lib/audio-storage";
import { listTakes, mapTake } from "@/lib/data";
import { db, withTransaction } from "@/lib/db";
import { ApiError, apiError, assertSameOrigin } from "@/lib/http";
import { clientRecordingIdSchema, uuidSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ riffId: string }> };

type UploadedTakeRow = {
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

async function findIdempotentTake(
  client: PoolClient,
  riffId: string,
  clientRecordingId: string,
): Promise<UploadedTakeRow | null> {
  const result = await client.query<UploadedTakeRow>(
    `SELECT id, riff_id, take_no, name, duration_ms, trim_start_ms,
            trim_end_ms, offset_ms, mime_type, byte_size, is_primary, revision,
            created_at
       FROM take_recording
      WHERE riff_id = $1 AND client_recording_id = $2`,
    [riffId, clientRecordingId],
  );
  return result.rows[0] ?? null;
}

async function requireRiff(riffId: string) {
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
    await requireRiff(riffId);
    return NextResponse.json(
      { takes: await listTakes(riffId) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request, { params }: Context) {
  let savedFile: Awaited<ReturnType<typeof saveAudioFile>> | null = null;
  try {
    assertSameOrigin(request);
    await requireUser();
    const riffId = uuidSchema.parse((await params).riffId);
    const form = await request.formData();
    const audio = form.get("audio");
    if (!(audio instanceof File)) {
      throw new ApiError(400, "녹음 파일이 필요해요.");
    }

    const durationValue = form.get("durationMs");
    const durationMs =
      durationValue === null || durationValue === ""
        ? null
        : Number(durationValue);
    if (
      durationMs !== null &&
      (!Number.isInteger(durationMs) || durationMs < 0 || durationMs > 86_400_000)
    ) {
      throw new ApiError(400, "녹음 길이 정보가 올바르지 않아요.");
    }
    const requestedName = form.get("name");
    if (requestedName !== null && typeof requestedName !== "string") {
      throw new ApiError(400, "테이크 이름이 올바르지 않아요.");
    }
    const trimmedName = requestedName?.trim();
    if (trimmedName && trimmedName.length > 120) {
      throw new ApiError(400, "테이크 이름은 120자까지 입력할 수 있어요.");
    }

    const recoveryValue = form.get("recoveryId");
    if (recoveryValue !== null && typeof recoveryValue !== "string") {
      throw new ApiError(400, "녹음 복구 ID가 올바르지 않아요.");
    }
    const clientRecordingId =
      recoveryValue === null
        ? null
        : clientRecordingIdSchema.parse(recoveryValue);

    if (clientRecordingId) {
      const existing = await withTransaction(async (client) => {
        const riff = await client.query(
          `SELECT id FROM riff
            WHERE id = $1 AND deleted_at IS NULL
            FOR UPDATE`,
          [riffId],
        );
        if (!riff.rowCount) throw new ApiError(404, "리프를 찾을 수 없어요.");
        return findIdempotentTake(client, riffId, clientRecordingId);
      });
      if (existing) {
        return NextResponse.json({ take: mapTake(existing), idempotentReplay: true });
      }
    }

    savedFile = await saveAudioFile(audio);
    const uploadedFile = savedFile;
    const id = randomUUID();
    const upload = await withTransaction(async (client) => {
      const riff = await client.query(
        `SELECT id FROM riff
          WHERE id = $1 AND deleted_at IS NULL
          FOR UPDATE`,
        [riffId],
      );
      if (!riff.rowCount) throw new ApiError(404, "리프를 찾을 수 없어요.");

      if (clientRecordingId) {
        const existing = await client.query<UploadedTakeRow>(
          `SELECT id, riff_id, take_no, name, duration_ms, trim_start_ms,
                  trim_end_ms, offset_ms, mime_type, byte_size, is_primary,
                  revision, created_at
             FROM take_recording
            WHERE riff_id = $1 AND client_recording_id = $2`,
          [riffId, clientRecordingId],
        );
        if (existing.rows[0]) {
          return { row: existing.rows[0], created: false } as const;
        }
      }

      const counter = await client.query<{ next_no: number }>(
        `SELECT COALESCE(max(take_no), 0)::integer + 1 AS next_no
           FROM take_recording WHERE riff_id = $1`,
        [riffId],
      );
      const takeNo = counter.rows[0]?.next_no ?? 1;
      const result = await client.query(
        `INSERT INTO take_recording
           (id, riff_id, take_no, name, storage_path, original_file_name,
            mime_type, byte_size, duration_ms, client_recording_id, is_primary)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                 NOT EXISTS (SELECT 1 FROM take_recording WHERE riff_id = $2))
         RETURNING id, riff_id, take_no, name, duration_ms, trim_start_ms,
                   trim_end_ms, offset_ms, mime_type,
                   byte_size, is_primary, revision, created_at`,
        [
          id,
          riffId,
          takeNo,
          trimmedName || `Take ${String(takeNo).padStart(2, "0")}`,
          uploadedFile.storagePath,
          uploadedFile.originalFileName,
          uploadedFile.mimeType,
          uploadedFile.byteSize,
          durationMs,
          clientRecordingId,
        ],
      );
      await client.query("UPDATE riff SET updated_at = now() WHERE id = $1", [
        riffId,
      ]);
      return { row: result.rows[0] as UploadedTakeRow, created: true } as const;
    });

    if (!upload.created) {
      await removeAudioFile(uploadedFile.storagePath);
    }
    savedFile = null;
    return NextResponse.json(
      { take: mapTake(upload.row), idempotentReplay: !upload.created },
      { status: upload.created ? 201 : 200 },
    );
  } catch (error) {
    const failure = savedFile
      ? await compensateAudioWriteFailure(error, [savedFile.storagePath])
      : error;
    return apiError(failure);
  }
}
