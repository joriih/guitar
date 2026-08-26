#!/bin/zsh
set -e

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
POSTGRES_BIN="/Applications/Postgres.app/Contents/Versions/latest/bin"

cd "$APP_DIR"

if ! command -v npm >/dev/null 2>&1; then
  print -u2 "Node.js와 npm을 찾을 수 없어요. 앱 설치 상태를 확인해주세요."
  exit 1
fi

if [[ ! -x "$POSTGRES_BIN/pg_isready" ]]; then
  print -u2 "Postgres.app을 찾을 수 없어요. Applications 폴더를 확인해주세요."
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

npm run backup
open "$APP_DIR/backups"
