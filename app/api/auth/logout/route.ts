import { NextResponse } from "next/server";

import { apiError, assertSameOrigin } from "@/lib/http";
import { destroyCurrentSession } from "@/lib/session";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    await destroyCurrentSession(request);
    return NextResponse.json(
      { authenticated: false },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiError(error);
  }
}
