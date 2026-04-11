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

publish_weekly_fallback() {
    local report_file="$1"
    local body_file
    body_file=$(mktemp /tmp/ska-rebecca-hook.XXXXXX.json)
    local hook_token
    hook_token=$("$PYTHON" - "$report_file" "$body_file" <<'PY'
import json
import sys
from pathlib import Path

report_path = Path(sys.argv[1])
body_path = Path(sys.argv[2])
store_path = Path('/Users/alexlee/projects/ai-agent-system/bots/hub/secrets-store.json')

store = json.loads(store_path.read_text())
group_id = store['telegram']['group_id']
topic_id = store['telegram']['topic_ids']['ska']
message = report_path.read_text()

payload = {
    "message": f"[rebecca→reservation] {message}",
    "name": "rebecca",
    "agentId": "main",
    "deliver": True,
    "channel": "telegram",
    "to": f"{group_id}:topic:{topic_id}",
    "wakeMode": "now",
    "timeoutSeconds": 30,
}

body_path.write_text(json.dumps(payload, ensure_ascii=False))
print(store['openclaw']['hooks_token'])
PY
)

    curl -sS -X POST http://127.0.0.1:18789/hooks/agent \
      -H 'Content-Type: application/json' \
      -H "Authorization: Bearer ${hook_token}" \
      --data @"$body_file"
    local curl_exit=$?
    rm -f "$body_file"
    return $curl_exit
}

echo "[$(date '+%Y-%m-%d %H:%M:%S')] REBECCA 시작 (mode=${MODE})"

# macOS mktemp는 최소 3개의 X가 파일명 끝자리에 있어야 한다.
TMPFILE=$(mktemp /tmp/ska-rebecca.XXXXXX)

"$PYTHON" "$REBECCA" --mode="$MODE" > "$TMPFILE" 2>&1
EXIT_CODE=$?

# 로그에도 출력
cat "$TMPFILE"

if [ $EXIT_CODE -eq 0 ]; then
    # reporting-hub 경유 발송
    MODE=ops PROJECT_ROOT=/Users/alexlee/projects/ai-agent-system "$NODE" "$PUBLISHER" \
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
    PUBLISH_EXIT=$?
    if [ $PUBLISH_EXIT -ne 0 ]; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] ⚠️ REBECCA publisher 실패 → hook curl 폴백"
        publish_weekly_fallback "$TMPFILE" || echo "[$(date '+%Y-%m-%d %H:%M:%S')] ⚠️ REBECCA hook curl 폴백 실패"
    fi
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] REBECCA 완료 (mode=${MODE})"
else
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] ⚠️ REBECCA 오류 (exit: $EXIT_CODE, mode=${MODE})"
fi

rm -f "$TMPFILE"
exit $EXIT_CODE
