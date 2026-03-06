#!/bin/bash
# ska-006: 포캐스트 실행 + 텔레그램 전송 래퍼
# 인자: daily | weekly | monthly (기본: daily)
# launchd ai.ska.forecast-daily  (매일 18:00)
# launchd ai.ska.forecast-weekly (매주 금요일 18:00)

PYTHON=/Users/alexlee/projects/ai-agent-system/bots/ska/venv/bin/python
FORECAST=/Users/alexlee/projects/ai-agent-system/bots/ska/src/forecast.py
SENDER=/Users/alexlee/projects/ai-agent-system/bots/ska/scripts/send-telegram.py

MODE="${1:-daily}"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] FORECAST (${MODE}) 시작"

TMPFILE=$(mktemp /tmp/ska-forecast-XXXXXX)

"$PYTHON" "$FORECAST" "--mode=${MODE}" > "$TMPFILE" 2>&1
EXIT_CODE=$?

cat "$TMPFILE"

if [ $EXIT_CODE -eq 0 ]; then
    "$PYTHON" "$SENDER" < "$TMPFILE"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] FORECAST (${MODE}) 완료"
else
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] ⚠️ FORECAST (${MODE}) 오류 (exit: $EXIT_CODE)"
fi

rm -f "$TMPFILE"
exit $EXIT_CODE
