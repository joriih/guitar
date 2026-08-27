import { requireUser } from "@/lib/auth";
import { readArpeggioReferenceImage } from "@/lib/arpeggio-reference-storage";
import { ApiError, apiError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ fileName: string }> };

export async function GET(_request: Request, { params }: Context) {
  try {
    // Authenticate before resolving the filename so unauthenticated requests
    // cannot probe whether this personal library exists.
    await requireUser();
    const { fileName } = await params;
    const image = await readArpeggioReferenceImage(fileName);
    if (!image) throw new ApiError(404, "개인 참고 이미지를 찾을 수 없어요.");

    const responseBody = image.bytes.buffer.slice(
      image.bytes.byteOffset,
      image.bytes.byteOffset + image.bytes.byteLength,
    ) as ArrayBuffer;
    return new Response(responseBody, {
      headers: {
        "Cache-Control": "private, no-store, max-age=0",
        "Content-Disposition": `inline; filename="${image.fileName}"`,
        "Content-Length": String(image.bytes.byteLength),
        "Content-Type": "image/png",
        "Cross-Origin-Resource-Policy": "same-origin",
        Pragma: "no-cache",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return apiError(error);
  }
}
