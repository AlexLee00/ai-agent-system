#!/bin/bash
# ska-008/009: 레베카 실행 + 텔레그램 전송 래퍼
# launchd ai.ska.rebecca       (매일    08:00, MODE=daily)
# launchd ai.ska.rebecca-weekly (매주 월 08:05, MODE=weekly)
#
# 사용법: run-rebecca.sh [daily|weekly]

PYTHON=/Users/alexlee/projects/ai-agent-system/bots/ska/venv/bin/python
NODE=/opt/homebrew/bin/node
REBECCA=/Users/alexlee/projects/ai-agent-system/bots/ska/src/rebecca.py
PUBLISHER=/Users/alexlee/projects/ai-agent-system/packages/core/scripts/publish-python-report.js

MODE="${1:-daily}"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] REBECCA 시작 (mode=${MODE})"

# 임시 파일에 출력 저장
TMPFILE=$(mktemp /tmp/ska-rebecca-XXXX.txt)

"$PYTHON" "$REBECCA" --mode="$MODE" > "$TMPFILE" 2>&1
EXIT_CODE=$?

# 로그에도 출력
cat "$TMPFILE"

if [ $EXIT_CODE -eq 0 ]; then
    # reporting-hub 경유 발송
    "$NODE" "$PUBLISHER" \
      --fromBot=rebecca \
      --team=reservation \
      --topicTeam=ska \
      --eventType=report \
      --alertLevel=1 \
      --title="레베카 ${MODE} 리포트" \
      --action="$( [ "$MODE" = "weekly" ] && printf '상세 확인: /ska-health | /ska-forecast' || printf '상세 확인: /ska-health' )" \
      --links="$( [ "$MODE" = "weekly" ] && printf '스카 헬스::/ska-health|예측 헬스::/ska-forecast' || printf '스카 헬스::/ska-health' )" \
      --footer="$( [ "$MODE" = "weekly" ] && printf '상세 명령: /ska-health | /ska-forecast' || printf '상세 명령: /ska-health' )" \
      < "$TMPFILE"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] REBECCA 완료 (mode=${MODE})"
else
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] ⚠️ REBECCA 오류 (exit: $EXIT_CODE, mode=${MODE})"
fi

rm -f "$TMPFILE"
exit $EXIT_CODE
