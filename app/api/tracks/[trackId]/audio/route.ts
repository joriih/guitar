import { requireUser } from "@/lib/auth";
import { audioStreamResponse, openAudioFile } from "@/lib/audio-storage";
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
    }>(
      `SELECT storage_path, original_file_name, mime_type
         FROM riff_track WHERE id = $1`,
      [trackId],
    );
    const row = result.rows[0];
    if (!row) throw new ApiError(404, "트랙을 찾을 수 없어요.");
    const file = await openAudioFile(row.storage_path);
    return audioStreamResponse({
      request,
      file,
      mimeType: row.mime_type,
      fileName: row.original_file_name,
    });
  } catch (error) {
    return apiError(error);
  }
}
