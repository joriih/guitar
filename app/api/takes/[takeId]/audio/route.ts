import { requireUser } from "@/lib/auth";
import { safeAudioDownloadFileName } from "@/lib/audio-download";
import { audioStreamResponse, openAudioFile } from "@/lib/audio-storage";
import { db } from "@/lib/db";
import { ApiError, apiError } from "@/lib/http";
import { uuidSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ takeId: string }> };

export async function GET(request: Request, { params }: Context) {
  try {
    await requireUser();
    const takeId = uuidSchema.parse((await params).takeId);
    const result = await db.query<{
      name: string;
      storage_path: string;
      original_file_name: string;
      mime_type: string;
    }>(
      `SELECT name, storage_path, original_file_name, mime_type
         FROM take_recording WHERE id = $1`,
      [takeId],
    );
    const row = result.rows[0];
    if (!row) throw new ApiError(404, "테이크를 찾을 수 없어요.");

    const file = await openAudioFile(row.storage_path);
    const downloadRequested = new URL(request.url).searchParams.get("download") === "1";
    return audioStreamResponse({
      request,
      file,
      mimeType: row.mime_type,
      fileName: downloadRequested
        ? safeAudioDownloadFileName(row.name, row.storage_path, row.mime_type)
        : row.original_file_name,
      disposition: downloadRequested ? "attachment" : "inline",
    });
  } catch (error) {
    return apiError(error);
  }
}
