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
      revision: number;
    }>(
      `UPDATE app_user
          SET username = $2,
              display_name = $3,
              revision = revision + 1,
              updated_at = now()
        WHERE id = $1 AND revision = $4
        RETURNING id, username, display_name, revision`,
      [user.id, input.username, input.displayName, input.expectedRevision],
    );
    const updated = result.rows[0];
    if (!updated) {
      const currentResult = await db.query<{
        id: number;
        username: string;
        display_name: string;
        revision: number;
      }>(
        `SELECT id, username, display_name, revision
           FROM app_user WHERE id = $1`,
        [user.id],
      );
      const current = currentResult.rows[0];
      if (!current) throw new ApiError(404, "사용자 정보를 찾을 수 없어요.");
      return NextResponse.json(
        {
          error: "다른 창에서 사용자 정보가 먼저 바뀌었어요.",
          current: {
            id: current.id,
            username: current.username,
            displayName: current.display_name,
            revision: current.revision,
          },
        },
        { status: 409, headers: { "Cache-Control": "no-store" } },
      );
    }

    return NextResponse.json(
      {
        user: {
          id: updated.id,
          username: updated.username,
          displayName: updated.display_name,
          revision: updated.revision,
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiError(error);
  }
}
