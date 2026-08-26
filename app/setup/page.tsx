import { redirect } from "next/navigation";

import { AuthForm } from "@/components/app/AuthForm";
import { getCurrentUser, hasAppUser } from "@/lib/data";

export const dynamic = "force-dynamic";

export default async function SetupPage() {
  const [configured, user] = await Promise.all([hasAppUser(), getCurrentUser()]);
  if (user) redirect("/");
  if (configured) redirect("/login");

  return <AuthForm mode="setup" />;
}
