#!/bin/zsh
# Darwin SessionStart Hook — R&D 현황 브리핑
set -uo pipefail
HUB_URL="${HUB_URL:-http://localhost:7788}"
if command -v curl &>/dev/null; then
  brief="$(curl -sf --max-time 5 "$HUB_URL/api/darwin/daily-brief" 2>/dev/null || echo "")"
  if [[ -n "$brief" ]]; then
    echo "$brief" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    active = d.get('active_experiments', 0)
    hypotheses = d.get('pending_hypotheses', 0)
    last_cycle = d.get('last_cycle_at', 'N/A')
    phase = d.get('current_phase', 'UNKNOWN')
    print(f'[Darwin] 활성 실험: {active}개 | 대기 가설: {hypotheses}개 | 마지막 사이클: {last_cycle} | 페이즈: {phase}')
except Exception:
    pass
" 2>/dev/null || true
  fi
fi
exit 0
