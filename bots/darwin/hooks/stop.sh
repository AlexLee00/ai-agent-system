#!/bin/zsh
# Darwin Stop Hook — 세션 종료 기록
set -uo pipefail
HUB_URL="${HUB_URL:-http://localhost:7788}"
if command -v curl &>/dev/null; then
  curl -sf --max-time 5 -X POST "$HUB_URL/api/darwin/session-end" \
    -H "Content-Type: application/json" \
    -d '{"source":"claude_code","event":"session_stop"}' 2>/dev/null || true
fi
echo "[Darwin][Stop] 세션 종료 기록 완료" >&2
exit 0
