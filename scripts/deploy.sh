#!/bin/zsh
set -euo pipefail

PROJECT_ROOT="${PROJECT_ROOT:-/Users/alexlee/projects/ai-agent-system}"
REFACTORER_LOCK_FILE="${PROJECT_ROOT}/.refactorer-active.lock"
REFACTORER_LOCK_MAX_AGE_SECONDS="${REFACTORER_LOCK_MAX_AGE_SECONDS:-600}"

cd "$PROJECT_ROOT"

if [ -f "$REFACTORER_LOCK_FILE" ]; then
  LOCK_MTIME="$(stat -f %m "$REFACTORER_LOCK_FILE" 2>/dev/null || stat -c %Y "$REFACTORER_LOCK_FILE" 2>/dev/null || echo 0)"
  NOW="$(date +%s)"
  LOCK_AGE=$((NOW - LOCK_MTIME))
  if [ "$LOCK_MTIME" -gt 0 ] && [ "$LOCK_AGE" -lt "$REFACTORER_LOCK_MAX_AGE_SECONDS" ]; then
    echo "refactorer active lock is fresh (${LOCK_AGE}s); deploy sync skipped"
    exit 0
  fi
fi

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

echo "🔎 TypeScript strict 검증"
npm run typecheck:strict

node bots/claude/src/dexter.js --update-checksums || true
bash scripts/smart-restart.sh
sleep 15
node bots/claude/scripts/health-check.js --post-deploy --json || true
