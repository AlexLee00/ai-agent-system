#!/bin/bash
# pickko-pay-scan 자동 실행 래퍼

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="/opt/homebrew/bin/node"
RUNTIME_SCRIPT="/Users/alexlee/projects/ai-agent-system/dist/ts-runtime/bots/reservation/auto/scheduled/pickko-pay-scan.js"
LOCK_FILE="$HOME/.openclaw/workspace/pickko-pay-scan.lock"
LOG_FILE="/tmp/pickko-pay-scan.log"

TS() { date '+%Y-%m-%d %H:%M:%S'; }

if [ -f "$LOCK_FILE" ]; then
  OLD_PID=$(cat "$LOCK_FILE" 2>/dev/null)
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "[$(TS)] ⚠️ pickko-pay-scan 이미 실행 중 (PID: $OLD_PID) → 건너뜀" | tee -a "$LOG_FILE"
    exit 0
  fi
  rm -f "$LOCK_FILE"
fi

echo $$ > "$LOCK_FILE"
trap "rm -f '$LOCK_FILE'" EXIT

echo "" >> "$LOG_FILE"
echo "[$(TS)] ━━━ pickko-pay-scan 시작 ━━━" | tee -a "$LOG_FILE"
MODE=ops "$NODE" "$RUNTIME_SCRIPT" >> "$LOG_FILE" 2>&1
EXIT_CODE=$?
echo "[$(TS)] ━━━ pickko-pay-scan 완료 (exit: $EXIT_CODE) ━━━" | tee -a "$LOG_FILE"

if [ -f "$LOG_FILE" ]; then
  tail -500 "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"
fi

exit $EXIT_CODE
