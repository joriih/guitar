import { NextResponse } from "next/server";

import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { ApiError, apiError, assertSameOrigin } from "@/lib/http";
import { accountProfileSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requireUser();
    const input = accountProfileSchema.parse(await request.json());
    const result = await db.query<{
      id: number;
      username: string;
      display_name: string;
    }>(
      `UPDATE app_user
          SET username = $2, display_name = $3, updated_at = now()
        WHERE id = $1
        RETURNING id, username, display_name`,
      [user.id, input.username, input.displayName],
    );
    const updated = result.rows[0];
    if (!updated) throw new ApiError(404, "사용자 정보를 찾을 수 없어요.");

    return NextResponse.json(
      {
        user: {
          id: updated.id,
          username: updated.username,
          displayName: updated.display_name,
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiError(error);
  }
}
