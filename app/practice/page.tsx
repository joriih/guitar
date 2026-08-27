import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { GuitarPracticeTools } from "@/components/practice-tools";
import { AppShell } from "@/components/ui";
import { getCurrentUser, hasAppUser } from "@/lib/data";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "코드표와 기타 연습",
  description: "MusicXML 코드표를 열어 곡의 코드톤과 프렛 위치를 함께 익히는 개인 기타 연습 공간",
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
