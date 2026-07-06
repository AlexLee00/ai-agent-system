#!/bin/bash
# Daily Pickko full scan wrapper.
# - Runs the normal kiosk monitor with paid date fallback enabled.
# - Shares the regular kiosk-monitor lock to avoid concurrent Pickko/Naver work.
# - Intended for low-traffic early morning launchd schedule.

NODE="/opt/homebrew/bin/node"
TSX_IMPORT="/opt/homebrew/lib/node_modules/tsx/dist/loader.mjs"
RUNTIME_SCRIPT="/Users/alexlee/projects/ai-agent-system/bots/reservation/auto/monitors/pickko-kiosk-monitor.ts"
WORKSPACE_DIR="${AI_AGENT_WORKSPACE:-${JAY_WORKSPACE:-$HOME/.ai-agent-system/workspace}}"
mkdir -p "$WORKSPACE_DIR"
LOCK_FILE="$WORKSPACE_DIR/pickko-kiosk-monitor.lock"
LOG_DIR="/tmp"
LOG_DATE=$(date '+%Y-%m-%d')
LOG_FILE="$LOG_DIR/pickko-kiosk-full-scan-$LOG_DATE.log"
LOG_SYMLINK="$LOG_DIR/pickko-kiosk-full-scan.log"

if [ -f "$LOCK_FILE" ]; then
  OLD_PID=$(cat "$LOCK_FILE" 2>/dev/null)
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "[$(date)] ⚠️ pickko-kiosk full scan skipped: kiosk-monitor already running (PID: $OLD_PID)" | tee -a "$LOG_FILE"
    exit 0
  fi
  rm -f "$LOCK_FILE"
fi

echo $$ > "$LOCK_FILE"
trap "rm -f '$LOCK_FILE'" EXIT

ln -sf "$LOG_FILE" "$LOG_SYMLINK" 2>/dev/null

echo "[$(date)] ▶ pickko-kiosk full scan 시작" >> "$LOG_FILE"

MODE=ops \
TELEGRAM_ENABLED=1 \
PLAYWRIGHT_HEADLESS=true \
PICKKO_HEADLESS=1 \
KIOSK_PICKKO_PAID_DATE_FALLBACK_ENABLED=1 \
"$NODE" --disable-warning=DEP0205 --import "$TSX_IMPORT" "$RUNTIME_SCRIPT" >> "$LOG_FILE" 2>&1
EXIT_CODE=$?

echo "[$(date)] ⏹ pickko-kiosk full scan 완료 (exit: $EXIT_CODE)" >> "$LOG_FILE"

find "$LOG_DIR" -name "pickko-kiosk-full-scan-*.log" -mtime +14 -delete 2>/dev/null

exit $EXIT_CODE
