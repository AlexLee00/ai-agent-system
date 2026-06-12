#!/bin/zsh
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

PROJECT_ROOT="${PROJECT_ROOT:-/Users/alexlee/projects/ai-agent-system}"
REFACTORER_LOCK_FILE="${PROJECT_ROOT}/.refactorer-active.lock"
REFACTORER_LOCK_MAX_AGE_SECONDS="${REFACTORER_LOCK_MAX_AGE_SECONDS:-600}"

cd "$PROJECT_ROOT"

. "$PROJECT_ROOT/scripts/lib/branch-guard.sh"
branch_guard_require_ops_main "$PROJECT_ROOT"

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
if [ -n "$(git status --porcelain)" ]; then
  echo "local worktree is dirty; deploy sync skipped to avoid clobbering changes"
  git status --short
  exit 0
fi

git fetch origin main
LOCAL_HEAD="$(git rev-parse HEAD)"
REMOTE_HEAD="$(git rev-parse FETCH_HEAD)"
echo "HEAD(before): ${LOCAL_HEAD:0:9}"
echo "FETCH_HEAD:    ${REMOTE_HEAD:0:9}"

if [ "$LOCAL_HEAD" = "$REMOTE_HEAD" ]; then
  echo "Already up to date."
  exit 0
fi

if ! git merge-base --is-ancestor "$LOCAL_HEAD" "$REMOTE_HEAD"; then
  echo "local HEAD is not an ancestor of origin/main; deploy sync skipped to preserve local commits"
  git log --oneline --decorate -5
  exit 0
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

echo "🏗️ daemon 사전 번들 빌드"
npm run build:daemons

node bots/claude/src/dexter.js --update-checksums || true
bash scripts/smart-restart.sh
sleep 15
node bots/claude/scripts/health-check.js --post-deploy --json || true
