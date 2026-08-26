#!/bin/zsh
set -e

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
POSTGRES_BIN="/Applications/Postgres.app/Contents/Versions/latest/bin"

cd "$APP_DIR"

if ! command -v npm >/dev/null 2>&1; then
  print -u2 "Node.js와 npm을 찾을 수 없어요. 앱 설치 상태를 확인해주세요."
  exit 1
fi

if [[ ! -x "$POSTGRES_BIN/pg_isready" || ! -x "$POSTGRES_BIN/pg_restore" || ! -x "$POSTGRES_BIN/psql" ]]; then
  print -u2 "Postgres.app을 찾을 수 없어요. Applications 폴더를 확인해주세요."
  exit 1
fi

if [[ -n "$(/usr/sbin/lsof -nP -iTCP:3000 -sTCP:LISTEN -t 2>/dev/null)" ]]; then
  osascript -e 'display dialog "안전한 복원을 위해 먼저 Riff Sketchbook을 실행한 터미널에서 Control + C를 눌러 앱을 종료해주세요." buttons {"확인"} default button "확인" with icon caution'
  exit 1
fi

if ! "$POSTGRES_BIN/pg_isready" -h 127.0.0.1 -p 5432 >/dev/null 2>&1; then
  open -a Postgres
  for _ in {1..20}; do
    if "$POSTGRES_BIN/pg_isready" -h 127.0.0.1 -p 5432 >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
fi

if ! "$POSTGRES_BIN/pg_isready" -h 127.0.0.1 -p 5432 >/dev/null 2>&1; then
  print -u2 "PostgreSQL이 20초 안에 준비되지 않았어요. Postgres.app을 확인해주세요."
  exit 1
fi

BACKUP_DIR="$(osascript <<'APPLESCRIPT'
try
  POSIX path of (choose folder with prompt "복원할 Riff Sketchbook 백업 폴더를 선택하세요")
on error number -128
  return ""
end try
APPLESCRIPT
)"

if [[ -z "$BACKUP_DIR" ]]; then
  exit 0
fi

CONFIRMED="$(osascript -e 'display dialog "선택한 백업으로 복원하면 현재 스케치북 내용이 바뀝니다. 복원 직전에 현재 상태를 자동으로 한 번 더 백업합니다. 복원이 끝난 뒤에는 이 백업을 만들 당시의 사용자 이름과 비밀번호로 로그인해야 합니다." buttons {"취소", "복원"} default button "복원" cancel button "취소" with icon caution' -e 'button returned of result' 2>/dev/null || true)"
if [[ "$CONFIRMED" != "복원" ]]; then
  exit 0
fi

npm run restore -- "$BACKUP_DIR"
osascript -e 'display dialog "복원이 완료됐어요. Start Riff Sketchbook.command로 앱을 다시 열어주세요." buttons {"확인"} default button "확인" with icon note'
