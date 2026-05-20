#!/bin/zsh
# Stop Hook — 열린 Symphony 티켓 상태 최종 보고
# Always exit 0
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
echo "[Stop][ticket-status-final] ══════════════════════════" >&2
# Hub API로 in_progress 티켓 조회 (Hub가 실행 중일 때만)
HUB_TOKEN_FILE="$REPO_ROOT/bots/hub/secrets-store.json"
HUB_PORT=7788
# Hub 헬스 체크 (빠른 타임아웃)
hub_alive="$(curl -sf --max-time 2 "http://localhost:$HUB_PORT/health" > /dev/null 2>&1 && echo yes || echo no)"
if [[ "$hub_alive" == "yes" ]]; then
  # in_progress 티켓 조회
  response="$(curl -sf --max-time 3 \
    "http://localhost:$HUB_PORT/hub/tasks?state=in_progress&limit=5" \
    -H "Authorization: Bearer $(python3 -c "import json; d=json.load(open('$HUB_TOKEN_FILE')); print(d.get('HUB_AUTH_TOKEN',''))" 2>/dev/null || echo '')" \
    2>/dev/null || echo '')"
  if [[ -n "$response" ]]; then
    count="$(echo "$response" | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d.get('tasks', [])))" 2>/dev/null || echo 0)"
    if [[ "$count" -gt 0 ]]; then
      echo "[Stop][ticket-status-final] ⚠️  진행 중 티켓 ${count}개:" >&2
      echo "$response" | python3 -c "
import json,sys
d = json.load(sys.stdin)
for t in d.get('tasks', [])[:5]:
    print(f\"  #{t.get('id','?')} [{t.get('team','?')}] {t.get('title','?')[:60]}\", file=sys.stderr)
" 2>&1 >&2 || true
      echo "[Stop][ticket-status-final] → 티켓 상태 업데이트 후 세션 종료 권장" >&2
    else
      echo "[Stop][ticket-status-final] ✅ 진행 중 티켓 없음" >&2
    fi
  fi
else
  echo "[Stop][ticket-status-final] Hub 오프라인 — 티켓 조회 건너뜀" >&2
fi
echo "[Stop][ticket-status-final] ══════════════════════════" >&2
exit 0
