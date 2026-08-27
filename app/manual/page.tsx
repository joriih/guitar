import type { Metadata } from "next";
import { redirect } from "next/navigation";
import {
  BookOpenText,
  CircleHelp,
  Download,
  FileMusic,
  FolderHeart,
  Guitar,
  HardDrive,
  Mic2,
  Play,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";

import { AppShell } from "@/components/ui";
import { getCurrentUser, hasAppUser } from "@/lib/data";

import styles from "./page.module.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "사용 안내",
  description: "Riff Sketchbook을 혼자 오래 쓰기 위한 쉬운 사용 안내",
};

const sections = [
  ["start", "앱 열기"],
  ["library", "앨범과 리프"],
  ["record", "녹음"],
  ["export", "내보내기"],
  ["backing", "백킹 트랙"],
  ["practice", "코드표 연습"],
  ["safety", "백업과 공유"],
] as const;

export default async function ManualPage() {
  const [configured, user] = await Promise.all([hasAppUser(), getCurrentUser()]);
  if (!configured) redirect("/setup");
  if (!user) redirect("/login");

  return (
    <AppShell
      currentSection="manual"
      newHref="/riffs/new"
      searchAction="/"
      searchPlaceholder="전체 라이브러리 검색"
      user={{ name: user.displayName, subtitle: `@${user.username}` }}
    >
      <article className={styles.page}>
        <header className={styles.hero}>
          <span className={styles.eyebrow}>
            <BookOpenText size={16} aria-hidden="true" />
            혼자서도 바로 찾는 설명서
          </span>
          <h1>Riff Sketchbook 사용 안내</h1>
          <p>
            처음 녹음하는 순간부터 파일로 꺼내고 백업하는 순간까지, 필요한 부분만 골라
            보세요.
          </p>
        </header>

        <nav className={styles.contents} aria-label="사용 안내 목차">
          <strong>바로 가기</strong>
          <div>
            {sections.map(([id, label]) => (
              <a href={`#${id}`} key={id}>{label}</a>
            ))}
          </div>
        </nav>

        <div className={styles.guide}>
          <section className={styles.section} id="start">
            <SectionHeading icon={Play} number="01" title="앱 열기" />
            <ol>
              <li>Finder의 <strong>Riff Sketchbook</strong> 앱을 더블클릭합니다.</li>
              <li>상태가 초록색 <strong>사용할 수 있어요</strong>로 바뀌면 웹 화면이 자동으로 열립니다.</li>
              <li>브라우저를 닫아도 앱은 계속 켜져 있습니다. 완전히 끝낼 때는 앱 창의 <strong>서버 종료</strong>를 누릅니다.</li>
            </ol>
            <p className={styles.note}>주소를 직접 입력하거나 터미널을 열 필요는 없습니다.</p>
          </section>

          <section className={styles.section} id="library">
            <SectionHeading icon={FolderHeart} number="02" title="앨범과 리프 정리" />
            <div className={styles.steps}>
              <Step title="앨범 만들기">왼쪽의 모든 앨범에서 곡, 프로젝트, 연습 주제별 앨범을 만듭니다.</Step>
              <Step title="리프 만들기">새 리프를 누르고 제목, BPM, 키, 튜닝을 정합니다. 나중에 언제든 고칠 수 있습니다.</Step>
              <Step title="찾아보기">검색, 태그, 즐겨찾기로 다시 찾고, 지운 리프는 휴지통에서 복원합니다.</Step>
            </div>
          </section>

          <section className={styles.section} id="record">
            <SectionHeading icon={Mic2} number="03" title="기타 녹음" />
            <ol>
              <li>리프 화면에서 <strong>입력 연결</strong>을 눌러 마이크나 오디오 인터페이스를 고릅니다.</li>
              <li>입력 막대가 움직이는지 확인하고, 필요하면 카운트인과 반복 녹음을 켭니다.</li>
              <li><strong>새 테이크</strong> 또는 키보드 <kbd>R</kbd>로 시작하고 다시 눌러 멈춥니다.</li>
              <li>테이크를 선택한 뒤 <kbd>Space</kbd>로 들어보고, 이름·앞뒤 자르기·시작 위치를 다듬습니다.</li>
            </ol>
            <p className={styles.note}>첫 녹음은 10초 정도 짧게 해보고 입력 크기와 지연을 확인하는 것이 안전합니다.</p>
          </section>

          <section className={styles.section} id="export">
            <SectionHeading icon={Download} number="04" title="녹음 파일 내보내기" />
            <div className={styles.twoColumns}>
              <Step title="테이크 한 개">테이크의 <strong>원본 파일 받기</strong>를 누르면 녹음 원본을 변환하지 않고 그대로 저장합니다.</Step>
              <Step title="전체 믹스">고급 스튜디오의 <strong>믹스 WAV</strong>를 누르면 트랙의 볼륨·팬·페이드·Comp가 반영된 파일을 만듭니다.</Step>
            </div>
            <p className={styles.note}>내보내기는 사본을 만드는 동작이라 앱 안의 녹음은 사라지지 않습니다.</p>
          </section>

          <section className={styles.section} id="backing">
            <SectionHeading icon={Guitar} number="05" title="백킹 트랙과 YouTube" />
            <div className={styles.twoColumns}>
              <Step title="오디오 파일">MP3, WAV, AIFF, M4A, AAC, FLAC, OGG/Opus, WebM을 트랙으로 넣을 수 있습니다. 이 트랙은 믹스 WAV에 포함됩니다.</Step>
              <Step title="YouTube 링크">링크를 외부 참고 반주로 저장하고 녹음할 때 함께 재생할 수 있습니다. 영상 음원은 다운로드하거나 WAV에 섞지 않습니다.</Step>
            </div>
            <p className={styles.warning}>YouTube는 인터넷 상태와 기기마다 시작 시간이 달라 정밀한 합주에는 파일 백킹을 권장합니다.</p>
          </section>

          <section className={styles.section} id="practice">
            <SectionHeading icon={FileMusic} number="06" title="MusicXML 코드표 연습" />
            <ol>
              <li>왼쪽의 <strong>연습 도구</strong>를 열고 MusicXML 코드표를 고릅니다.</li>
              <li>마디의 코드를 누르면 같은 코드가 모두 표시되고 구성음과 프렛 위치가 바뀝니다.</li>
              <li>개인 참고 이미지가 있는 코드는 큰 아르페지오 그림도 함께 나타납니다.</li>
            </ol>
            <p className={styles.note}>코드표는 이 Mac에서만 읽으며 서버나 라이브러리에 저장하지 않습니다.</p>
          </section>

          <section className={styles.section} id="safety">
            <SectionHeading icon={HardDrive} number="07" title="백업·복원·친구 공유" />
            <div className={styles.steps}>
              <Step title="백업"><strong>Backup Riff Sketchbook</strong> 파일을 더블클릭하면 데이터와 오디오를 함께 보관합니다.</Step>
              <Step title="복원"><strong>Restore Riff Sketchbook</strong>을 열고 백업 폴더를 고릅니다. 복원 전 현재 상태도 안전 백업으로 남깁니다.</Step>
              <Step title="한 사람에게 공유"><strong>Share Riff Sketchbook</strong>을 실행해 임시 Cloudflare 주소를 만듭니다. 받은 사람은 같은 계정과 전체 자료를 다룰 수 있으니 믿을 수 있는 사람에게만 보냅니다.</Step>
            </div>
            <div className={styles.safetyCallout}>
              <ShieldCheck size={19} aria-hidden="true" />
              <p><strong>앱 업데이트와 녹음 파일은 별개입니다.</strong> 그래도 중요한 녹음 뒤에는 백업 폴더를 외장 디스크에도 한 번 복사해두세요.</p>
            </div>
          </section>
        </div>

        <section className={styles.faq} aria-labelledby="manual-faq-title">
          <div className={styles.faqHeading}>
            <CircleHelp size={20} aria-hidden="true" />
            <h2 id="manual-faq-title">막혔을 때</h2>
          </div>
          <details>
            <summary>앱을 눌렀는데 웹 화면이 열리지 않아요.</summary>
            <p>앱 창에서 상태를 확인하고 <strong>웹 화면 열기</strong>를 누르세요. 계속 안 되면 Postgres.app이 응용 프로그램 폴더에 있는지 확인한 뒤 앱 창의 로그 보기를 누릅니다.</p>
          </details>
          <details>
            <summary>마이크가 보이지 않아요.</summary>
            <p>Mac의 시스템 설정 → 개인정보 보호 및 보안 → 마이크에서 사용하는 브라우저를 허용한 뒤 페이지를 다시 엽니다.</p>
          </details>
          <details>
            <summary>YouTube가 녹음에 들어가지 않아요.</summary>
            <p>정상입니다. YouTube는 참고 재생만 하며 저작권과 동기화 문제 때문에 다운로드하거나 믹스 파일에 넣지 않습니다. 최종 믹스가 필요하면 보유한 MP3나 WAV 파일을 트랙으로 넣으세요.</p>
          </details>
          <details>
            <summary>내 자료는 어디에 있나요?</summary>
            <p>이 Mac의 전용 앱 데이터 폴더와 로컬 데이터베이스에 있습니다. GitHub에는 계정, 녹음, 백업, 개인 참고 이미지를 올리지 않습니다.</p>
          </details>
        </section>
      </article>
    </AppShell>
  );
}

function SectionHeading({
  icon: Icon,
  number,
  title,
}: {
  icon: LucideIcon;
  number: string;
  title: string;
}) {
  return (
    <header className={styles.sectionHeading}>
      <span className={styles.sectionIcon} aria-hidden="true"><Icon size={19} /></span>
      <span className={styles.sectionNumber}>{number}</span>
      <h2>{title}</h2>
    </header>
  );
}

function Step({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className={styles.step}>
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}
