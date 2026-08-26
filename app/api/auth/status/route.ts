import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { hasAppUser } from "@/lib/data";
import { apiError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [configured, user] = await Promise.all([hasAppUser(), getCurrentUser()]);
    return NextResponse.json(
      { configured, authenticated: Boolean(user), user },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiError(error);
  }
}
