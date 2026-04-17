#!/bin/bash
# pickko-daily-summary.js 자동 실행 래퍼 (launchd)
# - 중복 실행 방지 (lock file)
# - MODE=ops로 pickko-daily-summary.js 실행
# - 로그 유지 (/tmp/pickko-daily-summary.log, 최신 500줄)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="/opt/homebrew/bin/tsx"
RUNTIME_SCRIPT="/Users/alexlee/projects/ai-agent-system/bots/reservation/auto/scheduled/pickko-daily-summary.ts"
LOCK_FILE="$HOME/.openclaw/workspace/pickko-daily-summary.lock"
LOG_FILE="/tmp/pickko-daily-summary.log"

# 중복 실행 방지
if [ -f "$LOCK_FILE" ]; then
  OLD_PID=$(cat "$LOCK_FILE" 2>/dev/null)
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "[$(date)] ⚠️ pickko-daily-summary already running (PID: $OLD_PID)" | tee -a "$LOG_FILE"
    exit 0
  fi
  rm -f "$LOCK_FILE"
fi

echo $$ > "$LOCK_FILE"
trap "rm -f '$LOCK_FILE'" EXIT

echo "[$(date)] ▶ pickko-daily-summary 시작" >> "$LOG_FILE"

MODE=ops TELEGRAM_ENABLED=1 "$NODE" "$RUNTIME_SCRIPT" >> "$LOG_FILE" 2>&1
EXIT_CODE=$?

echo "[$(date)] ⏹ pickko-daily-summary 완료 (exit: $EXIT_CODE)" >> "$LOG_FILE"

# 최신 500줄만 유지
if [ -f "$LOG_FILE" ]; then
  tail -500 "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"
fi

exit $EXIT_CODE
