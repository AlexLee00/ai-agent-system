#!/bin/zsh
# Stop Hook — 세션 종료 시 session-wrap 요약 + HANDOFF 업데이트 안내
# Always exit 0

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

cd "$REPO_ROOT"

# git log 기반 세션 커밋 요약 (최근 10개)
echo "" >&2
echo "[Stop][session-wrap] ═══════════════════════════════════" >&2
echo "[Stop][session-wrap] 세션 커밋 요약 (최근 10개):" >&2
git log --oneline -10 2>/dev/null | sed 's/^/  /' >&2

# 변경 파일 요약
changed_count="$(git diff --name-only HEAD~1 HEAD 2>/dev/null | wc -l | tr -d ' ')"
echo "[Stop][session-wrap] 마지막 커밋 변경 파일: ${changed_count}개" >&2

# HANDOFF 업데이트 안내
handoff_file="$REPO_ROOT/docs/OPUS_FINAL_HANDOFF.md"
if [[ -f "$handoff_file" ]]; then
  last_update="$(head -5 "$handoff_file" | grep -i 'update\|업데이트\|date\|날짜' | head -1 | sed 's/^/  /' || true)"
  echo "[Stop][session-wrap] HANDOFF 최종: ${last_update:-알 수 없음}" >&2
fi
echo "[Stop][session-wrap] → 세션 마무리 필요: HANDOFF 업데이트 + git push" >&2
echo "[Stop][session-wrap] ═══════════════════════════════════" >&2

exit 0
