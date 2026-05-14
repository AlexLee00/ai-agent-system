#!/bin/zsh
# Stop Hook — 세션 종료 시 session-wrap-cli.ts 요약 + HANDOFF 업데이트 안내
# Always exit 0

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

cd "$REPO_ROOT"

echo "" >&2
echo "[Stop][session-wrap] ═══════════════════════════════════" >&2

# session-wrap-cli.ts 실행 (4시간 이내 세션 요약)
TSX="$(command -v tsx 2>/dev/null || echo "$REPO_ROOT/node_modules/.bin/tsx")"
WRAP_CLI="$REPO_ROOT/packages/core/lib/skills/bin/session-wrap-cli.ts"
if [[ -x "$TSX" && -f "$WRAP_CLI" ]]; then
  "$TSX" "$WRAP_CLI" "4 hours ago" 2>/dev/null | sed 's/^/[Stop]/' >&2 || true
else
  # fallback: 기본 git log 요약
  echo "[Stop][session-wrap] 세션 커밋 요약 (최근 10개):" >&2
  git log --oneline -10 2>/dev/null | sed 's/^/  /' >&2
fi

# 변경 파일 요약
changed_count="$(git diff --name-only HEAD~1 HEAD 2>/dev/null | wc -l | tr -d ' ')"
echo "[Stop][session-wrap] 마지막 커밋 변경 파일: ${changed_count}개" >&2

# HANDOFF 업데이트 안내
handoff_file="$REPO_ROOT/docs/OPUS_FINAL_HANDOFF.md"
if [[ -f "$handoff_file" ]]; then
  last_update="$(head -3 "$handoff_file" | head -1 | sed 's/^/  /' || true)"
  echo "[Stop][session-wrap] HANDOFF: ${last_update:-알 수 없음}" >&2
fi
echo "[Stop][session-wrap] → 세션 마무리 필요: HANDOFF 업데이트 + git push" >&2
echo "[Stop][session-wrap] ═══════════════════════════════════" >&2

exit 0
