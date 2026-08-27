export const AUTH_JSON_BODY_LIMIT_BYTES = 4 * 1024;

export class RequestBodyError extends Error {
  readonly status: 400 | 413 | 415;

  constructor(
    status: 400 | 413 | 415,
    message: string,
  ) {
    super(message);
    this.name = "RequestBodyError";
    this.status = status;
  }
}

function assertJsonContentType(request: Request) {
  const contentType = request.headers.get("content-type");
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new RequestBodyError(
      415,
      "JSON 형식의 요청만 받을 수 있어요.",
    );
  }
}

function assertContentLength(request: Request, maximumBytes: number) {
  const value = request.headers.get("content-length");
  if (value === null) return;
  if (!/^\d+$/.test(value)) {
    throw new RequestBodyError(400, "요청 크기 정보가 올바르지 않아요.");
  }
  if (BigInt(value) > BigInt(maximumBytes)) {
    throw new RequestBodyError(413, "요청 내용이 너무 커요.");
  }
}

/**
 * Read a small JSON request without allowing a missing Content-Length or
 * chunked transfer to bypass the byte limit.
 */
export async function readJsonWithLimit(
  request: Request,
  maximumBytes = AUTH_JSON_BODY_LIMIT_BYTES,
): Promise<unknown> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new TypeError("maximumBytes must be a positive safe integer.");
  }

  assertJsonContentType(request);
  assertContentLength(request, maximumBytes);

  if (!request.body) {
    throw new RequestBodyError(400, "JSON 요청 내용이 비어 있어요.");
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        try {
          await reader.cancel();
        } catch {
          // The size error remains authoritative even if cancellation fails.
        }
        throw new RequestBodyError(413, "요청 내용이 너무 커요.");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof RequestBodyError) throw error;
    throw new RequestBodyError(400, "요청 내용을 읽을 수 없어요.");
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    throw new RequestBodyError(400, "JSON 요청 내용이 올바르지 않아요.");
  }
}
