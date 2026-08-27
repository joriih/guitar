import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { isAllowedAppOrigin } from "@/lib/app-origin";
import { AuthenticationError } from "@/lib/auth";
import { RequestBodyError } from "@/lib/request-json";

export { readJsonWithLimit } from "@/lib/request-json";

export function apiError(error: unknown) {
  if (error instanceof AuthenticationError) {
    return NextResponse.json(
      { error: error.message },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (error instanceof ZodError) {
    return NextResponse.json(
      { error: "입력 내용을 다시 확인해주세요.", issues: error.issues },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (error instanceof RequestBodyError) {
    return NextResponse.json(
      { error: error.message },
      { status: error.status, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (error instanceof ApiError) {
    const headers = new Headers(error.headers);
    if (!headers.has("Cache-Control")) headers.set("Cache-Control", "no-store");
    return NextResponse.json(
      { error: error.message },
      { status: error.status, headers },
    );
  }

  console.error(error);
  return NextResponse.json(
    { error: "잠시 문제가 생겼어요. 다시 시도해주세요." },
    { status: 500, headers: { "Cache-Control": "no-store" } },
  );
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly headers?: HeadersInit,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function assertSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!isAllowedAppOrigin(origin)) {
    throw new ApiError(403, "허용되지 않은 요청이에요.");
  }
}
