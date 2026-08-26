#!/bin/zsh
set -e

APP_DIR="$(cd "$(dirname "$0")" && pwd)"

cd "$APP_DIR"

if ! command -v node >/dev/null 2>&1; then
  print -u2 "Node.js를 찾을 수 없어요. 앱 설치 상태를 확인해주세요."
  exit 1
fi

exec node scripts/cloudflare-quick-share.mjs
