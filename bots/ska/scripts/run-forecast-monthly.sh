#!/bin/bash
# ska-011/013: 월간 포캐스트 + 모델 진단 래퍼
# launchd ai.ska.forecast-monthly (매월 28일 18:00)
#
# 실행 순서:
#   1. forecast --mode=monthly  (다음 30일 예측 텔레그램 전송)
#   2. forecast --mode=review   (LLM 모델 진단 텔레그램 전송)

PYTHON=/Users/alexlee/projects/ai-agent-system/bots/ska/venv/bin/python
FORECAST=/Users/alexlee/projects/ai-agent-system/bots/ska/src/forecast.py
SENDER=/Users/alexlee/projects/ai-agent-system/bots/ska/scripts/send-telegram.py

echo "[$(date '+%Y-%m-%d %H:%M:%S')] FORECAST MONTHLY 시작"

# ── 1단계: 다음 달 30일 예측 ──────────────────────────────────────────────────
TMPFILE=$(mktemp /tmp/ska-forecast-monthly-XXXX.txt)
"$PYTHON" "$FORECAST" "--mode=monthly" > "$TMPFILE" 2>&1
EXIT1=$?
cat "$TMPFILE"
if [ $EXIT1 -eq 0 ]; then
    "$PYTHON" "$SENDER" < "$TMPFILE"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] FORECAST MONTHLY 예측 완료"
else
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] ⚠️ FORECAST MONTHLY 예측 오류 (exit: $EXIT1)"
fi
rm -f "$TMPFILE"

# ── 2단계: 모델 진단 (LLM) ────────────────────────────────────────────────────
echo "[$(date '+%Y-%m-%d %H:%M:%S')] FORECAST REVIEW 시작"
TMPFILE2=$(mktemp /tmp/ska-forecast-review-XXXX.txt)
"$PYTHON" "$FORECAST" "--mode=review" > "$TMPFILE2" 2>&1
EXIT2=$?
cat "$TMPFILE2"
if [ $EXIT2 -eq 0 ]; then
    "$PYTHON" "$SENDER" < "$TMPFILE2"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] FORECAST REVIEW 완료"
else
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] ⚠️ FORECAST REVIEW 오류 (exit: $EXIT2)"
fi
rm -f "$TMPFILE2"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] FORECAST MONTHLY 전체 완료"
exit 0
