import { stat } from "node:fs/promises";

import { requireUser } from "@/lib/auth";
import { audioStreamResponse, resolveAudioPath } from "@/lib/audio-storage";
import { db } from "@/lib/db";
import { ApiError, apiError } from "@/lib/http";
import { uuidSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ trackId: string }> };

export async function GET(request: Request, { params }: Context) {
  try {
    await requireUser();
    const trackId = uuidSchema.parse((await params).trackId);
    const result = await db.query<{
      storage_path: string;
      original_file_name: string;
      mime_type: string;
      byte_size: string | number;
    }>(
      `SELECT storage_path, original_file_name, mime_type, byte_size
         FROM riff_track WHERE id = $1`,
      [trackId],
    );
    const row = result.rows[0];
    if (!row) throw new ApiError(404, "트랙을 찾을 수 없어요.");
    const absolutePath = resolveAudioPath(row.storage_path);
    try {
      await stat(absolutePath);
    } catch {
      throw new ApiError(404, "오디오 파일을 찾을 수 없어요.");
    }
    return audioStreamResponse({
      request,
      absolutePath,
      mimeType: row.mime_type,
      byteSize: Number(row.byte_size),
      fileName: row.original_file_name,
    });
  } catch (error) {
    return apiError(error);
  }
}
