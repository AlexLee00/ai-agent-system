#!/bin/zsh
set -euo pipefail

PROJECT_ROOT="${PROJECT_ROOT:-/Users/alexlee/projects/ai-agent-system}"

cd "$PROJECT_ROOT"
echo "=== OPS deploy sync ==="
git fetch origin main
echo "HEAD(before): $(git rev-parse --short HEAD)"
echo "FETCH_HEAD:    $(git rev-parse --short FETCH_HEAD)"
if [ -n "$(git status --porcelain)" ]; then
  echo "⚠️ 운영 워킹트리에 로컬 변경이 있습니다. 최신 main 기준으로 덮어씁니다."
  git status --short
fi
git reset --hard FETCH_HEAD
echo "HEAD(after):  $(git rev-parse --short HEAD)"

if git diff --name-only HEAD~1 HEAD | grep -qE "package\\.json|package-lock\\.json"; then
  echo "📦 package.json 변경 감지 — npm install 실행"
  npm install --production
else
  echo "✅ 의존성 변경 없음"
fi

node bots/claude/src/dexter.js --update-checksums || true
bash scripts/smart-restart.sh
sleep 15
node bots/claude/scripts/health-check.js --post-deploy --json || true
