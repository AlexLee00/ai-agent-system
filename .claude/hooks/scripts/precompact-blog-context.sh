#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

cd "$REPO_ROOT"

changed="$(git diff --name-only -- bots/blog .claude/hooks/hooks.json docs/codex/CODEX_BLOG_MASTER.md || true)"

if [[ -z "$changed" ]]; then
  exit 0
fi

echo "[PreCompact][blog] 블로그 관련 변경 감지"
echo "$changed" | sed 's/^/ - /'
echo "[PreCompact][blog] 세션 압축 전 확인:"
echo " - 마스터 문서와 bots/blog/CLAUDE.md 동기화"
echo " - Draw Things/API/launchd 상태 메모 여부"
echo " - 댓글/공감/조회수 실행 결과 기록 여부"
