import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import type { PoolClient } from "pg";

import { compensateAudioWriteFailure } from "@/lib/audio-compensation";
import { sha256AudioBlob } from "@/lib/audio-file-digest";
import { preflightAudioFile } from "@/lib/audio-file-format";
import { requireUser } from "@/lib/auth";
import {
  normalizeMimeType,
  removeAudioFile,
  sanitizeOriginalName,
  saveAudioFile,
} from "@/lib/audio-storage";
import { listTracks, mapTrack } from "@/lib/data";
import { db, withTransaction } from "@/lib/db";
import { ApiError, apiError, assertSameOrigin } from "@/lib/http";
import { uuidSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ riffId: string }> };

type CreatedTrackRow = {
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
  client_request_fingerprint: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

const TRACK_ROW_COLUMNS = `
  id, riff_id, kind, name, duration_ms, offset_ms, volume, pan, muted, solo,
  fade_in_ms, fade_out_ms, mime_type, byte_size, revision, client_request_id,
  client_request_fingerprint, created_at, updated_at
`;

async function requireRiff(riffId: string) {
  const result = await db.query(
    "SELECT 1 FROM riff WHERE id = $1 AND deleted_at IS NULL",
    [riffId],
  );
  if (!result.rowCount) throw new ApiError(404, "리프를 찾을 수 없어요.");
}

function optionalInteger(
  form: FormData,
  key: string,
  options: { min: number; max: number },
): number | null {
  const raw = form.get(key);
  if (raw === null || raw === "") return null;
  if (typeof raw !== "string") throw new ApiError(400, `${key} 값이 올바르지 않아요.`);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < options.min || value > options.max) {
    throw new ApiError(400, `${key} 값이 올바르지 않아요.`);
  }
  return value;
}

async function trackRequestFingerprint(options: {
  audio: File;
  kind: "guitar" | "backing";
  name: string;
  durationMs: number | null;
}): Promise<string> {
  const { audio, kind, name, durationMs } = options;
  const metadata = JSON.stringify({
    kind,
    name,
    durationMs,
    originalFileName: sanitizeOriginalName(audio.name),
    mimeType: normalizeMimeType(audio.type),
    byteSize: audio.size,
  });
  return sha256AudioBlob(audio, `${metadata}\0`);
}

async function findTrackByRequest(
  client: PoolClient,
  riffId: string,
  requestId: string,
): Promise<CreatedTrackRow | null> {
  const existing = await client.query<CreatedTrackRow>(
    `SELECT ${TRACK_ROW_COLUMNS}
       FROM riff_track
      WHERE riff_id = $1 AND client_request_id = $2`,
    [riffId, requestId],
  );
  return existing.rows[0] ?? null;
}

function assertMatchingReplay(
  existing: CreatedTrackRow,
  fingerprint: string,
): void {
  if (existing.client_request_fingerprint !== fingerprint) {
    throw new ApiError(
      409,
      "같은 업로드 요청 ID가 다른 트랙 내용에 사용됐어요. 파일을 다시 선택해주세요.",
    );
  }
}

