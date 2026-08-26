# 기존 기타 연습 도구 보관본

이 폴더는 `joriih/guitar` 저장소의 전체 기능을 잃지 않기 위한 **비배포 보관본**입니다.
Next.js의 `public/` 아래에 있지 않으므로 Riff Sketchbook에서 직접 제공되지 않습니다.

- 원본: <https://github.com/joriih/guitar>
- 보관 기준 커밋: `2c3908e0d9ed92b9f96d4c8aad0889d2ea618d2e`
- 보관일: 2026-08-26
- 포함: `.nojekyll`, `index.html`, `no_sound.html`
- 제외: 원본 저장소의 `.git` 디렉터리와 Git 이력

## 현재 이식된 기능

Riff Sketchbook의 보호된 `/practice` 화면에 아래 기능을 새 TypeScript/React 코드로 옮겼습니다.

- 스케일 및 코드 구성음
- 프렛보드 시각화
- CAGED 포지션 구간
- 카포 변환

공유 가능한 순수 계산은 `lib/music-theory.ts`, 화면은
`components/practice-tools/`에 있습니다. 새 화면은 기존 녹음용 AudioContext와
transport를 사용하거나 변경하지 않습니다.

## 아직 보관본에만 있는 기능

리듬 생성기, 별도 메트로놈, 합성 백킹 트랙, 화성학 표, 오도권, 스트럼 패턴,
귀 훈련, 인터벌 프렛보드, 12마디 블루스, 연습 타이머 등은 아직 이 HTML 보관본에만
있습니다. 이후 이식할 때도 오디오 기능은 Riff Sketchbook의 기존 오디오 엔진과
수명 주기를 공유하도록 다시 작성해야 합니다.

원격 `guitar` 저장소는 Riff Sketchbook 업로드와 실제 화면 확인이 끝나기 전에는
삭제하지 마세요.
