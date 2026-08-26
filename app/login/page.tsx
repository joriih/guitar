import { redirect } from "next/navigation";

import { AuthForm } from "@/components/app/AuthForm";
import { DEFAULT_ACCOUNT_USERNAME } from "@/lib/account-defaults";
import { db } from "@/lib/db";
import { getCurrentUser, hasAppUser } from "@/lib/data";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const [configured, user] = await Promise.all([hasAppUser(), getCurrentUser()]);
  if (user) redirect("/");
  if (!configured) redirect("/setup");

  const result = await db.query<{ username: string }>(
    "SELECT username FROM app_user WHERE id = 1",
  );

  return (
    <AuthForm
      mode="login"
      defaultUsername={result.rows[0]?.username ?? DEFAULT_ACCOUNT_USERNAME}
    />
  );
}