export async function GET(_request: Request, { params }: Context) {
  try {
    await requireUser();
    const riffId = uuidSchema.parse((await params).riffId);
    await requireRiff(riffId);
    return NextResponse.json(
      { tracks: await listTracks(riffId) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request, { params }: Context) {
  const savedFileRef: {
    current: Awaited<ReturnType<typeof saveAudioFile>> | null;
  } = { current: null };
  try {
    assertSameOrigin(request);
    await requireUser();
    const riffId = uuidSchema.parse((await params).riffId);
    const form = await request.formData();
    const audio = form.get("audio");
    if (!(audio instanceof File)) throw new ApiError(400, "오디오 파일이 필요해요.");
    const audioPreflight = preflightAudioFile(audio);
    if (!audioPreflight.ok) {
      throw new ApiError(audioPreflight.status, audioPreflight.message);
    }

    // This local-only app intentionally requires requestId rather than keeping
    // compatibility with pre-idempotency clients: accepting a missing key
    // would make an uncertain upload unsafe to retry.
    const rawRequestId = form.get("requestId");
    if (typeof rawRequestId !== "string") {
      throw new ApiError(400, "업로드 요청 ID가 필요해요.");
    }
    const requestId = uuidSchema.parse(rawRequestId);

    const rawKind = form.get("kind");
    const kind = rawKind === null || rawKind === "" ? "backing" : rawKind;
    if (kind !== "backing" && kind !== "guitar") {
      throw new ApiError(400, "트랙 종류가 올바르지 않아요.");
    }
    const rawName = form.get("name");
    if (rawName !== null && typeof rawName !== "string") {
      throw new ApiError(400, "트랙 이름이 올바르지 않아요.");
    }
    const requestedName = rawName?.trim();
    if (requestedName && requestedName.length > 120) {
      throw new ApiError(400, "트랙 이름은 120자까지 입력할 수 있어요.");
    }
    const name = requestedName || (kind === "backing" ? "Backing Track" : "Guitar Track");
    const durationMs = optionalInteger(form, "durationMs", {
      min: 0,
      max: 86_400_000,
    });
    const requestFingerprint = await trackRequestFingerprint({
      audio,
      kind,
      name,
      durationMs,
    });

    const replay = await withTransaction(async (client) => {
      const riff = await client.query(
        `SELECT id FROM riff
          WHERE id = $1 AND deleted_at IS NULL
          FOR UPDATE`,
        [riffId],
      );
      if (!riff.rowCount) throw new ApiError(404, "리프를 찾을 수 없어요.");
      return findTrackByRequest(client, riffId, requestId);
    });
    if (replay) {
      assertMatchingReplay(replay, requestFingerprint);
      return NextResponse.json(
        { track: mapTrack(replay), idempotentReplay: true },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    savedFileRef.current = await saveAudioFile(audio);
    const savedFile = savedFileRef.current;

    const id = randomUUID();
    const upload = await withTransaction(async (client) => {
      // The riff lock serializes the database create for this riff. Concurrent
      // uploads may each finish a temporary file first, but only one row wins;
      // the loser observes it here and removes its own unreferenced file below.
      const riff = await client.query(
        `SELECT id FROM riff
          WHERE id = $1 AND deleted_at IS NULL
          FOR UPDATE`,
        [riffId],
      );
      if (!riff.rowCount) throw new ApiError(404, "리프를 찾을 수 없어요.");

      const existing = await findTrackByRequest(client, riffId, requestId);
      if (existing) {
        assertMatchingReplay(existing, requestFingerprint);
        return { row: existing, created: false } as const;
      }

      const inserted = await client.query<CreatedTrackRow>(
        `INSERT INTO riff_track
           (id, riff_id, kind, name, storage_path, original_file_name,
            mime_type, byte_size, duration_ms, client_request_id,
            client_request_fingerprint)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING ${TRACK_ROW_COLUMNS}`,
        [
          id,
          riffId,
          kind,
          name,
          savedFile.storagePath,
          savedFile.originalFileName,
          savedFile.mimeType,
          savedFile.byteSize,
          durationMs,
          requestId,
          requestFingerprint,
        ],
      );
      await client.query("UPDATE riff SET updated_at = now() WHERE id = $1", [
        riffId,
      ]);
      return { row: inserted.rows[0]!, created: true } as const;
    });

    if (!upload.created) {
      await removeAudioFile(savedFile.storagePath);
    }
    savedFileRef.current = null;
    return NextResponse.json(
      { track: mapTrack(upload.row), idempotentReplay: !upload.created },
      {
        status: upload.created ? 201 : 200,
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch (error) {
    const failure = savedFileRef.current
      ? await compensateAudioWriteFailure(error, [savedFileRef.current.storagePath])
      : error;
    return apiError(failure);
  }
}
