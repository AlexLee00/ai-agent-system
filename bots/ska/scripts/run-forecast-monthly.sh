#!/bin/bash
# ska-011/013: 월간 포캐스트 + 모델 진단 래퍼
# launchd ai.ska.forecast-monthly (매월 28일 18:00)
#
# 실행 순서:
#   1. forecast --mode=monthly  (다음 30일 예측 텔레그램 전송)
#   2. forecast --mode=review   (LLM 모델 진단 텔레그램 전송)

PYTHON=/Users/alexlee/projects/ai-agent-system/bots/ska/venv/bin/python
NODE=/usr/bin/env node
FORECAST=/Users/alexlee/projects/ai-agent-system/bots/ska/src/forecast.py
PUBLISHER=/Users/alexlee/projects/ai-agent-system/packages/core/scripts/publish-python-report.js

echo "[$(date '+%Y-%m-%d %H:%M:%S')] FORECAST MONTHLY 시작"

# ── 1단계: 다음 달 30일 예측 ──────────────────────────────────────────────────
TMPFILE=$(mktemp /tmp/ska-forecast-monthly-XXXX.txt)
"$PYTHON" "$FORECAST" "--mode=monthly" > "$TMPFILE" 2>&1
EXIT1=$?
cat "$TMPFILE"
if [ $EXIT1 -eq 0 ]; then
    "$NODE" "$PUBLISHER" \
      --fromBot=forecast \
      --team=reservation \
      --topicTeam=ska \
      --eventType=report \
      --alertLevel=1 \
      --title="스카 예측 monthly 리포트" \
      --action="상세 확인: /ska-forecast | /ska-review" \
      --links="예측 헬스::/ska-forecast|튜닝 검토::/ska-review" \
      --footer="상세 명령: /ska-forecast | /ska-review" \
      < "$TMPFILE"
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
    "$NODE" "$PUBLISHER" \
      --fromBot=forecast-review \
      --team=reservation \
      --topicTeam=ska \
      --eventType=report \
      --alertLevel=2 \
      --title="스카 예측 리뷰 리포트" \
      --action="상세 확인: /ska-review | /ska-forecast" \
      --links="튜닝 검토::/ska-review|예측 헬스::/ska-forecast" \
      --footer="상세 명령: /ska-review | /ska-forecast" \
      < "$TMPFILE2"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] FORECAST REVIEW 완료"
else
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] ⚠️ FORECAST REVIEW 오류 (exit: $EXIT2)"
fi
rm -f "$TMPFILE2"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] FORECAST MONTHLY 전체 완료"
exit 0
