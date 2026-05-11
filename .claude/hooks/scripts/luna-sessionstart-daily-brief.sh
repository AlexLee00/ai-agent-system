#!/bin/zsh
# Luna SessionStart Hook — 세션 시작 시 일일 브리핑 출력
# 항상 exit 0

set -uo pipefail

echo "[Luna][SessionStart] 일일 브리핑 조회 중..." >&2

HUB_URL="${HUB_URL:-http://localhost:7788}"
if command -v curl &>/dev/null; then
  brief="$(curl -sf --max-time 5 "$HUB_URL/api/luna/daily-brief" 2>/dev/null || echo "")"
  if [[ -n "$brief" ]]; then
    echo "$brief" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    pnl = d.get(\'pnl_pct\', 0.0)
    positions = d.get(\'open_positions\', 0)
    regime = d.get(\'market_regime\', \'UNKNOWN\')
    trades = d.get(\'today_trades\', 0)
    print(f\'[Luna] 오늘 PnL: {pnl:+.2f}% | 오픈 포지션: {positions}개 | 시장 체제: {regime} | 오늘 거래: {trades}건\')
except Exception:
    pass
" 2>/dev/null || true
  fi
fi

exit 0
