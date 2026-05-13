#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

cd "$REPO_ROOT"

changed="$(git diff --name-only -- bots/blog .claude/hooks/hooks.json docs/codex/CODEX_BLOG_MASTER.md || true)"

if [[ -z "$changed" ]]; then
  exit 0
fi

echo "[Stop][blog] 종료 전 블로그 체크리스트"

if echo "$changed" | grep -q '^bots/blog/lib/img-gen\.ts$'; then
  echo " - 이미지 경로 수정됨: Draw Things 7860 응답 확인 권장"
fi

if echo "$changed" | grep -q '^bots/blog/launchd/'; then
  echo " - launchd 수정됨: 실제 load/list 재확인 권장"
fi

if echo "$changed" | grep -q '^bots/blog/lib/commenter\.ts$'; then
  echo " - commenter 수정됨: reply/comment/sympathy/view 수동 1회 검증 권장"
fi

if echo "$changed" | grep -q '^bots/blog/CLAUDE\.md$'; then
  echo " - CLAUDE.md 수정됨: 마스터 문서와 상태 동기화 확인"
fi

echo " - 변경 파일:"
echo "$changed" | sed 's/^/   - /'
