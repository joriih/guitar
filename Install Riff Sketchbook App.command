#!/bin/zsh
set -e

PROJECT_DIRECTORY="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIRECTORY"

if ! command -v node >/dev/null 2>&1; then
  print -u2 "Node.js를 찾을 수 없어요. LOCAL-RUNBOOK.md의 설치 확인 항목을 봐주세요."
  exit 1
fi

node scripts/install-macos-app.mjs
/usr/bin/open -R "$HOME/Applications/Riff Sketchbook.app"
