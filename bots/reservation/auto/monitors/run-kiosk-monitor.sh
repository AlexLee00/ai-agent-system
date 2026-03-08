#!/bin/bash
# pickko-kiosk-monitor.js 자동 실행 래퍼 (launchd)
# - 중복 실행 방지 (lock file)
# - MODE=ops로 pickko-kiosk-monitor.js 실행
# - 로그 유지 (날짜별 아카이브, 7일 보존)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="/Users/alexlee/.nvm/versions/node/v24.13.1/bin/node"
LOCK_FILE="$HOME/.openclaw/workspace/pickko-kiosk-monitor.lock"
LOG_DIR="/tmp"
LOG_DATE=$(date '+%Y-%m-%d')
LOG_FILE="$LOG_DIR/pickko-kiosk-monitor-$LOG_DATE.log"
LOG_SYMLINK="$LOG_DIR/pickko-kiosk-monitor.log"

# 중복 실행 방지
if [ -f "$LOCK_FILE" ]; then
  OLD_PID=$(cat "$LOCK_FILE" 2>/dev/null)
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "[$(date)] ⚠️ pickko-kiosk-monitor already running (PID: $OLD_PID)" | tee -a "$LOG_FILE"
    exit 0
  fi
  rm -f "$LOCK_FILE"
fi

echo $$ > "$LOCK_FILE"
trap "rm -f '$LOCK_FILE'" EXIT

# 오늘 날짜 로그 파일로 심볼릭 링크 갱신
ln -sf "$LOG_FILE" "$LOG_SYMLINK" 2>/dev/null

echo "[$(date)] ▶ pickko-kiosk-monitor 시작" >> "$LOG_FILE"

MODE=ops TELEGRAM_ENABLED=1 "$NODE" "$SCRIPT_DIR/pickko-kiosk-monitor.js" >> "$LOG_FILE" 2>&1
EXIT_CODE=$?

echo "[$(date)] ⏹ pickko-kiosk-monitor 완료 (exit: $EXIT_CODE)" >> "$LOG_FILE"

# 7일 이상 된 로그 삭제
find "$LOG_DIR" -name "pickko-kiosk-monitor-*.log" -mtime +7 -delete 2>/dev/null

exit $EXIT_CODE
