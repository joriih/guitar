#!/bin/zsh
set -e

APP_DIR="$(cd "$(dirname "$0")" && pwd)"

cd "$APP_DIR"

if ! command -v npm >/dev/null 2>&1; then
  print -u2 "Node.js와 npm을 찾을 수 없어요. 앱 설치 상태를 확인해주세요."
  exit 1
fi

export RIFF_OPEN_BROWSER=1
exec npm run start
