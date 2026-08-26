import { NextResponse } from "next/server";

import { requireUser } from "@/lib/auth";
import { listTags } from "@/lib/data";
import { apiError } from "@/lib/http";
import { tagNameSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await requireUser();
    const rawSearch = new URL(request.url).searchParams.get("q")?.trim() ?? "";
    const search = rawSearch ? tagNameSchema.parse(rawSearch) : undefined;
    return NextResponse.json(
      { tags: await listTags({ search, limit: 100 }) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiError(error);
  }
}
