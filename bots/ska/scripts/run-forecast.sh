#!/bin/bash
# ska-006: 포캐스트 실행 + 텔레그램 전송 래퍼
# 인자: daily | weekly | monthly (기본: daily)
# launchd ai.ska.forecast-daily  (매일 18:00)
# launchd ai.ska.forecast-weekly (매주 금요일 18:00)

PYTHON=/Users/alexlee/projects/ai-agent-system/bots/ska/venv/bin/python
NODE=/usr/bin/env node
FORECAST=/Users/alexlee/projects/ai-agent-system/bots/ska/src/forecast.py
PUBLISHER=/Users/alexlee/projects/ai-agent-system/packages/core/scripts/publish-python-report.js

MODE="${1:-daily}"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] FORECAST (${MODE}) 시작"

TMPFILE=$(mktemp /tmp/ska-forecast-XXXXXX)

"$PYTHON" "$FORECAST" "--mode=${MODE}" > "$TMPFILE" 2>&1
EXIT_CODE=$?

cat "$TMPFILE"

if [ $EXIT_CODE -eq 0 ]; then
    "$NODE" "$PUBLISHER" \
      --fromBot=forecast \
      --team=reservation \
      --topicTeam=ska \
      --eventType=report \
      --alertLevel=1 \
      --title="스카 예측 ${MODE} 리포트" \
      --action="상세 확인: /ska-forecast | /ska-review" \
      --links="예측 헬스::/ska-forecast|튜닝 검토::/ska-review" \
      --footer="상세 명령: /ska-forecast | /ska-review" \
      < "$TMPFILE"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] FORECAST (${MODE}) 완료"
else
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] ⚠️ FORECAST (${MODE}) 오류 (exit: $EXIT_CODE)"
fi

rm -f "$TMPFILE"
exit $EXIT_CODE
