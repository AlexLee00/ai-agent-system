#!/bin/bash
# pickko-kiosk-monitor.js --audit-today 자동 실행 래퍼 (launchd)
# - 중복 실행 방지 (lock file)
# - 매일 08:30 KST 실행 (launchd: ai.ska.today-audit)
# - 픽코 예약 vs 네이버 예약불가 상태 비교 → 누락 차단 / 초과 해제

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="/Users/alexlee/.nvm/versions/node/v24.13.1/bin/node"
LOCK_FILE="$HOME/.openclaw/workspace/today-audit.lock"
LOG_FILE="/tmp/today-audit.log"

# 중복 실행 방지
if [ -f "$LOCK_FILE" ]; then
  OLD_PID=$(cat "$LOCK_FILE" 2>/dev/null)
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "[$(date)] ⚠️ today-audit already running (PID: $OLD_PID)" | tee -a "$LOG_FILE"
    exit 0
  fi
  rm -f "$LOCK_FILE"
fi

echo $$ > "$LOCK_FILE"
trap "rm -f '$LOCK_FILE'" EXIT

echo "[$(date)] ▶ today-audit 시작" >> "$LOG_FILE"

MODE=ops TELEGRAM_ENABLED=1 "$NODE" "$SCRIPT_DIR/pickko-kiosk-monitor.js" --audit-today >> "$LOG_FILE" 2>&1
EXIT_CODE=$?

echo "[$(date)] ⏹ today-audit 완료 (exit: $EXIT_CODE)" >> "$LOG_FILE"

# 최신 500줄만 유지
if [ -f "$LOG_FILE" ]; then
  tail -500 "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"
fi

exit $EXIT_CODE
