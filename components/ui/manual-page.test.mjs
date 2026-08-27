import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("the authenticated manual is reachable from desktop and mobile navigation", async () => {
  const [shell, manual] = await Promise.all([
    readFile(path.join(projectRoot, "components/ui/AppShell.tsx"), "utf8"),
    readFile(path.join(projectRoot, "app/manual/page.tsx"), "utf8"),
  ]);

  assert.match(shell, /label: "사용 안내", href: "\/manual", icon: "manual"/);
  assert.match(shell, /mobileNavigation=\{<DriveSidebar \{\.\.\.sidebarProps\} compact \/>\}/);
  assert.match(manual, /if \(!configured\) redirect\("\/setup"\)/);
  assert.match(manual, /if \(!user\) redirect\("\/login"\)/);
  assert.match(manual, /currentSection="manual"/);
});

test("the manual covers the complete personal workflow without exposing secrets", async () => {
  const manual = await readFile(path.join(projectRoot, "app/manual/page.tsx"), "utf8");

  for (const heading of [
    "앱 열기",
    "앨범과 리프 정리",
    "기타 녹음",
    "녹음 파일 내보내기",
    "백킹 트랙과 YouTube",
    "MusicXML 코드표 연습",
    "백업·복원·친구 공유",
  ]) {
    assert.ok(manual.includes(heading), `missing manual section: ${heading}`);
  }
  assert.match(manual, /<strong>원본 파일 받기<\/strong>/);
  assert.match(manual, /<strong>믹스 WAV<\/strong>/);
  assert.match(manual, /이 트랙은 믹스 WAV에 포함됩니다/);
  assert.doesNotMatch(manual, /password\s*[:=]|session[_-]?token|DATABASE_URL/i);
});

test("manual controls remain single-column and touch-sized on narrow screens", async () => {
  const styles = await readFile(path.join(projectRoot, "app/manual/page.module.css"), "utf8");

  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*?\.steps,[\s\S]*?grid-template-columns:\s*1fr/s);
  assert.match(styles, /@media \(max-width: 420px\)[\s\S]*?\.contents a\s*\{[^}]*min-height:\s*44px/s);
  assert.match(styles, /\.contents a:focus-visible,[\s\S]*?outline:\s*2px solid var\(--ink\)/s);
});
