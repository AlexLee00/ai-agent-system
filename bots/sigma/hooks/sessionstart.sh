#!/bin/zsh
# Sigma SessionStart Hook — 메타 현황 브리핑
set -uo pipefail
HUB_URL="${HUB_URL:-http://localhost:7788}"
if command -v curl &>/dev/null; then
  brief="$(curl -sf --max-time 5 "$HUB_URL/api/sigma/daily-brief" 2>/dev/null || echo "")"
  if [[ -n "$brief" ]]; then
    echo "$brief" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    issues = d.get('consistency_issues', 0)
    proposals = d.get('pending_proposals', 0)
    last_audit = d.get('last_audit_at', 'N/A')
    print(f'[Sigma] 일관성 이슈: {issues}개 | 대기 제안: {proposals}개 | 마지막 감사: {last_audit}')
except Exception:
    pass
" 2>/dev/null || true
  fi
fi
exit 0
