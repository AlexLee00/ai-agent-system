#!/bin/zsh
# Blog SessionStart Hook — 블로그 운영 현황 브리핑
set -uo pipefail
HUB_URL="${HUB_URL:-http://localhost:7788}"
if command -v curl &>/dev/null; then
  brief="$(curl -sf --max-time 5 "$HUB_URL/api/blog/daily-brief" 2>/dev/null || echo "")"
  if [[ -n "$brief" ]]; then
    echo "$brief" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    queued = d.get('queued_posts', 0)
    published_today = d.get('published_today', 0)
    avg_views = d.get('avg_views_7d', 0)
    trend_keyword = d.get('top_trend_keyword', 'N/A')
    print(f'[Blog] 오늘 발행: {published_today}건 | 예약 대기: {queued}건 | 7일 평균조회: {avg_views} | 핫키워드: {trend_keyword}')
except Exception:
    pass
" 2>/dev/null || true
  fi
fi
exit 0
