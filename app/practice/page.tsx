import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { GuitarPracticeTools } from "@/components/practice-tools";
import { AppShell } from "@/components/ui";
import { getCurrentUser, hasAppUser } from "@/lib/data";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "기타 연습 도구",
  description: "스케일, 코드, 프렛 구간과 카포 운지를 확인하는 기타 연습 도구",
};

export default async function PracticePage() {
  const [configured, user] = await Promise.all([hasAppUser(), getCurrentUser()]);
  if (!configured) redirect("/setup");
  if (!user) redirect("/login");

  return (
    <AppShell
      currentSection="practice"
      newHref="/riffs/new"
      searchAction="/"
      searchPlaceholder="전체 라이브러리 검색"
      user={{ name: user.displayName, subtitle: `@${user.username}` }}
    >
      <GuitarPracticeTools />
    </AppShell>
  );
}
